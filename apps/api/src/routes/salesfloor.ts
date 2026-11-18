import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "../lib/validate.js";
import { requireAuth, type Env } from "../middleware.js";
import { getDb, salesfloorBlitzes, users, callLogs, eq, and, desc, gte } from "@prospex/db";

export const salesfloorRoutes = new Hono<Env>();

salesfloorRoutes.use("*", requireAuth);

/**
 * The salesfloor: this workspace's active blitz, its people, and today's real calls.
 *
 * It used to invent a blitz ("28 of 50 calls") when none was running, and a floor of reps
 * who do not exist ("Marcus Vance", "Elena Rostova") calling real companies. Now: the blitz
 * is null when none is running, the people are the workspace's members, and every number is
 * counted from call_logs since midnight UTC.
 */
salesfloorRoutes.get("/state", async (c) => {
  const auth = c.get("auth");
  const { db } = getDb();
  const blitz = (await db.query.salesfloorBlitzes.findFirst({
    where: and(eq(salesfloorBlitzes.orgId, auth.org.id), eq(salesfloorBlitzes.status, "active")),
    orderBy: desc(salesfloorBlitzes.startedAt),
  })) ?? null;
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const members = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.orgId, auth.org.id)).limit(50);
  const calls = await db
    .select({ userId: callLogs.userId, disposition: callLogs.disposition, createdAt: callLogs.createdAt })
    .from(callLogs)
    .where(and(eq(callLogs.orgId, auth.org.id), gte(callLogs.createdAt, midnight)))
    .orderBy(desc(callLogs.createdAt))
    .limit(500);
  const teamMembers = members.map((m) => {
    const mine = calls.filter((x) => x.userId === m.id);
    return { id: m.id, name: m.name || "Teammate", status: null, currentLead: null, callsToday: mine.length, meetingsToday: mine.filter((x) => x.disposition === "meeting_booked").length };
  });
  const nameOf = new Map(members.map((m) => [m.id, m.name || "Teammate"]));
  const recentMilestones = calls.slice(0, 10).map((x) => ({ rep: (x.userId && nameOf.get(x.userId)) || "Teammate", type: x.disposition === "meeting_booked" ? "meeting_booked" : "call_completed", company: null, time: x.createdAt }));
  return c.json({ blitz, teamMembers, recentMilestones, salesfloorOnlineCount: null, callsToday: calls.length });
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
