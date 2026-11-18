import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "../lib/validate.js";
import { requireAuth, type Env } from "../middleware.js";
import { getDb, callLogs, leads, companies, eq, and, desc, isNotNull, sql } from "@prospex/db";
import { notFound } from "../lib/errors.js";
import { assertOwned } from "../lib/ownership.js";

export const dialerRoutes = new Hono<Env>();

dialerRoutes.use("*", requireAuth);

/**
 * The calling queue: this workspace's leads that have a phone number, best fit first.
 *
 * It used to list any 30 leads, give each one without a number an invented
 * "+1 (555) 019-xxxx", name every company "Target Enterprise", default the score to 85 and
 * open every call with "...from Scout" - the customer's rep pitching our product to their
 * prospect. A lead with no number is not callable, so it is not in the queue; the talk track
 * names the rep and the workspace, and the battlecards are generic and editable in the call.
 */
dialerRoutes.get("/queue", async (c) => {
  const auth = c.get("auth");
  const { db } = getDb();
  const rows = await db
    .select({
      id: leads.id,
      firstName: leads.firstName,
      lastName: leads.lastName,
      phone: leads.phone,
      title: leads.title,
      score: leads.score,
      companyName: companies.name,
    })
    .from(leads)
    .leftJoin(companies, eq(companies.id, leads.companyId))
    .where(and(eq(leads.orgId, auth.org.id), isNotNull(leads.phone), sql`trim(${leads.phone}) <> ''`))
    .orderBy(desc(leads.score))
    .limit(30);
  const rep = auth.user?.name?.split(" ")[0] || "your rep";
  const items = rows.map((l) => ({
    id: l.id,
    name: [l.firstName, l.lastName].filter(Boolean).join(" ") || "Unnamed contact",
    title: l.title ?? null,
    phone: l.phone,
    companyName: l.companyName ?? null,
    priorityScore: l.score ?? null,
    status: "ready",
    aiTalkTrack: {
      opener: `Hi ${l.firstName || "there"}, this is ${rep} from ${auth.org.name}. I'm calling because ${l.companyName ? `of what ${l.companyName} is working on` : "of what your team is working on"}, and I'd like to ask two quick questions to see if it's worth a proper conversation.`,
      discoveryQuestions: [
        "How does your team decide which accounts to work on each week?",
        "What would have to be true for you to change how you do that this quarter?",
      ],
      objectionBattlecards: [
        { objection: "We already have a tool for this", counter: "Makes sense. What does it not do that you wish it did? If the answer is nothing, I'll let you go." },
        { objection: "Send me an email first", counter: "Happy to. So it's relevant: is this a priority this quarter, or later in the year?" },
      ],
    },
  }));
  return c.json({ queue: items, totalCallable: items.length, telephonyProvider: "Your phone (tel: link). Scout does not carry the call.", mode: "click_to_dial" });
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

    // The call belongs to this workspace's own lead, or to none.
    await assertOwned(leads, body.leadId, auth.org.id, "Lead", c);
    // What the rep recorded, and nothing more. This used to write "Expressed high interest in
    // AEO/GEO tracking" (our own product) on every booked meeting, a 45% talk ratio and the
    // objections "Timing" and "Existing vendor" for calls nobody had analysed.
    const sentiment = body.disposition === "meeting_booked" || body.disposition === "interested" ? "positive" : body.disposition === "not_interested" ? "negative" : "neutral";
    const summary = `Outcome: ${body.disposition.replace(/_/g, " ")}.${body.notes?.trim() ? ` Notes: ${body.notes.trim()}` : ""}`;
    const nextSteps = body.disposition === "meeting_booked" ? "Send the calendar invite and agenda." : body.disposition === "follow_up" ? "Follow up in a few days." : null;

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
        talkToListenRatio: null,
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
