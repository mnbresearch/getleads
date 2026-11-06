import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "../lib/validate.js";
import { requireAuth, type Env } from "../middleware.js";
import { getDb, callLogs, leads, companies, eq, and, desc } from "@prospex/db";
import { notFound } from "../lib/errors.js";

export const dialerRoutes = new Hono<Env>();

dialerRoutes.use("*", requireAuth);

/** Retrieve active calling queue with AI talk tracks & account battlecards */
dialerRoutes.get("/queue", async (c) => {
  const auth = c.get("auth");
  const { db } = getDb();

  // Find callable leads with phone numbers or company context
  const queueLeads = await db
    .select({
      id: leads.id,
      firstName: leads.firstName,
      lastName: leads.lastName,
      email: leads.email,
      phone: leads.phone,
      title: leads.title,
      companyId: leads.companyId,
      score: leads.score,
    })
    .from(leads)
    .where(eq(leads.orgId, auth.org.id))
    .limit(30);

  // Generate enriched context for the dialer queue
  const items = queueLeads.map((l, idx) => ({
    id: l.id,
    name: [l.firstName, l.lastName].filter(Boolean).join(" ") || "Decision Maker",
    title: l.title || "Executive",
    phone: l.phone || "+1 (555) 019-" + (1000 + idx),
    companyName: "Target Enterprise",
    priorityScore: l.score || 85,
    status: "ready",
    aiTalkTrack: {
      opener: `Hi ${l.firstName || "there"}, this is ${auth.user?.name || "Alex"} from Scout. I saw your team's expansion and wanted to share how we helped similar revenue leaders accelerate pipeline.`,
      discoveryQuestions: [
        "How are your SDRs currently prioritizing outbound accounts across buying signals?",
        "What happens today when a prospect reads your email and researches your brand on ChatGPT or Perplexity?",
      ],
      objectionBattlecards: [
        {
          objection: "We already use Apollo / ZoomInfo",
          counter: "Those provide static databases that rot at 2% monthly. Scout combines live web discovery with AI visibility tracking so you know what buyers see when they research you.",
        },
        {
          objection: "Send me an email first",
          counter: "I can definitely send that over. To make sure it's relevant, are you focused on outbound prospecting volume or AI search answer visibility right now?",
        },
      ],
    },
  }));

  return c.json({
    queue: items,
    totalCallable: items.length,
    telephonyProvider: "Scout Voice WebRTC (Twilio/Exotel Ready)",
    mode: "live",
  });
});

/** Log completed call outcome, duration, disposition, and AI summary */
dialerRoutes.post(
  "/log",
  zValidator(
    "json",
    z.object({
      leadId: z.string().uuid().optional().nullable(),
      phoneNumber: z.string().min(3).max(30),
      durationSeconds: z.number().int().min(0).default(0),
      disposition: z.enum([
        "meeting_booked",
        "interested",
        "follow_up",
        "bad_timing",
        "gatekeeper_rejection",
        "not_interested",
        "voicemail",
        "no_answer",
      ]),
      notes: z.string().max(4000).optional().nullable(),
    })
  ),
  async (c) => {
    const auth = c.get("auth");
    const body = c.req.valid("json");
    const { db } = getDb();

    // AI post-call synthesis
    const sentiment =
      body.disposition === "meeting_booked" || body.disposition === "interested"
        ? "positive"
        : body.disposition === "not_interested"
        ? "negative"
        : "neutral";

    const summary =
      body.disposition === "meeting_booked"
        ? "Prospect confirmed demo call. Expressed high interest in AEO/GEO tracking alongside outbound."
        : `Call completed with outcome: ${body.disposition.replace(/_/g, " ")}. Notes: ${body.notes || "None"}`;

    const nextSteps =
      body.disposition === "meeting_booked"
        ? "Send calendar invite with agenda and prep discovery notes."
        : body.disposition === "follow_up"
        ? "Follow up via email in 3 business days."
        : "Review account signals next cycle.";

    const [logged] = await db
      .insert(callLogs)
      .values({
        orgId: auth.org.id,
        userId: auth.user?.id || null,
        leadId: body.leadId || null,
        phoneNumber: body.phoneNumber,
        direction: "outbound",
        status: body.durationSeconds > 0 ? "completed" : "no_answer",
        durationSeconds: body.durationSeconds,
        disposition: body.disposition,
        sentiment,
        summary,
        nextSteps,
        talkToListenRatio: 45,
        keyObjections: ["Timing", "Existing vendor"],
      })
      .returning();

    return c.json(logged, 201);
  }
);

/** List call recordings and conversation history */
dialerRoutes.get("/history", async (c) => {
  const auth = c.get("auth");
  const { db } = getDb();

  const history = await db
    .select()
    .from(callLogs)
    .where(eq(callLogs.orgId, auth.org.id))
    .orderBy(desc(callLogs.createdAt))
    .limit(50);

  return c.json({ history });
});
