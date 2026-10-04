import { Hono } from "hono";
import { zValidator } from "../lib/validate.js";
import { z } from "zod";
import { discoveredLeads, recentAgentRuns, runDiscoveryAgent } from "../services/agents/discovery.js";
import { orgId, rateLimit, requireAuth, type Env } from "../middleware.js";

/**
 * Scheduled and on-demand lead discovery.
 *
 * The routes keep their original paths so anything already pointed at them keeps working,
 * but what they run has changed completely: the agent behind them used to invent profiles
 * and now runs the product's real discovery pipeline. See services/agents/discovery.ts.
 */
export const automationRoutes = new Hono<Env>();
automationRoutes.use("*", requireAuth);

const runInput = z.object({
  query: z.string().min(3).max(500).default("VP Sales at B2B SaaS companies"),
  // Capped at 200, not 1000. The old ceiling was meaningless because nothing was being
  // fetched; a real run makes provider calls and costs quota per lead.
  count: z.coerce.number().min(1).max(200).default(25),
  icpId: z.string().uuid().optional(),
  /** Report what would be stored without storing it. */
  preview: z.boolean().default(false),
});

/**
 * Failed and blocked runs carry `error` as a plain string, while every other error response
 * in this API is `{ error: { code, message } }` - which is what the web client reads, so a
 * failed run showed as a bare "HTTP 502". The run's fields all stay; only `error` takes the
 * standard shape (its text moves to `error.message`, and is kept as `errorText` too).
 */
function withErrorShape<T extends { status: string; error?: string; note?: string }>(r: T) {
  if (r.status !== "failed" && r.status !== "blocked" && r.status !== "quota") return r;
  if (r.status === "quota") {
    const message = (r as { quotaStopped?: string }).quotaStopped ?? r.note ?? "Your monthly searches limit is reached.";
    return { ...r, error: { code: "quota_exceeded", message }, errorText: r.error };
  }
  const message = r.error ?? r.note ?? (r.status === "blocked" ? "No data source could answer this run." : "The discovery run failed.");
  return { ...r, error: { code: r.status === "blocked" ? "providers_unavailable" : "discovery_failed", message }, errorText: r.error };
}

/** quota -> 402, every source refused -> 502, failed -> 500. */
const discoveryStatus = (s: string) => (s === "quota" ? 402 : s === "blocked" ? 502 : s === "failed" ? 500 : 200);

const leadsQuery = z.object({
  company: z.string().max(200).optional(),
  runId: z.string().uuid().optional(),
  limit: z.coerce.number().min(1).max(500).default(50),
  offset: z.coerce.number().min(0).default(0),
});

/**
 * Run a discovery pass now.
 *
 * Synchronous and rate-limited because it makes real provider calls: a caller that fires
 * this in a loop is spending the org's lead quota and its providers' credits.
 */
automationRoutes.post("/discover", rateLimit({ perMinute: 6 }), zValidator("json", runInput), async (c) => {
  const b = c.req.valid("json");
  const r = await runDiscoveryAgent(orgId(c), b.query, { limit: b.count, icpId: b.icpId, preview: b.preview });

  // 502 when every source refused us. A run that found nothing because nothing answered is
  // not a successful run that found nothing, and a caller polling this needs to know which.
  return c.json(withErrorShape(r), discoveryStatus(r.status));
});

/** Kept for the existing scheduled workflow, which posts to this path. */
automationRoutes.post("/linkedin-scrape", rateLimit({ perMinute: 6 }), zValidator("json", runInput), async (c) => {
  const b = c.req.valid("json");
  const r = await runDiscoveryAgent(orgId(c), b.query, { limit: b.count, icpId: b.icpId, preview: b.preview });
  return c.json(
    {
      ...withErrorShape(r),
      // A separate key. Overwriting `note` erased the run's own explanation - and on the
      // blocked path that note is the ONLY place the provider outage is described, so a 502
      // came back saying nothing but "this endpoint was renamed".
      deprecation:
        "This endpoint no longer scrapes LinkedIn, and never did - it ran a model that invented profiles. It now runs Scout's real discovery pipeline. Use POST /v1/automation/discover.",
    },
    discoveryStatus(r.status),
  );
});

/** Leads this agent surfaced, read through to their current state. */
automationRoutes.get("/leads", zValidator("query", leadsQuery), async (c) => {
  const q = c.req.valid("query");
  const rows = await discoveredLeads(orgId(c), q);
  return c.json({ data: rows, count: rows.length });
});

/** Run history, with what each run actually produced. */
automationRoutes.get("/runs", zValidator("query", z.object({ limit: z.coerce.number().min(1).max(100).default(25) })), async (c) =>
  c.json({ runs: await recentAgentRuns(orgId(c), c.req.valid("query").limit) }),
);
