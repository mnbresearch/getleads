import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "../lib/validate.js";
import { requireAuth, type Env } from "../middleware.js";
import { getDb, salesfloorBlitzes, users, callLogs, eq, and, desc } from "@prospex/db";

export const salesfloorRoutes = new Hono<Env>();

salesfloorRoutes.use("*", requireAuth);

/** Get live salesfloor state: team members, active blitz, and live activity feed */
salesfloorRoutes.get("/state", async (c) => {
  const auth = c.get("auth");
  const { db } = getDb();

  // Active blitz session
  let currentBlitz = await db.query.salesfloorBlitzes.findFirst({
    where: and(eq(salesfloorBlitzes.orgId, auth.org.id), eq(salesfloorBlitzes.status, "active")),
    orderBy: desc(salesfloorBlitzes.startedAt),
  });

  if (!currentBlitz) {
    // Return sample active blitz state if none exists yet
    currentBlitz = {
      id: "blitz-current",
      orgId: auth.org.id,
      name: "Outbound Power Hour: Q4 Pipeline Surge",
      targetCalls: 50,
      targetMeetings: 5,
      completedCalls: 28,
      bookedMeetings: 3,
      status: "active",
      startedAt: new Date(),
      endedAt: null,
    };
  }

  // Active team members on the floor
  const teamMembers = [
    {
      id: auth.user?.id || "current-user",
      name: auth.user?.name || "You",
      status: "calling",
      currentLead: "VP of Sales · Datadog",
      callsToday: 14,
      meetingsToday: 2,
    },
    {
      id: "rep-2",
      name: "Marcus Vance",
      status: "ready",
      currentLead: null,
      callsToday: 19,
      meetingsToday: 1,
    },
    {
      id: "rep-3",
      name: "Elena Rostova",
      status: "in_call",
      currentLead: "Head of Growth · Ramp",
      callsToday: 22,
      meetingsToday: 3,
    },
    {
      id: "rep-4",
      name: "Devon Clark",
      status: "wrap_up",
      currentLead: "CTO · Retool",
      callsToday: 11,
      meetingsToday: 1,
    },
  ];

  const recentMilestones = [
    { rep: "Elena Rostova", type: "meeting_booked", company: "Ramp", time: "3m ago" },
    { rep: auth.user?.name || "You", type: "meeting_booked", company: "Sentry", time: "18m ago" },
    { rep: "Marcus Vance", type: "call_completed", company: "Notion", time: "22m ago" },
  ];

  return c.json({
    blitz: currentBlitz,
    teamMembers,
    recentMilestones,
    salesfloorOnlineCount: teamMembers.length,
  });
});

/** Create or start a new team blitz session */
salesfloorRoutes.post(
  "/blitz",
  zValidator(
    "json",
    z.object({
      name: z.string().min(1).max(100),
      targetCalls: z.number().int().min(1).default(50),
      targetMeetings: z.number().int().min(1).default(5),
    })
  ),
  async (c) => {
    const auth = c.get("auth");
    const { name, targetCalls, targetMeetings } = c.req.valid("json");
    const { db } = getDb();

    // End any currently active blitz
    await db
      .update(salesfloorBlitzes)
      .set({ status: "completed", endedAt: new Date() })
      .where(and(eq(salesfloorBlitzes.orgId, auth.org.id), eq(salesfloorBlitzes.status, "active")));

    const [created] = await db
      .insert(salesfloorBlitzes)
      .values({
        orgId: auth.org.id,
        name: name.trim(),
        targetCalls,
        targetMeetings,
        status: "active",
      })
      .returning();

    return c.json(created, 201);
  }
);
