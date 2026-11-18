import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "../lib/validate.js";
import { orgId, requireAuth, type Env } from "../middleware.js";
import { getDb, digitalWorkers, signalSurges, eq, desc, getUsage } from "@prospex/db";
import { verifyOptsFor } from "../lib/verifyOpts.js";

export const competitorScaleRoutes = new Hono<Env>();
competitorScaleRoutes.use("*", requireAuth);

/**
 * Waterfall verification: the chain Scout really runs for this workspace.
 *
 * This used to return a hard-coded provider list with invented hit rates and invented
 * monthly totals ("94.6% match rate", "1,240 enriched"), and a /simulate endpoint that
 * built firstname.lastname@domain, called it "verified" at 98% confidence and attached a
 * random US mobile number. Nothing was checked. The chain below is the one verifyEmail in
 * @prospex/core walks, in its order, marked with which links have a key on this deployment
 * (or this workspace's own Hunter key). A real test lookup is POST /v1/search/find-email.
 */
competitorScaleRoutes.get("/waterfall", async (c) => {
  const oid = orgId(c);
  const opts = await verifyOptsFor(oid);
  const { db } = getDb();
  const usage = await getUsage(db, oid).catch(() => null);
  const chain = [
    { id: "syntax_mx", name: "Syntax, disposable-domain and MX checks", configured: true, description: "Always run first, free. A domain that cannot receive mail stops here." },
    { id: "reoon", name: "Reoon", configured: Boolean(opts.reoonApiKey), description: "Mailbox-level verification." },
    { id: "millionverifier", name: "MillionVerifier", configured: Boolean(opts.millionVerifierApiKey), description: "Mailbox-level verification and catch-all detection." },
    { id: "hunter", name: "Hunter", configured: Boolean(opts.hunterApiKey), description: "Email finder and verifier." },
    { id: "abstract", name: "Abstract", configured: Boolean(opts.abstractApiKey), description: "Deliverability check." },
    { id: "smtp_direct", name: "Direct SMTP probe", configured: Boolean(opts.smtp), description: "Asks the mail server directly. Off where the host blocks port 25." },
  ];
  return c.json({
    chain,
    stopOnFirstVerdict: true,
    mobilePhones: false,
    usage: usage?.usage?.verifications ?? null,
    testWith: "POST /v1/search/find-email",
  });
});

/** Autonomous Digital Workers (11x Alice & Jordan equivalent) */
competitorScaleRoutes.get("/digital-workers", async (c) => {
  // Only what this workspace has. The invented "Alice" and "Jordan" with their invented
  // daily counts are gone; the AI SDR that actually runs is an Autopilot (/v1/automation).
  const oid = orgId(c);
  const { db } = getDb();
  const workers = await db.select().from(digitalWorkers).where(eq(digitalWorkers.orgId, oid));
  return c.json({ workers, summary: { activeWorkers: workers.filter((w) => w.status === "active").length }, realFeature: "/v1/tools/autopilots" });
});

/** Signal Convergence & Intent Surges (Warmly + Common Room equivalent) */
competitorScaleRoutes.get("/signal-surges", async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const surges = await db.select().from(signalSurges).where(eq(signalSurges.orgId, oid)).orderBy(desc(signalSurges.compositeIntentScore)).limit(20);

  // Only this workspace's rows: the three invented surges at real companies are gone.
  const scores = surges.map((x) => x.compositeIntentScore ?? 0);
  return c.json({
    surges,
    aggregate: {
      surgingAccounts: surges.length,
      averageIntentScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
    },
    realFeature: "/v1/signals/feed",
  });
});

/** Email Coaching & Real-Time Scoring (Lavender.ai equivalent) */
competitorScaleRoutes.post(
  "/email-coach/score",
  zValidator(
    "json",
    z.object({
      subject: z.string().default(""),
      body: z.string().min(1),
      recipientTitle: z.string().optional(),
    })
  ),
  async (c) => {
    const { subject, body } = c.req.valid("json");
    const words = body.trim().split(/\s+/).filter(Boolean);
    const wordCount = words.length;
    const charCount = body.length;
    const hasQuestion = body.includes("?");
    const readingTimeSec = Math.round((wordCount / 200) * 60);

    // Lavender-style heuristics
    let score = 95;
    const suggestions: { type: "critical" | "warning" | "positive"; message: string }[] = [];

    if (wordCount > 100) {
      score -= 15;
      suggestions.push({ type: "warning", message: `Length is ${wordCount} words. Keep cold emails between 50-90 words for highest reply rates.` });
    } else if (wordCount < 30) {
      score -= 10;
      suggestions.push({ type: "warning", message: "Email may be too brief to articulate value prop clearly." });
    } else {
      suggestions.push({ type: "positive", message: `Great email length (${wordCount} words). Optimal for mobile reading.` });
    }

    if (subject.split(/\s+/).length > 5) {
      score -= 10;
      suggestions.push({ type: "warning", message: "Subject line is longer than 5 words. Shorter subjects (2-4 words) get 31% higher open rates." });
    } else {
      suggestions.push({ type: "positive", message: "Subject line is punchy and conversational." });
    }

    if (!hasQuestion) {
      score -= 15;
      suggestions.push({ type: "critical", message: "Missing a low-friction call-to-action or open-ended question." });
    } else {
      suggestions.push({ type: "positive", message: "Clear call-to-action detected." });
    }

    if (/(synergy|game-changer|disruptive|cutting-edge|revolutionary)/i.test(body)) {
      score -= 10;
      suggestions.push({ type: "warning", message: "Contains sales buzzwords that lower credibility. Use plain human language." });
    }

    const mobilePreview = {
      subjectTruncated: subject.length > 35 ? subject.slice(0, 32) + "..." : subject,
      firstLinePreview: words.slice(0, 12).join(" ") + "...",
      isMobileFriendly: wordCount <= 90,
    };

    return c.json({
      score: Math.max(10, Math.min(100, score)),
      readingTimeSec,
      wordCount,
      charCount,
      mobilePreview,
      suggestions,
      grade: score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : "D",
    });
  }
);
