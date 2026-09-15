import { and, eq, getDb, pixels, sql, visitorCompanies, visits, enqueue } from "@getleads/db";
import { cleanOrgName, identifyIp, pageIntentWeight, resolveCompanyDomain } from "@getleads/core";
import { sha256 } from "../lib/crypto.js";
import { env } from "../env.js";
import { upsertCompany } from "./leads.js";
import { emitEvent } from "../lib/events.js";

/** The JS snippet customers embed. Tiny, no cookies beyond a session id in sessionStorage. */
export function pixelScript(key: string) {
  const endpoint = `${env.apiUrl}/px/${key}/collect`;
  return `(function(){try{var s=sessionStorage.getItem("__gl_sid");if(!s){s=Math.random().toString(36).slice(2)+Date.now().toString(36);sessionStorage.setItem("__gl_sid",s)}var t0=Date.now();function send(extra){var d={sid:s,p:location.pathname+location.search,r:document.referrer,t:document.title,d:Date.now()-t0};for(var k in extra)d[k]=extra[k];var b=JSON.stringify(d);if(navigator.sendBeacon){navigator.sendBeacon("${endpoint}",new Blob([b],{type:"application/json"}))}else{fetch("${endpoint}",{method:"POST",body:b,keepalive:true,headers:{"content-type":"application/json"}})}}send({e:"view"});var last=location.pathname;setInterval(function(){if(location.pathname!==last){last=location.pathname;t0=Date.now();send({e:"view"})}},800);addEventListener("pagehide",function(){send({e:"leave"})});window.getleads={identify:function(o){send({e:"identify",id:o})}}}catch(e){}})();`;
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
export async function collectHit(input: CollectInput) {
  const { db } = getDb();
  const pixel = await db.query.pixels.findFirst({ where: and(eq(pixels.key, input.pixelKey), eq(pixels.active, true)) });
  if (!pixel) return false;
  const ipHash = sha256(`${input.ip}:${pixel.id}`);
  if (input.event === "leave") {
    // update duration of the latest visit in this session
    await db.execute(sql`UPDATE visits SET duration_ms = GREATEST(duration_ms, ${input.durationMs ?? 0}) WHERE id = (SELECT id FROM visits WHERE pixel_id = ${pixel.id} AND session_id = ${input.sessionId} ORDER BY visited_at DESC LIMIT 1)`);
    return true;
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
  // Explicit identify() call from the customer's site (e.g. after login) wins
  const idEmail = typeof identify?.email === "string" ? identify.email : undefined;
  if (idEmail && idEmail.includes("@")) {
    const d = idEmail.split("@")[1].toLowerCase();
    if (!/gmail|yahoo|hotmail|outlook|icloud|proton|rediff/.test(d)) domain = d;
    name = typeof identify?.company === "string" ? identify.company : undefined;
  }
  const id = await identifyIp(ip, { ipinfoToken: process.env.IPINFO_TOKEN });
  if (!domain) {
    if (id.isIsp || id.isHosting) {
      await db.update(visits).set({ isIsp: true, orgName: id.orgName, country: id.country, city: id.city }).where(eq(visits.id, visitId));
      return { isp: true };
    }
    name = cleanOrgName(id.orgName);
    domain = id.domainHint ?? (name ? await resolveCompanyDomain(name).catch(() => null) : null);
  }
  await db.update(visits).set({ companyDomain: domain, companyName: name, orgName: id.orgName, country: id.country, city: id.city, isIsp: false }).where(eq(visits.id, visitId));
  if (!domain) return { unidentified: true, org: id.orgName };
  const weight = pageIntentWeight(v.page ?? "/");
  const existing = await db.query.visitorCompanies.findFirst({ where: and(eq(visitorCompanies.orgId, v.orgId), eq(visitorCompanies.domain, domain)) });
  const pageKey = (v.page ?? "/").split("?")[0].slice(0, 120);
  if (existing) {
    const pages = { ...existing.pages, [pageKey]: (existing.pages[pageKey] ?? 0) + 1 };
    const [{ n }] = await db.select({ n: sql<number>`count(distinct session_id)::int` }).from(visits).where(and(eq(visits.orgId, v.orgId), eq(visits.companyDomain, domain)));
    await db.update(visitorCompanies).set({ lastSeenAt: new Date(), visits: existing.visits + 1, sessions: n, pages, intentScore: Math.min(100, existing.intentScore + weight * 5), name: existing.name ?? name }).where(eq(visitorCompanies.id, existing.id));
    if (existing.status === "ignored") return { domain, ignored: true };
  } else {
    const company = await upsertCompany(v.orgId, domain, { name }).catch(() => null);
    await db.insert(visitorCompanies).values({ orgId: v.orgId, domain, name, companyId: company?.id, visits: 1, sessions: 1, pages: { [pageKey]: 1 }, intentScore: Math.min(100, weight * 5) }).onConflictDoNothing();
    await emitEvent(v.orgId, "visitor.identified", { domain, name, page: v.page, country: id.country }, { type: "company", id: company?.id ?? domain });
    // enrich the company in the background so the visitors page shows description/industry
    if (company) await enqueue(db, "company.enrich", { companyId: company.id }, { orgId: v.orgId, priority: 1 });
  }
  return { domain, name };
}
