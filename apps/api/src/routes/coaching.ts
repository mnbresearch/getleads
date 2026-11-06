import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "../lib/validate.js";
import { requireAuth, type Env } from "../middleware.js";
import { getDb, coachingSessions, eq, and, desc } from "@prospex/db";

export const coachingRoutes = new Hono<Env>();

coachingRoutes.use("*", requireAuth);

const SIMULATED_PERSONAS = [
  {
    name: "Skeptical CFO",
    title: "Chief Financial Officer, Enterprise SaaS",
    scenario: "Evaluating software consolidation, strict ROI requirement, skeptical of AI buzzwords.",
    openingPrompt: "Thanks for calling, but we have a budget freeze on new point tools this quarter. What makes this any different from ZoomInfo or Apollo?",
  },
  {
    name: "Busy Founder / CEO",
    title: "Founder & CEO, Series B Fintech",
    scenario: "Has 2 minutes before a board call, values directness, metrics, and speed-to-pipeline.",
    openingPrompt: "Hey, I've got literally 90 seconds. Give me the elevator pitch—how does Scout get us qualified meetings this month?",
  },
  {
    name: "Head of Revenue Operations",
    title: "VP RevOps, Mid-Market E-commerce",
    scenario: "Frustrated with bad deliverability, bounced emails, and lack of CRM data synchronization.",
    openingPrompt: "We're currently struggling with domain reputation and low reply rates. How does Scout ensure our domain doesn't get burnt?",
  },
];

/** List available roleplay personas & past coaching sessions */
coachingRoutes.get("/personas", async (c) => {
  const auth = c.get("auth");
  const { db } = getDb();

  const conditions = [eq(coachingSessions.orgId, auth.org.id)];
  if (auth.user?.id) {
    conditions.push(eq(coachingSessions.userId, auth.user.id));
  }

  const pastSessions = await db
    .select()
    .from(coachingSessions)
    .where(and(...conditions))
    .orderBy(desc(coachingSessions.createdAt))
    .limit(20);

  return c.json({
    personas: SIMULATED_PERSONAS,
    pastSessions,
  });
});

/** Execute a roleplay turn against simulated buyer persona */
coachingRoutes.post(
  "/simulate-turn",
  zValidator(
    "json",
    z.object({
      personaName: z.string().min(1),
      repMessage: z.string().min(1).max(2000),
      history: z
        .array(
          z.object({
            role: z.enum(["rep", "persona"]),
            content: z.string(),
          })
        )
        .default([]),
    })
  ),
  async (c) => {
    const { personaName, repMessage, history } = c.req.valid("json");

    // Dynamic simulation logic tailored to persona objections
    let personaReply = "";
    let coachingTip = "";
    let score = 80;

    const lowerRep = repMessage.toLowerCase();
    if (personaName.includes("CFO")) {
      if (lowerRep.includes("roi") || lowerRep.includes("consolidat") || lowerRep.includes("cost") || lowerRep.includes("save")) {
        personaReply = "That's fair. Consolidating our data stack and visibility tracker into one license could save us ~$20k/yr. Can you walk me through implementation timing?";
        coachingTip = "Great job addressing financial consolidation directly.";
        score = 92;
      } else {
        personaReply = "That sounds like a standard feature list. What's the payback period, and will this replace our existing seat subscriptions?";
        coachingTip = "Tip: Anchor on hard cost reduction and replacement of redundant subscriptions.";
        score = 72;
      }
    } else if (personaName.includes("Founder")) {
      if (lowerRep.includes("intent") || lowerRep.includes("hiring") || lowerRep.includes("aeo") || lowerRep.includes("ai search")) {
        personaReply = "Interesting. The AEO tracking is something nobody else has shown us. Send me a calendar link for Tuesday morning.";
        coachingTip = "Strong pitch—highlighting the AEO/GEO differentiator caught their interest.";
        score = 95;
      } else {
        personaReply = "I hear pitches like this every week. What is the one metric your current customers see in week one?";
        coachingTip = "Tip: Open with a concrete customer metric (e.g. 4.2x reply rate with verifiable intent plays).";
        score = 75;
      }
    } else {
      personaReply = "The circuit breaker and deliverability ramp sound reassuring. Does it automatically log activity into HubSpot or Salesforce?";
      coachingTip = "Good technical positioning on email hygiene.";
      score = 88;
    }

    return c.json({
      personaReply,
      coachingTip,
      score,
    });
  }
);

/** Complete and save a coaching roleplay assessment */
coachingRoutes.post(
  "/complete",
  zValidator(
    "json",
    z.object({
      personaName: z.string().min(1),
      personaDescription: z.string(),
      scenario: z.string(),
      transcriptHistory: z.array(z.object({ role: z.string(), content: z.string() })),
      score: z.number().int().min(0).max(100),
      strengths: z.array(z.string()).default([]),
      improvements: z.array(z.string()).default([]),
      feedback: z.string(),
    })
  ),
  async (c) => {
    const auth = c.get("auth");
    const body = c.req.valid("json");
    const { db } = getDb();

    const userId = auth.user?.id || null;
    if (!userId) {
      return c.json({ error: "Authenticated user session required" }, 401);
    }

    const [saved] = await db
      .insert(coachingSessions)
      .values({
        orgId: auth.org.id,
        userId,
        personaName: body.personaName,
        personaDescription: body.personaDescription,
        scenario: body.scenario,
        transcriptHistory: body.transcriptHistory,
        score: body.score,
        strengths: body.strengths,
        improvements: body.improvements,
        feedback: body.feedback,
      })
      .returning();

    return c.json(saved, 201);
  }
);
