import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, consume, desc, eq, getDb, organizations, visibilityPrompts, visibilityRuns } from "@prospex/db";
import { notFound } from "../lib/errors.js";
import { orgId, requireAuth, type Env } from "../middleware.js";
import { enginesForPlan, knownBrands, observationsFor, sampleAcrossEngines, saveVisibilityConfig, suggestPrompts, visibilityConfig, visibilityOverview } from "../services/visibility.js";

/**
 * AI visibility (AEO/GEO).
 *
 * Measures how AI engines answer the questions your buyers actually ask, so you can see
 * whether a prospect researching you after your outreach finds you or a competitor.
 */
export const visibilityRoutes = new Hono<Env>();
visibilityRoutes.use("*", requireAuth);

const brandSpec = z.object({
  name: z.string().min(1).max(120),
  aliases: z.array(z.string().max(120)).max(20).default([]),
  domain: z.string().max(200).nullish(),
});

// ── Brand + competitor configuration ──
visibilityRoutes.get("/config", async (c) => c.json(await visibilityConfig(getDb().db, orgId(c))));

visibilityRoutes.put(
  "/config",
  zValidator("json", z.object({ brand: brandSpec, competitors: z.array(brandSpec).max(25).default([]) })),
  async (c) => c.json(await saveVisibilityConfig(getDb().db, orgId(c), c.req.valid("json"))),
);

// ── Tracked prompts ──
visibilityRoutes.get("/prompts", async (c) => {
  const { db } = getDb();
  const rows = await db
    .select()
    .from(visibilityPrompts)
    .where(eq(visibilityPrompts.orgId, orgId(c)))
    .orderBy(desc(visibilityPrompts.createdAt));
  return c.json({ prompts: rows });
});

visibilityRoutes.post(
  "/prompts",
  zValidator(
    "json",
    z.object({
      text: z.string().min(5).max(500),
      topic: z.string().max(80).optional(),
      engines: z.array(z.string()).max(10).default([]),
      // More samples per cycle means a tighter confidence interval sooner.
      samplesPerRun: z.number().int().min(1).max(10).default(3),
    }),
  ),
  async (c) => {
    const { db } = getDb();
    const [row] = await db.insert(visibilityPrompts).values({ orgId: orgId(c), ...c.req.valid("json") }).returning();
    return c.json(row, 201);
  },
);

visibilityRoutes.patch(
  "/prompts/:id",
  zValidator("json", z.object({ active: z.boolean().optional(), samplesPerRun: z.number().int().min(1).max(10).optional(), topic: z.string().max(80).optional() })),
  async (c) => {
    const { db } = getDb();
    const [row] = await db
      .update(visibilityPrompts)
      .set(c.req.valid("json"))
      .where(and(eq(visibilityPrompts.id, c.req.param("id")), eq(visibilityPrompts.orgId, orgId(c))))
      .returning();
    if (!row) throw notFound("Prompt");
    return c.json(row);
  },
);

visibilityRoutes.delete("/prompts/:id", async (c) => {
  const { db } = getDb();
  await db.delete(visibilityPrompts).where(and(eq(visibilityPrompts.id, c.req.param("id")), eq(visibilityPrompts.orgId, orgId(c))));
  return c.json({ ok: true });
});

/**
 * Sample a prompt now.
 *
 * Runs `samplesPerRun` times by default rather than once, because a single answer is a
 * sample and reporting it as a measurement is the core mistake this product avoids.
 */
visibilityRoutes.post("/prompts/:id/run", zValidator("json", z.object({ samples: z.number().int().min(1).max(10).optional() }).optional()), async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const prompt = await db.query.visibilityPrompts.findFirst({
    where: and(eq(visibilityPrompts.id, c.req.param("id")), eq(visibilityPrompts.orgId, oid)),
  });
  if (!prompt) throw notFound("Prompt");

  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, oid) });
  const plan = org?.plan ?? "free";
  const others = await knownBrands(db, oid);
  const samples = c.req.valid("json")?.samples ?? prompt.samplesPerRun;
  // Quota is charged per actual model call, so sampling N engines costs N times as much.
  const engineCount = Math.max(1, enginesForPlan(plan).length);
  await consume(db, oid, "aiMessages", samples * engineCount).catch(() => {});

  const r = await sampleAcrossEngines(db, oid, prompt, { others, samples, plan });
  return c.json({
    ...r,
    note:
      r.usable < r.total
        ? `${r.total - r.usable} of ${r.total} answers were refusals or errors and are excluded from metrics rather than counted as absence.`
        : undefined,
  });
});

/**
 * Suggest what to track.
 *
 * `ai=true` has the model write the set from this org's own brand, competitors and ICP;
 * otherwise a deterministic pack is returned. Either way the response says which one it
 * is, and every suggestion has already been validated - notably against naming the brand,
 * since a question that names you guarantees you appear and measures nothing.
 */
visibilityRoutes.post(
  "/prompts/suggest",
  zValidator("json", z.object({ ai: z.boolean().default(false), category: z.string().max(120).optional() }).optional()),
  async (c) => {
    const oid = orgId(c);
    const { db } = getDb();
    const body = c.req.valid("json") ?? { ai: false };
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, oid) });
    // One model call, charged like any other.
    if (body.ai) await consume(db, oid, "aiMessages", 1).catch(() => {});
    return c.json(await suggestPrompts(db, oid, { plan: org?.plan ?? "free", useAi: body.ai, category: body.category }));
  },
);

/** Install a reviewed set in one call, so accepting suggestions is not 10 round trips. */
visibilityRoutes.post(
  "/prompts/bulk",
  zValidator(
    "json",
    z.object({
      prompts: z
        .array(z.object({ text: z.string().min(5).max(500), topic: z.string().max(80).optional() }))
        .min(1)
        .max(25),
      samplesPerRun: z.number().int().min(1).max(10).default(3),
    }),
  ),
  async (c) => {
    const oid = orgId(c);
    const { db } = getDb();
    const body = c.req.valid("json");

    // Re-check against what is already tracked. The client sends back a set it was shown
    // moments ago, and the user may have added one of them by hand in between.
    const existing = await db.select({ text: visibilityPrompts.text }).from(visibilityPrompts).where(eq(visibilityPrompts.orgId, oid));
    const seen = new Set(existing.map((r) => r.text.trim().toLowerCase()));
    const fresh = body.prompts.filter((p) => !seen.has(p.text.trim().toLowerCase()));
    if (fresh.length === 0) return c.json({ created: [], skipped: body.prompts.length });

    const rows = await db
      .insert(visibilityPrompts)
      .values(fresh.map((p) => ({ orgId: oid, text: p.text.trim(), topic: p.topic, samplesPerRun: body.samplesPerRun })))
      .returning();
    return c.json({ created: rows, skipped: body.prompts.length - fresh.length }, 201);
  },
);

/** Which engines "AI visibility" actually covers for this org right now. */
visibilityRoutes.get("/engines", async (c) => {
  const { db } = getDb();
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, orgId(c)) });
  return c.json({ engines: enginesForPlan(org?.plan ?? "free") });
});

// ── Reporting ──
visibilityRoutes.get("/overview", zValidator("query", z.object({ days: z.coerce.number().min(7).max(90).default(30) })), async (c) =>
  c.json(await visibilityOverview(getDb().db, orgId(c), c.req.valid("query").days)),
);

visibilityRoutes.get("/observations", zValidator("query", z.object({ days: z.coerce.number().min(1).max(90).default(30), promptId: z.string().uuid().optional() })), async (c) => {
  const q = c.req.valid("query");
  return c.json({ observations: await observationsFor(getDb().db, orgId(c), q) });
});

/** Raw answers, so a number can always be traced back to the text it came from. */
visibilityRoutes.get("/runs", zValidator("query", z.object({ promptId: z.string().uuid().optional(), limit: z.coerce.number().min(1).max(100).default(25) })), async (c) => {
  const q = c.req.valid("query");
  const { db } = getDb();
  const rows = await db
    .select()
    .from(visibilityRuns)
    .where(and(eq(visibilityRuns.orgId, orgId(c)), q.promptId ? eq(visibilityRuns.promptId, q.promptId) : undefined))
    .orderBy(desc(visibilityRuns.createdAt))
    .limit(q.limit);
  return c.json({ runs: rows });
});
