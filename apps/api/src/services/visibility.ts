import { and, desc, eq, getDb, organizations, sql, visibilityPrompts, visibilityRuns } from "@prospex/db";
import {
  analyzeAnswer,
  competitorStandings,
  compareVisibility,
  createAiProviderForPlan,
  visibilityGaps,
  visibilityMetrics,
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
  opts: { plan?: string; others?: string[] } = {},
) {
  const cfg = await visibilityConfig(db, orgIdValue);
  const provider = createAiProviderForPlan(opts.plan ?? "free");
  if (!provider) throw new Error("No AI provider configured");

  let answer = "";
  let error: string | null = null;
  try {
    answer = await provider.complete(
      [
        // No brand names in the prompt. Naming yourself biases the engine toward
        // mentioning you, which would measure the prompt rather than your visibility.
        { role: "system", content: "Answer the user's question directly and concretely, as you normally would. Name specific products or vendors where relevant." },
        { role: "user", content: prompt.text },
      ],
      { maxTokens: 900, temperature: 0.7 },
    );
  } catch (e) {
    error = (e as Error).message.slice(0, 500);
  }

  const analysis = analyzeAnswer(answer, { brand: cfg.brand, competitors: cfg.competitors, others: opts.others });
  const [row] = await db
    .insert(visibilityRuns)
    .values({
      orgId: orgIdValue,
      promptId: prompt.id,
      engine: provider.name,
      model: provider.model,
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
    competitors: competitorStandings(current, cfg.brand.name),
    change: compareVisibility(before, after),
    gaps: visibilityGaps(current, cfg.brand.name).map((g) => ({ ...g, prompt: promptText.get(g.promptId) ?? g.promptId })),
    /** Refusals and errors, surfaced so a thin denominator is never silently hidden. */
    excludedRuns: unusable ?? 0,
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
