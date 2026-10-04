import { Hono } from "hono";
import { zValidator } from "../lib/validate.js";
import { z } from "zod";
import { and, companies, consume, desc, eq, getDb, pixels, sql, visitorCompanies, visits } from "@prospex/db";
import { findPeople } from "@prospex/core";
import { env } from "../env.js";
import { randomToken } from "../lib/crypto.js";
import { notFound } from "../lib/errors.js";
import { clientIp, orgId, rateLimit, requireAuth, type Env } from "../middleware.js";
import { cleanIdentify, collectHit, isPixelKey, pixelScript, PIXEL_LIMITS } from "../services/visitors.js";
import { upsertLead } from "../services/leads.js";
import { tryConsume } from "../lib/quota.js";
import { audit } from "../lib/audit.js";
import { stripNul } from "../lib/sanitize.js";
import { asksNotToBeTracked } from "../lib/privacyVisitor.js";
import { assertRowCap } from "../lib/limits.js";

/** Public pixel endpoints (no auth). Mounted at /px */
export const pixelPublic = new Hono();

/**
 * The snippet. Only for something shaped like a real pixel key.
 *
 * The path segment was written into the JavaScript as-is, so `/px/<anything>.js` served
 * `<anything>` back as script from our origin: a quote in it closed the string and the rest
 * ran. The key must now match the format keys are issued in, and it is JSON-encoded into
 * the script rather than pasted.
 */
pixelPublic.get("/:file", (c) => {
  const file = c.req.param("file");
  if (!file.endsWith(".js")) return c.notFound();
  const key = file.slice(0, -3);
  if (!isPixelKey(key)) return c.notFound();
  c.header("content-type", "application/javascript; charset=utf-8");
  c.header("x-content-type-options", "nosniff");
  c.header("cache-control", "public, max-age=3600");
  return c.body(pixelScript(key));
});

/** A bounded string field from a beacon body, or undefined. Longer values are cut. */
const field = (v: unknown, max: number): string | undefined => (typeof v === "string" && v ? stripNul(v).slice(0, max) : typeof v === "number" && Number.isFinite(v) ? String(v).slice(0, max) : undefined);

/** Host of an Origin or Referer header, lower-cased, or null. */
function headerHost(v: string | undefined): string | null {
  if (!v) return null;
  try {
    return new URL(v).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Does `host` belong to one of the pixel's allowed domains (the domain itself or a subdomain)? */
export function hostAllowed(host: string, allowed: string[]): boolean {
  return allowed.some((d) => {
    const dom = d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^\*\./, "").replace(/^www\./, "");
    if (!dom) return false;
    const h = host.replace(/^www\./, "");
    return h === dom || h.endsWith(`.${dom}`);
  });
}

pixelPublic.options("/:key/collect", (c) => c.body(null, 204));
// Per-IP: a pixel key is public (it is in the page source), so without a limit anyone can
// flood an org's visitor table and burn its IP-lookup budget.
pixelPublic.post("/:key/collect", rateLimit({ perMinute: 120, name: "pixel-collect" }), async (c) => {
  const key = c.req.param("key");
  c.header("access-control-allow-origin", "*");
  // Anything that is not a key we could have issued is answered like an unknown key.
  if (!isPixelKey(key)) return c.body(null, 204);
  // A browser that says "do not track me" (Global Privacy Control, or Do Not Track) is taken
  // at its word: nothing is stored, nothing is queued and no lookup is made. The script does
  // not send these hits at all; this covers a cached older copy of it and anything else
  // that posts here. Answered exactly like a stored hit, so the page cannot tell.
  if (asksNotToBeTracked((name) => c.req.header(name))) return c.body(null, 204);
  // allowedDomains was stored and shown in settings but never enforced, so a copied snippet
  // on any site reported visits as this org's. When the list is set, the hit must come from
  // one of those sites. A missing Origin AND Referer (some privacy setups) is refused too:
  // with an allow-list, "cannot tell" is not "allowed".
  const { db } = getDb();
  const px = await db.query.pixels.findFirst({ where: eq(pixels.key, key) });
  if (px && px.allowedDomains.length) {
    const host = headerHost(c.req.header("origin")) ?? headerHost(c.req.header("referer"));
    if (!host || !hostAllowed(host, px.allowedDomains)) {
      c.header("access-control-allow-origin", "*");
      return c.json({ ok: false, error: "origin not allowed for this pixel" }, 403);
    }
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    try {
      body = JSON.parse(await c.req.text());
    } catch {}
  }
  // The proxy-reported address, not the first XFF entry, which the browser can set to any
  // company's IP and so attribute a "visit" to a company that never came.
  const ip = clientIp(c);
  if (!ip || ip === "unknown") return c.json({ ok: false, error: "no ip" }, 400);
  if (!body || typeof body !== "object" || Array.isArray(body)) body = {};
  // Every field is bounded here, before anything is stored or queued. This endpoint takes
  // no authentication, and a 1 MB session id or a 2 MB identify object used to be written
  // to the visits table and into a job payload exactly as sent.
  const event = body.e === "leave" || body.e === "identify" ? body.e : "view";
  const duration = Number(body.d ?? 0);
  await collectHit({
    pixelKey: key,
    ip,
    sessionId: field(body.sid, PIXEL_LIMITS.sessionId) ?? randomToken(8),
    page: field(body.p, PIXEL_LIMITS.page),
    referrer: field(body.r, PIXEL_LIMITS.referrer),
    userAgent: c.req.header("user-agent")?.slice(0, PIXEL_LIMITS.userAgent),
    durationMs: Number.isFinite(duration) ? Math.min(Math.max(0, Math.round(duration)), PIXEL_LIMITS.durationMs) : 0,
    event,
    identify: cleanIdentify(body.id),
  }).catch(() => false);
  c.header("access-control-allow-origin", "*");
  return c.body(null, 204);
});

/** Authenticated management. Mounted at /v1/visitors */
export const visitorRoutes = new Hono<Env>();
visitorRoutes.use("*", requireAuth);

visitorRoutes.get("/pixels", async (c) => {
  const { db } = getDb();
  const rows = await db.select().from(pixels).where(eq(pixels.orgId, orgId(c))).orderBy(desc(pixels.createdAt));
  return c.json({ pixels: rows.map((p) => ({ ...p, snippet: `<script async src="${env.apiUrl}/px/${p.key}.js"></script>` })) });
});

visitorRoutes.post("/pixels", zValidator("json", z.object({ name: z.string().min(1).max(200), allowedDomains: z.array(z.string().max(253)).max(50).default([]) })), async (c) => {
  const { db } = getDb();
  // A generous ceiling on how many pixels one workspace can hold (lib/limits.ts); existing ones are untouched.
  await assertRowCap(db, pixels, orgId(c), "pixels");
  const [row] = await db.insert(pixels).values({ orgId: orgId(c), key: `px_${randomToken(12)}`, ...c.req.valid("json") }).returning();
  await audit(c, "pixel.created", { targetType: "pixel", targetId: row.id, data: { name: row.name, allowedDomains: row.allowedDomains } });
  return c.json({ ...row, snippet: `<script async src="${env.apiUrl}/px/${row.key}.js"></script>` }, 201);
});

visitorRoutes.delete("/pixels/:id", async (c) => {
  const { db } = getDb();
  const gone = await db.delete(pixels).where(and(eq(pixels.id, c.req.param("id")), eq(pixels.orgId, orgId(c)))).returning({ id: pixels.id, name: pixels.name });
  if (!gone.length) throw notFound("Pixel");
  await audit(c, "pixel.deleted", { targetType: "pixel", targetId: gone[0].id, data: { name: gone[0].name } });
  return c.json({ ok: true });
});

/** Identified companies, sorted by intent. */
visitorRoutes.get("/", zValidator("query", z.object({ status: z.string().optional(), days: z.coerce.number().int().min(1).max(365).default(30), limit: z.coerce.number().int().min(1).max(500).default(100) })), async (c) => {
  const q = c.req.valid("query");
  const { db } = getDb();
  const rows = await db
    .select({ v: visitorCompanies, company: companies })
    .from(visitorCompanies)
    .leftJoin(companies, and(eq(visitorCompanies.companyId, companies.id), eq(companies.orgId, orgId(c))))
    .where(and(eq(visitorCompanies.orgId, orgId(c)), q.status ? eq(visitorCompanies.status, q.status) : sql`true`, sql`${visitorCompanies.lastSeenAt} > now() - (${q.days} || ' days')::interval`))
    .orderBy(desc(visitorCompanies.intentScore), desc(visitorCompanies.lastSeenAt))
    .limit(q.limit);
  const [totals] = await db.select({ visits: sql<number>`count(*)::int`, identified: sql<number>`count(*) FILTER (WHERE company_domain IS NOT NULL)::int`, isp: sql<number>`count(*) FILTER (WHERE is_isp)::int` }).from(visits).where(and(eq(visits.orgId, orgId(c)), sql`${visits.visitedAt} > now() - (${q.days} || ' days')::interval`));
  return c.json({ companies: rows.map((r) => ({ ...r.v, company: r.company })), totals });
});

// A domain this workspace has never seen answers 404 on both of these. They used to answer
// 200 - an empty list, and "ok: true" for an update that changed nothing.
visitorRoutes.get("/:domain/visits", async (c) => {
  const { db } = getDb();
  const oid = orgId(c);
  const domain = c.req.param("domain");
  const found = await db.select().from(visits).where(and(eq(visits.orgId, oid), eq(visits.companyDomain, domain))).orderBy(desc(visits.visitedAt)).limit(200);
  // The IP hash is a key for our own bookkeeping; it says nothing a customer can use, so it
  // stays on the server.
  const rows = found.map(({ ipHash: _ipHash, ...rest }) => rest);
  if (!rows.length) {
    const known = await db.query.visitorCompanies.findFirst({ where: and(eq(visitorCompanies.orgId, oid), eq(visitorCompanies.domain, domain)) });
    if (!known) throw notFound("Visitor company");
  }
  return c.json({ visits: rows });
});

visitorRoutes.patch("/:domain", zValidator("json", z.object({ status: z.enum(["new", "reviewed", "contacted", "ignored"]) })), async (c) => {
  const { db } = getDb();
  const changed = await db.update(visitorCompanies).set({ status: c.req.valid("json").status }).where(and(eq(visitorCompanies.orgId, orgId(c)), eq(visitorCompanies.domain, c.req.param("domain")))).returning({ id: visitorCompanies.id });
  if (!changed.length) throw notFound("Visitor company");
  return c.json({ ok: true });
});

/** Find decision makers at a visiting company and save them as leads. */
visitorRoutes.post("/:domain/decision-makers", zValidator("json", z.object({ titles: z.array(z.string().max(200)).max(25).default(["CEO", "Founder", "Head of Sales", "Head of Marketing", "CTO"]), limit: z.number().int().min(1).max(20).default(5), save: z.boolean().default(true) })), async (c) => {
  const oid = orgId(c);
  const domain = c.req.param("domain");
  const b = c.req.valid("json");
  const { db } = getDb();
  const vc = await db.query.visitorCompanies.findFirst({ where: and(eq(visitorCompanies.orgId, oid), eq(visitorCompanies.domain, domain)) });
  if (!vc) throw notFound("Visitor company");
  await consume(db, oid, "searches", 1);
  const company = vc.companyId ? await db.query.companies.findFirst({ where: and(eq(companies.id, vc.companyId), eq(companies.orgId, oid)) }) : null;
  const people = await findPeople({ companyName: company?.name ?? vc.name ?? domain.split(".")[0], titles: b.titles, limit: b.limit });
  const saved: string[] = [];
  let newlyFound = 0;
  let stopped: string | undefined;
  if (b.save) {
    for (const p of people) {
      const { lead, created } = await upsertLead(oid, { firstName: p.firstName, lastName: p.lastName, fullName: p.fullName, title: p.title, linkedinUrl: p.linkedinUrl, location: p.location, companyDomain: domain, companyName: company?.name ?? vc.name ?? undefined, source: "website_visitor", tags: ["visitor", `intent:${Math.round(vc.intentScore)}`] }, { fillOnly: true });
      saved.push(lead.id);
      if (!created) continue;
      newlyFound++;
      const charge = await tryConsume(db, oid, "leads", 1);
      if (!charge.ok) {
        // Say which of the two it was. A truncated list with no explanation looks like
        // "that is all there was", which is the one thing it must never look like.
        stopped = charge.reason === "quota" ? `Stopped at ${saved.length}: ${charge.message}` : `Stopped at ${saved.length}: could not record usage (${charge.message})`;
        break;
      }
    }
    // Only people not already saved count as found, or every click re-counts the same leads.
    await db.update(visitorCompanies).set({ leadsFound: vc.leadsFound + newlyFound, status: vc.status === "new" ? "reviewed" : vc.status }).where(eq(visitorCompanies.id, vc.id));
  }
  return c.json({ people, savedLeadIds: saved, stopped });
});
