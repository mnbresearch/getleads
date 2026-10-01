import { Hono } from "hono";
import { zValidator } from "../lib/validate.js";
import { z } from "zod";
import { and, companies, consume, desc, eq, getDb, pixels, sql, visitorCompanies, visits } from "@prospex/db";
import { findPeople } from "@prospex/core";
import { env } from "../env.js";
import { randomToken } from "../lib/crypto.js";
import { notFound } from "../lib/errors.js";
import { clientIp, orgId, rateLimit, requireAuth, type Env } from "../middleware.js";
import { collectHit, pixelScript } from "../services/visitors.js";
import { upsertLead } from "../services/leads.js";
import { tryConsume } from "../lib/quota.js";

/** Public pixel endpoints (no auth). Mounted at /px */
export const pixelPublic = new Hono();

pixelPublic.get("/:file", (c) => {
  const file = c.req.param("file");
  if (!file.endsWith(".js")) return c.notFound();
  c.header("content-type", "application/javascript");
  c.header("cache-control", "public, max-age=3600");
  return c.body(pixelScript(file.replace(/\.js$/, "")));
});

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
  await collectHit({ pixelKey: key, ip, sessionId: String(body.sid ?? randomToken(8)), page: body.p ? String(body.p) : undefined, referrer: body.r ? String(body.r) : undefined, userAgent: c.req.header("user-agent"), durationMs: Number(body.d ?? 0) || 0, event: String(body.e ?? "view"), identify: typeof body.id === "object" && body.id ? (body.id as Record<string, unknown>) : undefined }).catch(() => false);
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

visitorRoutes.post("/pixels", zValidator("json", z.object({ name: z.string().min(1), allowedDomains: z.array(z.string()).default([]) })), async (c) => {
  const { db } = getDb();
  const [row] = await db.insert(pixels).values({ orgId: orgId(c), key: `px_${randomToken(12)}`, ...c.req.valid("json") }).returning();
  return c.json({ ...row, snippet: `<script async src="${env.apiUrl}/px/${row.key}.js"></script>` }, 201);
});

visitorRoutes.delete("/pixels/:id", async (c) => {
  const { db } = getDb();
  const gone = await db.delete(pixels).where(and(eq(pixels.id, c.req.param("id")), eq(pixels.orgId, orgId(c)))).returning({ id: pixels.id });
  if (!gone.length) throw notFound("Pixel");
  return c.json({ ok: true });
});

/** Identified companies, sorted by intent. */
visitorRoutes.get("/", zValidator("query", z.object({ status: z.string().optional(), days: z.coerce.number().int().min(1).max(365).default(30), limit: z.coerce.number().int().min(1).max(500).default(100) })), async (c) => {
  const q = c.req.valid("query");
  const { db } = getDb();
  const rows = await db
    .select({ v: visitorCompanies, company: companies })
    .from(visitorCompanies)
    .leftJoin(companies, eq(visitorCompanies.companyId, companies.id))
    .where(and(eq(visitorCompanies.orgId, orgId(c)), q.status ? eq(visitorCompanies.status, q.status) : sql`true`, sql`${visitorCompanies.lastSeenAt} > now() - (${q.days} || ' days')::interval`))
    .orderBy(desc(visitorCompanies.intentScore), desc(visitorCompanies.lastSeenAt))
    .limit(q.limit);
  const [totals] = await db.select({ visits: sql<number>`count(*)::int`, identified: sql<number>`count(*) FILTER (WHERE company_domain IS NOT NULL)::int`, isp: sql<number>`count(*) FILTER (WHERE is_isp)::int` }).from(visits).where(and(eq(visits.orgId, orgId(c)), sql`${visits.visitedAt} > now() - (${q.days} || ' days')::interval`));
  return c.json({ companies: rows.map((r) => ({ ...r.v, company: r.company })), totals });
});

visitorRoutes.get("/:domain/visits", async (c) => {
  const { db } = getDb();
  const rows = await db.select().from(visits).where(and(eq(visits.orgId, orgId(c)), eq(visits.companyDomain, c.req.param("domain")))).orderBy(desc(visits.visitedAt)).limit(200);
  return c.json({ visits: rows });
});

visitorRoutes.patch("/:domain", zValidator("json", z.object({ status: z.enum(["new", "reviewed", "contacted", "ignored"]) })), async (c) => {
  const { db } = getDb();
  await db.update(visitorCompanies).set({ status: c.req.valid("json").status }).where(and(eq(visitorCompanies.orgId, orgId(c)), eq(visitorCompanies.domain, c.req.param("domain"))));
  return c.json({ ok: true });
});

/** Find decision makers at a visiting company and save them as leads. */
visitorRoutes.post("/:domain/decision-makers", zValidator("json", z.object({ titles: z.array(z.string()).default(["CEO", "Founder", "Head of Sales", "Head of Marketing", "CTO"]), limit: z.number().int().min(1).max(20).default(5), save: z.boolean().default(true) })), async (c) => {
  const oid = orgId(c);
  const domain = c.req.param("domain");
  const b = c.req.valid("json");
  const { db } = getDb();
  const vc = await db.query.visitorCompanies.findFirst({ where: and(eq(visitorCompanies.orgId, oid), eq(visitorCompanies.domain, domain)) });
  if (!vc) throw notFound("Visitor company");
  await consume(db, oid, "searches", 1);
  const company = vc.companyId ? await db.query.companies.findFirst({ where: eq(companies.id, vc.companyId) }) : null;
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
