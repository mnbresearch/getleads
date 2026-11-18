import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "../lib/validate.js";
import { notFound } from "../lib/errors.js";
import { orgId, rateLimit, requireAuth, type Env } from "../middleware.js";
import { getDb, buyingCommittees, digitalSalesRooms, autonomousGtmCampaigns, organizations, eq, desc } from "@prospex/db";
import { randomBytes } from "node:crypto";

/**
 * Buying committees, digital sales rooms and GTM campaigns.
 *
 * Every list here used to fall back to invented rows when the workspace had none: a "ScaleAI"
 * evaluation hub, a "Ramp Financial" committee whose stakeholders carried @ramp.com addresses
 * nobody had checked, a GTM campaign with $640,000 of pipeline, and fixed percentages under
 * the word "stats". A customer opening an empty workspace was shown other companies' names
 * as their own data. Each route now returns this workspace's rows and figures computed from
 * them, and nothing else.
 */
export const moatRoutes = new Hono<Env>();

/** What a buyer holding the link may see. Never the org id, the deal, the champion's address or the token itself. */
export function publicRoom(room: typeof digitalSalesRooms.$inferSelect, preparedBy: string | null = null) {
  return {
    preparedBy,
    title: room.title,
    targetCompany: room.targetCompany,
    status: room.status,
    championName: room.championName,
    targetGoLiveDate: room.targetGoLiveDate,
    milestones: room.milestones ?? [],
    artifacts: room.artifacts ?? [],
  };
}

// Public route for a Digital Sales Room: the token in the URL is the credential.
export const publicDsrRoute = new Hono();
publicDsrRoute.get("/room/:token", rateLimit({ perMinute: 60, name: "dsr-public" }), async (c) => {
  const token = c.req.param("token");
  // An unknown link used to answer 200 with an invented "ScaleAI" room. It is a 404 now, the
  // same answer whether the token never existed or the room was deleted.
  if (!/^dsr-[a-f0-9]{12,64}$/.test(token)) throw notFound("Room");
  const { db } = getDb();
  const [room] = await db.select().from(digitalSalesRooms).where(eq(digitalSalesRooms.shareToken, token)).limit(1);
  if (!room || room.status === "archived") throw notFound("Room");
  await db
    .update(digitalSalesRooms)
    .set({ viewsCount: (room.viewsCount || 0) + 1, lastViewedAt: new Date() })
    .where(eq(digitalSalesRooms.id, room.id));
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, room.orgId), columns: { name: true } });
  return c.json({ room: publicRoom(room, org?.name ?? null) });
});

// Authenticated Routes
moatRoutes.use("*", requireAuth);

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : null);

/** Buying committees: this workspace's, with coverage computed from the stakeholders it recorded. */
moatRoutes.get("/committees", async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const committees = await db.select().from(buyingCommittees).where(eq(buyingCommittees.orgId, oid)).orderBy(desc(buyingCommittees.updatedAt));
  const coverage = committees.map((x) => x.coverageScore).filter((v): v is number => typeof v === "number");
  return c.json({
    committees,
    summary: {
      totalAccountsTracked: committees.length,
      singleThreadedAtRisk: committees.filter((x) => x.healthStatus === "single_threaded").length,
      avgCommitteeCoverage: coverage.length ? Math.round(coverage.reduce((a, b) => a + b, 0) / coverage.length) : null,
    },
  });
});

/** Digital Sales Rooms (mutual action plans): this workspace's rooms. */
moatRoutes.get("/rooms", async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const rooms = await db.select().from(digitalSalesRooms).where(eq(digitalSalesRooms.orgId, oid)).orderBy(desc(digitalSalesRooms.updatedAt));
  const steps = rooms.flatMap((r) => r.milestones ?? []);
  return c.json({
    rooms,
    stats: {
      activeRooms: rooms.filter((r) => r.status === "active").length,
      avgMilestoneCompletion: pct(steps.filter((m) => m.completed).length, steps.length),
      roomsViewed: rooms.filter((r) => (r.viewsCount ?? 0) > 0).length,
    },
  });
});

moatRoutes.post(
  "/rooms",
  zValidator(
    "json",
    z.object({
      title: z.string().min(2).max(200),
      targetCompany: z.string().min(2).max(200),
      championName: z.string().max(200).optional(),
      championEmail: z.string().email().max(320).optional(),
    }),
  ),
  async (c) => {
    const oid = orgId(c);
    const body = c.req.valid("json");
    const { db } = getDb();
    // 128 bits: the link is the only thing that stands between a buyer's room and the web.
    const shareToken = "dsr-" + randomBytes(16).toString("hex");
    const defaultMilestones = [
      { id: "m1", title: "Problem discovery and business case", owner: "mutual" as const, assignedTo: body.championName || "Champion", dueDate: "Week 1", completed: false, status: "pending" as const },
      { id: "m2", title: "Technical and security review", owner: "seller" as const, assignedTo: "Your team", dueDate: "Week 2", completed: false, status: "pending" as const },
      { id: "m3", title: "Pilot and onboarding", owner: "mutual" as const, assignedTo: "Both teams", dueDate: "Week 3", completed: false, status: "pending" as const },
      { id: "m4", title: "Approval and go-live", owner: "buyer" as const, assignedTo: "Economic buyer", dueDate: "Week 4", completed: false, status: "pending" as const },
    ];
    const [newRoom] = await db
      .insert(digitalSalesRooms)
      .values({ orgId: oid, title: body.title, targetCompany: body.targetCompany, championName: body.championName, championEmail: body.championEmail, shareToken, status: "active", milestones: defaultMilestones })
      .returning();
    return c.json({ room: newRoom });
  },
);

/** Goal-driven GTM campaigns: this workspace's, with totals summed from them. */
moatRoutes.get("/gtm-campaigns", async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const campaigns = await db.select().from(autonomousGtmCampaigns).where(eq(autonomousGtmCampaigns.orgId, oid)).orderBy(desc(autonomousGtmCampaigns.updatedAt));
  const sum = (k: "pipelineGeneratedUsd" | "targetAccountCount" | "meetingsBooked") => campaigns.reduce((a, x) => a + (Number(x[k]) || 0), 0);
  return c.json({
    campaigns,
    summary: {
      totalCampaigns: campaigns.length,
      totalPipelineGenerated: sum("pipelineGeneratedUsd"),
      totalAccountsTargeted: sum("targetAccountCount"),
      totalMeetingsBooked: sum("meetingsBooked"),
    },
  });
});
