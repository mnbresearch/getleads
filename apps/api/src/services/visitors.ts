import { and, eq, getDb, pixels, sql, visitorCompanies, visits, enqueue } from "@prospex/db";
import { cleanOrgName, identifyIp, pageIntentWeight, resolveCompanyDomain } from "@prospex/core";
import { sha256 } from "../lib/crypto.js";
import { env } from "../env.js";
import { canonicalEmail, companyDomainOrNull, upsertCompany } from "./leads.js";
import { emitEvent } from "../lib/events.js";
import { stripControl, stripNul } from "../lib/sanitize.js";

/** A pixel key as issued: `px_` + base64url. Nothing else is ever looked up or echoed. */
const PIXEL_KEY_RE = /^px_[A-Za-z0-9_-]{6,64}$/;
export const isPixelKey = (key: unknown): key is string => typeof key === "string" && PIXEL_KEY_RE.test(key);

/** The most the public beacon may store per field. Longer values are cut at the route. */
export const PIXEL_LIMITS = { sessionId: 200, page: 2000, referrer: 2000, userAgent: 300, identifyEmail: 254, identifyCompany: 200, durationMs: 86_400_000, pagesPerCompany: 200 } as const;

/**
 * New visitor companies per workspace per hour that an identify() call may create.
 *
 * identify() is a statement by whoever loaded the page, and the pixel key is public. Each
 * new company it named created a company row, a visitor row, a webhook event and a crawl +
 * news-search job - unmetered, for anyone who could send a POST. Beyond this many in an
 * hour a claimed company is recorded on the visit only. Companies placed by the IP lookup
 * are not capped (an address cannot be made up per request), but past the cap they are
 * rolled up without queueing enrichment.
 */
export const NEW_VISITOR_COMPANIES_PER_HOUR = 50;

/** A JSON string literal that is also safe inside a <script> element. */
const jsString = (v: string) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

/** The JS snippet customers embed. Tiny, no cookies beyond a session id in sessionStorage. */
export function pixelScript(key: string) {
  // The key is validated AND encoded: a caller that forgets the first still cannot inject.
  if (!isPixelKey(key)) return "/* unknown pixel */";
  const endpoint = jsString(`${env.apiUrl}/px/${key}/collect`);
  return `(function(){try{var u=${endpoint};var s=sessionStorage.getItem("__gl_sid");if(!s){s=Math.random().toString(36).slice(2)+Date.now().toString(36);sessionStorage.setItem("__gl_sid",s)}var t0=Date.now();function send(extra){var d={sid:s,p:location.pathname+location.search,r:document.referrer,t:document.title,d:Date.now()-t0};for(var k in extra)d[k]=extra[k];var b=JSON.stringify(d);if(navigator.sendBeacon){navigator.sendBeacon(u,new Blob([b],{type:"application/json"}))}else{fetch(u,{method:"POST",body:b,keepalive:true,headers:{"content-type":"application/json"}})}}send({e:"view"});var last=location.pathname;setInterval(function(){if(location.pathname!==last){last=location.pathname;t0=Date.now();send({e:"view"})}},800);addEventListener("pagehide",function(){send({e:"leave"})});window.prospex={identify:function(o){send({e:"identify",id:o})}}}catch(e){}})();`;
}

/**
 * What is kept of an identify() payload: an email and a company name, both bounded.
 * Everything else the page sent is dropped before it reaches a job payload.
 */
export function cleanIdentify(raw: unknown): { email?: string; company?: string } | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: { email?: string; company?: string } = {};
  if (typeof r.email === "string" && r.email.length <= PIXEL_LIMITS.identifyEmail * 2) {
    const e = canonicalEmail(r.email);
    if (e) out.email = e;
  }
  if (typeof r.company === "string") {
    const name = stripControl(stripNul(r.company)).replace(/\s+/g, " ").trim().slice(0, PIXEL_LIMITS.identifyCompany);
    if (name) out.company = name;
  }
  return out.email || out.company ? out : undefined;
}

export interface CollectInput {
  pixelKey: string;
  ip: string;
  sessionId: string;
  page?: string;
  referrer?: string;
  userAgent?: string;
  durationMs?: number;
  event?: string;
  identify?: Record<string, unknown>;
}

/** Fast path: store the hit; identification runs in a job so the beacon returns instantly. */
export async function collectHit(raw: CollectInput) {
  const { db } = getDb();
  if (!isPixelKey(raw.pixelKey)) return false;
  // Bounded again here: this is the function that writes, whoever calls it.
  const input: CollectInput = {
    ...raw,
    sessionId: stripNul(String(raw.sessionId ?? "")).slice(0, PIXEL_LIMITS.sessionId) || "unknown",
    page: raw.page === undefined ? undefined : stripNul(String(raw.page)).slice(0, PIXEL_LIMITS.page),
    referrer: raw.referrer === undefined ? undefined : stripNul(String(raw.referrer)).slice(0, PIXEL_LIMITS.referrer),
    userAgent: raw.userAgent === undefined ? undefined : stripNul(String(raw.userAgent)).slice(0, PIXEL_LIMITS.userAgent),
    durationMs: Number.isFinite(raw.durationMs) ? Math.min(Math.max(0, Math.round(raw.durationMs as number)), PIXEL_LIMITS.durationMs) : 0,
    identify: cleanIdentify(raw.identify),
  };
  const pixel = await db.query.pixels.findFirst({ where: and(eq(pixels.key, input.pixelKey), eq(pixels.active, true)) });
  if (!pixel) return false;
  const ipHash = sha256(`${input.ip}:${pixel.id}`);
  if (input.event === "leave") {
    // update duration of the latest visit in this session
    await db.execute(sql`UPDATE visits SET duration_ms = GREATEST(duration_ms, ${input.durationMs ?? 0}) WHERE id = (SELECT id FROM visits WHERE pixel_id = ${pixel.id} AND session_id = ${input.sessionId} ORDER BY visited_at DESC LIMIT 1)`);
    return true;
  }
  if (input.event === "identify") {
    // identify() is a statement about a visit already recorded, not a page view. Inserting
    // a row for it counted every login as an extra visit to whatever page called it.
    const [latest] = await db
      .select({ id: visits.id })
      .from(visits)
      .where(and(eq(visits.pixelId, pixel.id), eq(visits.sessionId, input.sessionId)))
      .orderBy(sql`${visits.visitedAt} DESC`)
      .limit(1);
    if (latest) {
      await enqueue(db, "visit.identify", { visitId: latest.id, ip: input.ip, identify: input.identify ?? null }, { orgId: pixel.orgId, priority: 4, maxAttempts: 2 });
      return true;
    }
    // No view recorded for this session (beacon lost, or identify fired first): fall
    // through and record one, so the identification has a visit to attach to.
  }
  const [row] = await db
    .insert(visits)
    .values({ orgId: pixel.orgId, pixelId: pixel.id, sessionId: input.sessionId, ipHash, page: input.page?.slice(0, 500), referrer: input.referrer?.slice(0, 500), userAgent: input.userAgent?.slice(0, 300), durationMs: input.durationMs ?? 0 })
    .returning();
  await enqueue(db, "visit.identify", { visitId: row.id, ip: input.ip, identify: input.identify ?? null }, { orgId: pixel.orgId, priority: 4, maxAttempts: 2 });
  return true;
}

/** Job: resolve IP → company, roll up into visitor_companies. */
export async function identifyVisit(visitId: string, ip: string, identify?: Record<string, unknown> | null) {
  const { db } = getDb();
  const v = await db.query.visits.findFirst({ where: eq(visits.id, visitId) });
  if (!v) return { skipped: true };
  let domain: string | null = null;
  let name: string | undefined;
  /** True when the company was named by the page (identify), not placed by the IP lookup. */
  let claimed = false;
  // Explicit identify() call from the customer's site (e.g. after login) wins - but it is
  // a claim made over a public endpoint, so it is held to the same rules as any other
  // input: the email must be one real address, and its domain must be a public company
  // domain. `a@169.254.169.254`, `a@internal.service.local` and `a@localhost:5432/x` each
  // used to create a company row with that "domain" and queue a crawl of it.
  const ident = cleanIdentify(identify);
  if (ident?.email) {
    const d = companyDomainOrNull(ident.email.slice(ident.email.lastIndexOf("@") + 1));
    if (d && !/gmail|yahoo|hotmail|outlook|icloud|proton|rediff/.test(d)) {
      domain = d;
      claimed = true;
      name = ident.company;
    }
  }
  const id = await identifyIp(ip, { ipinfoToken: process.env.IPINFO_TOKEN });
  if (!domain && !id.resolved) {
    // No lookup answered, so we know nothing about this visitor. Writing `isIsp: false,
    // companyDomain: null` would file it as "a person we could not place" - the same row a
    // genuine residential visit produces - and it would stay that way forever.
    //
    // Throwing rather than returning, because `visit.identify` is enqueued exactly once
    // from collectHit and nothing re-enqueues it: RETURNING completes the job, so "a later
    // run can try again" would have been false. Throwing lets the job's own retry do it.
    throw new Error("no IP lookup answered for this visit - not checked, rather than unidentifiable");
  }
  if (!domain) {
    if (id.isIsp || id.isHosting) {
      await db.update(visits).set({ isIsp: true, orgName: id.orgName, country: id.country, city: id.city }).where(eq(visits.id, visitId));
      return { isp: true };
    }
    name = cleanOrgName(id.orgName);
    const placed = id.domainHint ?? (name ? await resolveCompanyDomain(name).catch(() => null) : null);
    // A lookup's answer becomes a company row and a crawl target too.
    domain = placed ? companyDomainOrNull(placed) : null;
  }
  await db.update(visits).set({ companyDomain: domain, companyName: name, orgName: id.orgName, country: id.country, city: id.city, isIsp: false }).where(eq(visits.id, visitId));
  if (!domain) return { unidentified: true, org: id.orgName };
  // This visit was already rolled up under this company (an identify() for a visit the IP
  // lookup had already placed). Counting it again inflated visits and intent.
  if (v.companyDomain === domain) return { domain, name, alreadyCounted: true };
  const weight = pageIntentWeight(v.page ?? "/");
  const existing = await db.query.visitorCompanies.findFirst({ where: and(eq(visitorCompanies.orgId, v.orgId), eq(visitorCompanies.domain, domain)) });
  const pageKey = (v.page ?? "/").split("?")[0].slice(0, 120);
  if (existing) {
    // The page map is bounded: every distinct path used to add a key, forever.
    const key = pageKey in existing.pages || Object.keys(existing.pages).length < PIXEL_LIMITS.pagesPerCompany ? pageKey : "(other)";
    const pages = { ...existing.pages, [key]: (existing.pages[key] ?? 0) + 1 };
    const [{ n }] = await db.select({ n: sql<number>`count(distinct session_id)::int` }).from(visits).where(and(eq(visits.orgId, v.orgId), eq(visits.companyDomain, domain)));
    await db.update(visitorCompanies).set({ lastSeenAt: new Date(), visits: existing.visits + 1, sessions: n, pages, intentScore: Math.min(100, existing.intentScore + weight * 5), name: existing.name ?? name }).where(eq(visitorCompanies.id, existing.id));
    if (existing.status === "ignored") return { domain, ignored: true };
  } else {
    const [{ n: recentNew }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(visitorCompanies)
      .where(and(eq(visitorCompanies.orgId, v.orgId), sql`${visitorCompanies.firstSeenAt} > now() - interval '1 hour'`));
    const overCap = recentNew >= NEW_VISITOR_COMPANIES_PER_HOUR;
    // Past the cap, a company that was only CLAIMED stays on the visit row (already written
    // above) and goes no further: no company, no visitor row, no event, no crawl.
    if (overCap && claimed) return { domain, name, rateLimited: true };
    // A name from identify() is a stranger's text: it labels the visitor row, but it never
    // names (or renames) the company itself - the crawl of the company's own site does that.
    // A name from the IP lookup fills an empty company name and nothing more.
    const company = await upsertCompany(v.orgId, domain, claimed ? {} : { name }).catch(() => null);
    // When the workspace already knows this company, its own name for it is the label - not
    // whatever the page claimed.
    const label = claimed ? company?.name ?? name : name;
    await db.insert(visitorCompanies).values({ orgId: v.orgId, domain, name: label, companyId: company?.id, visits: 1, sessions: 1, pages: { [pageKey]: 1 }, intentScore: Math.min(100, weight * 5) }).onConflictDoNothing();
    await emitEvent(v.orgId, "visitor.identified", { domain, name: label, page: v.page, country: id.country }, { type: "company", id: company?.id ?? domain });
    // enrich the company in the background so the visitors page shows description/industry
    if (company && !overCap) await enqueue(db, "company.enrich", { companyId: company.id }, { orgId: v.orgId, priority: 1 });
    if (overCap) return { domain, name, enrichmentSkipped: true };
  }
  return { domain, name };
}
