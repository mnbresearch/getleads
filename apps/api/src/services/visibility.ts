import { and, desc, eq, getDb, organizations, sql, visibilityPrompts, visibilityRuns } from "@prospex/db";
import {
  analyzeAnswer,
  availableAiProvidersForPlan,
  competitorStandings,
  compareVisibility,
  engineDisagreement,
  metricsByEngine,
  visibilityGaps,
  visibilityMetrics,
  type AiProvider,
  type BrandSpec,
  type VisibilityObservation,
} from "@prospex/core";

/**
 * AI visibility execution and reporting.
 *
 * The product thesis in one line: outbound creates demand, and AI answers decide whether
 * that demand survives the prospect's next step. When someone gets your cold email and
 * asks ChatGPT "is Scout any good, what are the alternatives", the answer they get is now
 * part of your funnel. This measures that answer.
 *
 * The discipline that makes it trustworthy, and which most of this category skips:
 * an LLM answer is a sample, so nothing is reported from one run, refusals are excluded
 * rather than counted as absence, and no change is called real until the confidence
 * intervals separate. See packages/core/src/visibility/metrics.ts.
 */

/** Per-org brand configuration. Lives in the generic settings bag, so no migration needed. */
export interface VisibilityConfig {
  brand: BrandSpec;
  competitors: BrandSpec[];
}

export async function visibilityConfig(db: ReturnType<typeof getDb>["db"], orgIdValue: string): Promise<VisibilityConfig> {
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, orgIdValue) });
  const s = (org?.settings ?? {}) as Record<string, unknown>;
  const cfg = (s.visibility ?? {}) as Partial<VisibilityConfig>;
  return {
    brand: cfg.brand ?? { name: org?.name ?? "Your brand", aliases: [], domain: null },
    competitors: cfg.competitors ?? [],
  };
}

export async function saveVisibilityConfig(db: ReturnType<typeof getDb>["db"], orgIdValue: string, cfg: VisibilityConfig) {
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, orgIdValue) });
  const settings = (org?.settings ?? {}) as Record<string, unknown>;
  await db
    .update(organizations)
    .set({ settings: { ...settings, visibility: cfg } })
    .where(eq(organizations.id, orgIdValue));
  return cfg;
}

/**
 * Ask one engine one prompt once, analyze the answer, and store both.
 *
 * The raw answer is kept deliberately. Metrics are re-derivable from raw text; they are
 * not re-derivable from a summary, and the analysis logic will keep changing.
 */
export async function runVisibilityPrompt(
  db: ReturnType<typeof getDb>["db"],
  orgIdValue: string,
  prompt: { id: string; text: string },
  opts: { plan?: string; others?: string[]; provider?: AiProvider } = {},
) {
  const cfg = await visibilityConfig(db, orgIdValue);
  const provider = opts.provider ?? availableAiProvidersForPlan(opts.plan ?? "free")[0];
  if (!provider) throw new Error("No AI provider configured");

  let answer = "";
  let error: string | null = null;
  // Snapshot before the call: the provider self-heals onto a different model when the
  // configured one is unavailable, so reading provider.model afterwards would record the
  // replacement on a run that actually failed on the original. The stored model must be
  // the one the attempt used, or the run history cannot be trusted for forensics.
  const attemptedModel = provider.model;
  try {
    answer = await provider.complete(
      [
        // No brand names in the prompt. Naming yourself biases the engine toward
        // mentioning you, which would measure the prompt rather than your visibility.
        { role: "system", content: "Answer the user's question directly and concretely, as you normally would. Name specific products or vendors where relevant." },
        { role: "user", content: prompt.text },
      ],
      { maxTokens: 1600, temperature: 0.7 },
    );
  } catch (e) {
    error = (e as Error).message.slice(0, 500);
  }

  // An empty body with no exception is not the engine declining - it is the engine
  // returning nothing, which happens when a reasoning model spends its whole token budget
  // before emitting content. Recording it as a refusal would blame the engine's judgement
  // for what is really a configuration problem, and hide it from engine health.
  if (!error && answer.trim().length === 0) {
    error = `${provider.name} returned an empty completion (model ${provider.model}); likely token budget exhausted before any content was produced`;
  }

  const analysis = analyzeAnswer(answer, { brand: cfg.brand, competitors: cfg.competitors, others: opts.others });
  const [row] = await db
    .insert(visibilityRuns)
    .values({
      orgId: orgIdValue,
      promptId: prompt.id,
      engine: provider.name,
      // The model actually used for this attempt, not whatever the provider healed onto.
      model: error ? attemptedModel : provider.model,
      answer,
      analysis: analysis as unknown as Record<string, unknown>,
      mentioned: !!analysis.brand,
      cited: analysis.brand?.cited ?? false,
      position: analysis.brand?.position ?? null,
      brands: analysis.orderedBrands,
      usable: !error && analysis.usable,
      error,
    })
    .returning();
  await db.update(visibilityPrompts).set({ lastRunAt: new Date() }).where(eq(visibilityPrompts.id, prompt.id));
  return { run: row, analysis };
}

/**
 * Sample one prompt across every engine the org can use.
 *
 * Engines disagree, so "what AI says" is only answerable by asking all of them. Each
 * engine is sampled `samples` times independently, which also keeps the per-engine
 * denominators balanced; an uneven split would bias the blended headline rate toward
 * whichever engine happened to run most.
 *
 * One engine failing does not abort the cycle. A dead API key on one provider should cost
 * you that engine's data, not the whole measurement.
 */
export async function sampleAcrossEngines(
  db: ReturnType<typeof getDb>["db"],
  orgIdValue: string,
  prompt: { id: string; text: string; engines?: string[] | null; samplesPerRun?: number },
  opts: { plan?: string; others?: string[]; samples?: number } = {},
) {
  const all = availableAiProvidersForPlan(opts.plan ?? "free");
  const wanted = (prompt.engines ?? []).filter(Boolean);
  const providers = wanted.length ? all.filter((p) => wanted.includes(p.name)) : all;
  if (providers.length === 0) throw new Error("No AI provider configured");

  const samples = opts.samples ?? prompt.samplesPerRun ?? 3;
  const results: { engine: string; ok: boolean; mentioned: boolean; usable: boolean }[] = [];
  for (const provider of providers) {
    for (let i = 0; i < samples; i++) {
      try {
        const { run } = await runVisibilityPrompt(db, orgIdValue, prompt, { ...opts, provider });
        results.push({ engine: provider.name, ok: true, mentioned: run.mentioned, usable: run.usable });
      } catch (e) {
        void e;
        results.push({ engine: provider.name, ok: false, mentioned: false, usable: false });
      }
    }
  }
  return {
    engines: providers.map((p) => p.name),
    samplesPerEngine: samples,
    total: results.length,
    usable: results.filter((r) => r.usable).length,
    mentioned: results.filter((r) => r.mentioned).length,
    results,
  };
}

/** Engines this org can currently sample, for the UI to show what "AI" actually covers. */
export function enginesForPlan(plan = "free") {
  return availableAiProvidersForPlan(plan).map((p) => ({ engine: p.name, model: p.model }));
}

/** Load usable runs as observations. Unusable runs are excluded, never counted as absence. */
export async function observationsFor(
  db: ReturnType<typeof getDb>["db"],
  orgIdValue: string,
  opts: { days?: number; promptId?: string } = {},
): Promise<VisibilityObservation[]> {
  const days = opts.days ?? 30;
  const rows = await db
    .select()
    .from(visibilityRuns)
    .where(
      and(
        eq(visibilityRuns.orgId, orgIdValue),
        eq(visibilityRuns.usable, true),
        opts.promptId ? eq(visibilityRuns.promptId, opts.promptId) : sql`true`,
        sql`${visibilityRuns.createdAt} > now() - (${days} || ' days')::interval`,
      ),
    )
    .orderBy(desc(visibilityRuns.createdAt))
    .limit(5000);
  return rows.map((r) => ({
    engine: r.engine,
    promptId: r.promptId,
    mentioned: r.mentioned,
    cited: r.cited,
    position: r.position,
    brands: r.brands ?? [],
    at: r.createdAt,
  }));
}

/**
 * Per-engine operational health over the window.
 *
 * Excluding a broken engine from the metrics is correct, but silently excluding it is not:
 * an engine whose model is misconfigured produces zero usable answers forever, and without
 * this the only symptom is a denominator that never grows. Errors are reported separately
 * from refusals because they mean different things - an error is your configuration, a
 * refusal is the engine's choice - and only one of them is fixable by you.
 */
export async function engineHealth(db: ReturnType<typeof getDb>["db"], orgIdValue: string, days = 30) {
  const rows = await db
    .select({
      engine: visibilityRuns.engine,
      total: sql<number>`count(*)::int`,
      usable: sql<number>`count(*) FILTER (WHERE usable = true)::int`,
      errored: sql<number>`count(*) FILTER (WHERE error IS NOT NULL)::int`,
      lastError: sql<string | null>`max(error)`,
    })
    .from(visibilityRuns)
    .where(and(eq(visibilityRuns.orgId, orgIdValue), sql`${visibilityRuns.createdAt} > now() - (${days} || ' days')::interval`))
    .groupBy(visibilityRuns.engine);

  return rows.map((r) => {
    const refused = r.total - r.usable - r.errored;
    const healthy = r.errored === 0 || r.usable > 0;
    return {
      engine: r.engine,
      total: r.total,
      usable: r.usable,
      errored: r.errored,
      refused: refused > 0 ? refused : 0,
      healthy,
      // Only surface the provider error when the engine is producing nothing at all,
      // so an occasional transient failure does not read as a broken configuration.
      problem:
        r.usable === 0 && r.errored > 0
          ? `${r.engine} returned an error on all ${r.errored} attempts and contributed no data. ${(r.lastError ?? "").slice(0, 200)}`
          : null,
    };
  });
}

/** The full report: where you stand, who owns the answers, and which gaps are winnable. */
export async function visibilityOverview(db: ReturnType<typeof getDb>["db"], orgIdValue: string, days = 30) {
  const cfg = await visibilityConfig(db, orgIdValue);
  const current = await observationsFor(db, orgIdValue, { days });

  // Split the window in half to test for a real change rather than eyeballing a chart.
  const cutoff = Date.now() - (days / 2) * 86_400_000;
  const after = current.filter((o) => new Date(o.at).getTime() >= cutoff);
  const before = current.filter((o) => new Date(o.at).getTime() < cutoff);

  const [{ unusable }] = await db
    .select({ unusable: sql<number>`count(*) FILTER (WHERE usable = false)::int` })
    .from(visibilityRuns)
    .where(and(eq(visibilityRuns.orgId, orgIdValue), sql`${visibilityRuns.createdAt} > now() - (${days} || ' days')::interval`));

  const prompts = await db.select().from(visibilityPrompts).where(eq(visibilityPrompts.orgId, orgIdValue));
  const promptText = new Map(prompts.map((p) => [p.id, p.text]));

  return {
    brand: cfg.brand,
    windowDays: days,
    metrics: visibilityMetrics(current, { brandName: cfg.brand.name }),
    // Per-engine is the actionable view; the blended headline above describes no single
    // engine and skews toward whichever was sampled most.
    byEngine: metricsByEngine(current, cfg.brand.name),
    engineDisagreement: engineDisagreement(current, cfg.brand.name),
    competitors: competitorStandings(current, cfg.brand.name),
    change: compareVisibility(before, after),
    gaps: visibilityGaps(current, cfg.brand.name).map((g) => ({ ...g, prompt: promptText.get(g.promptId) ?? g.promptId })),
    /** Refusals and errors, surfaced so a thin denominator is never silently hidden. */
    excludedRuns: unusable ?? 0,
    /** Which engines are actually contributing data, and which are misconfigured. */
    engineHealth: await engineHealth(db, orgIdValue, days),
  };
}

/** Brand names seen in recent answers, used to rank untracked rivals in future runs. */
export async function knownBrands(db: ReturnType<typeof getDb>["db"], orgIdValue: string, limit = 40): Promise<string[]> {
  const rows = await db
    .select({ brands: visibilityRuns.brands })
    .from(visibilityRuns)
    .where(and(eq(visibilityRuns.orgId, orgIdValue), eq(visibilityRuns.usable, true)))
    .orderBy(desc(visibilityRuns.createdAt))
    .limit(300);
  const counts = new Map<string, number>();
  for (const r of rows) for (const b of r.brands ?? []) counts.set(b, (counts.get(b) ?? 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([n]) => n);
}
