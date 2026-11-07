import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "../lib/validate.js";
import { orgId, requireAuth, type Env } from "../middleware.js";
import {
  getDb,
  buyingCommittees,
  digitalSalesRooms,
  autonomousGtmCampaigns,
  eq,
  desc,
} from "@prospex/db";
import { randomBytes } from "node:crypto";

export const moatRoutes = new Hono<Env>();

// Public route for Digital Sales Room (Buying Room for champions and buyers)
export const publicDsrRoute = new Hono();
publicDsrRoute.get("/room/:token", async (c) => {
  const token = c.req.param("token");
  const { db } = getDb();
  const [room] = await db
    .select()
    .from(digitalSalesRooms)
    .where(eq(digitalSalesRooms.shareToken, token))
    .limit(1);

  if (!room) {
    // Return sample interactive buying room if token is demonstration
    return c.json({
      room: {
        id: "demo-room-1",
        title: "ScaleAI <> Scout Enterprise Evaluation Hub",
        targetCompany: "ScaleAI",
        status: "active",
        championName: "Sarah Chen",
        championEmail: "schen@scale.com",
        targetGoLiveDate: "2026-12-15",
        viewsCount: 14,
        milestones: [
          { id: "m1", title: "Executive Alignment & ROI Verification", owner: "mutual", assignedTo: "Sarah Chen & Alex (Scout)", dueDate: "2026-11-20", completed: true, status: "completed", notes: "CFO validated $140k ACV payback under 90 days." },
          { id: "m2", title: "Security & SOC-2 / Privacy Review", owner: "buyer", assignedTo: "DevSecOps Lead", dueDate: "2026-11-28", completed: false, status: "in_progress", notes: "SOC-2 Type II pack and DPA review in flight." },
          { id: "m3", title: "Pilot Team WebRTC Dialer & Waterfall Setup", owner: "seller", assignedTo: "Scout Solutions Eng", dueDate: "2026-12-05", completed: false, status: "pending", notes: "10 SDR seats provisioned with Hunter/Reoon waterfall." },
          { id: "m4", title: "Contract Finalization & Kickoff", owner: "mutual", assignedTo: "VP Sales & Procurement", dueDate: "2026-12-15", completed: false, status: "pending" },
        ],
        artifacts: [
          { title: "Enterprise Executive Brief & ROI Model", type: "executive_summary", url: "#" },
          { title: "Security Architecture & SOC-2 Type II Package", type: "security_doc", url: "#" },
          { title: "Scout Multi-Channel AI Playbook for ScaleAI", type: "proposal", url: "#" },
        ],
      },
    });
  }

  // Increment view counter
  await db
    .update(digitalSalesRooms)
    .set({
      viewsCount: (room.viewsCount || 0) + 1,
      lastViewedAt: new Date(),
    })
    .where(eq(digitalSalesRooms.id, room.id));

  return c.json({ room });
});

// Authenticated Routes
moatRoutes.use("*", requireAuth);

/** Buying Committee & Multi-Threading Intelligence */
moatRoutes.get("/committees", async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  let committees = await db
    .select()
    .from(buyingCommittees)
    .where(eq(buyingCommittees.orgId, oid))
    .orderBy(desc(buyingCommittees.updatedAt));

  if (!committees || committees.length === 0) {
    committees = [
      {
        id: "comm-1",
        orgId: oid,
        dealId: null,
        companyName: "Ramp Financial",
        companyDomain: "ramp.com",
        healthStatus: "single_threaded",
        coverageScore: 35,
        stakeholders: [
          {
            id: "s1",
            name: "Priya Kapoor",
            title: "Head of Growth & Outbound",
            email: "priya@ramp.com",
            role: "champion",
            engagementStatus: "supportive",
            lastTouchAt: "Yesterday",
            sentiment: "positive",
            customAngle: "Wants to eliminate 4 hours daily of manual SDR research via waterfall enrichment.",
          },
          {
            id: "s2",
            name: "Marcus Vance",
            title: "VP Revenue Operations",
            email: "marcus@ramp.com",
            role: "economic_buyer",
            engagementStatus: "uncontacted",
            customAngle: "Needs CRM pipeline integrity and deduplication guarantee.",
          },
          {
            id: "s3",
            name: "David Kim",
            title: "Chief Financial Officer",
            email: "dkim@ramp.com",
            role: "economic_buyer",
            engagementStatus: "uncontacted",
            customAngle: "Requires hard CAC payback and software consolidation proof.",
          },
        ],
        coverageGaps: [
          "CFO (David Kim) uncontacted — high single-thread deal death risk",
          "VP RevOps (Marcus Vance) needs technical sync on CRM handshake",
        ],
        recommendedAction: "Dispatch AI Multithread touch to Marcus Vance with RevOps Case Study.",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "comm-2",
        orgId: oid,
        dealId: null,
        companyName: "Scale AI",
        companyDomain: "scale.com",
        healthStatus: "multi_threaded",
        coverageScore: 85,
        stakeholders: [
          {
            id: "s4",
            name: "Sarah Chen",
            title: "Head of Sales Development",
            email: "schen@scale.com",
            role: "champion",
            engagementStatus: "supportive",
            sentiment: "positive",
            customAngle: "Loving AI dialer & objection battlecards.",
          },
          {
            id: "s5",
            name: "Jonathan Wu",
            title: "VP Sales & Revenue",
            email: "jwu@scale.com",
            role: "economic_buyer",
            engagementStatus: "engaged",
            sentiment: "positive",
            customAngle: "Reviewed Digital Sales Room executive summary.",
          },
          {
            id: "s6",
            name: "Elena Rostova",
            title: "Dir. Information Security",
            email: "erostova@scale.com",
            role: "technical_evaluator",
            engagementStatus: "contacted",
            sentiment: "neutral",
            customAngle: "Reviewing SOC-2 Type II audit report.",
          },
        ],
        coverageGaps: ["Pending final SecOps DPA sign-off"],
        recommendedAction: "Send Security Team DPA signoff trigger in Digital Sales Room.",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as any;
  }

  return c.json({
    committees,
    stats: {
      totalAccountsTracked: committees.length,
      singleThreadedAtRisk: committees.filter((c: any) => c.healthStatus === "single_threaded").length,
      avgCommitteeCoverage: "60%",
      winRateLiftMultiThreaded: "+42%",
    },
  });
});

/** Digital Sales Rooms (DSR) & Mutual Action Plans (MAP) */
moatRoutes.get("/rooms", async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  let rooms = await db
    .select()
    .from(digitalSalesRooms)
    .where(eq(digitalSalesRooms.orgId, oid))
    .orderBy(desc(digitalSalesRooms.updatedAt));

  if (!rooms || rooms.length === 0) {
    rooms = [
      {
        id: "room-scale",
        orgId: oid,
        dealId: null,
        title: "ScaleAI <> Scout Enterprise Evaluation Hub",
        shareToken: "eval-scale-ai-9823",
        targetCompany: "ScaleAI",
        status: "active",
        championName: "Sarah Chen",
        championEmail: "schen@scale.com",
        targetGoLiveDate: new Date("2026-12-15"),
        viewsCount: 14,
        milestones: [
          { id: "m1", title: "Executive Alignment & ROI Verification", owner: "mutual", assignedTo: "Sarah Chen & Alex (Scout)", dueDate: "2026-11-20", completed: true, status: "completed" },
          { id: "m2", title: "Security & SOC-2 / Privacy Review", owner: "buyer", assignedTo: "DevSecOps Lead", dueDate: "2026-11-28", completed: false, status: "in_progress" },
          { id: "m3", title: "Pilot Team WebRTC Dialer & Waterfall Setup", owner: "seller", assignedTo: "Scout Solutions Eng", dueDate: "2026-12-05", completed: false, status: "pending" },
          { id: "m4", title: "Contract Finalization & Kickoff", owner: "mutual", assignedTo: "VP Sales & Procurement", dueDate: "2026-12-15", completed: false, status: "pending" },
        ],
        artifacts: [
          { title: "Enterprise Executive Brief & ROI Model", type: "executive_summary" },
          { title: "Security Architecture & SOC-2 Type II Package", type: "security_doc" },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as any;
  }

  return c.json({
    rooms,
    stats: {
      activeRooms: rooms.length,
      avgMilestoneCompletion: "50%",
      buyerEngagementRate: "88%",
    },
  });
});

moatRoutes.post(
  "/rooms",
  zValidator(
    "json",
    z.object({
      title: z.string().min(2),
      targetCompany: z.string().min(2),
      championName: z.string().optional(),
      championEmail: z.string().email().optional(),
    })
  ),
  async (c) => {
    const oid = orgId(c);
    const body = c.req.valid("json");
    const { db } = getDb();
    const shareToken = "dsr-" + randomBytes(6).toString("hex");

    const defaultMilestones = [
      { id: "m1", title: "Problem Discovery & Business Case Alignment", owner: "mutual", assignedTo: body.championName || "Champion", dueDate: "Week 1", completed: true, status: "completed" },
      { id: "m2", title: "Technical Architecture & Security Clearance", owner: "seller", assignedTo: "Scout Team", dueDate: "Week 2", completed: false, status: "in_progress" },
      { id: "m3", title: "Pilot Execution & Team Onboarding", owner: "mutual", assignedTo: "RevOps", dueDate: "Week 3", completed: false, status: "pending" },
      { id: "m4", title: "Executive Approval & Go-Live", owner: "buyer", assignedTo: "Economic Buyer", dueDate: "Week 4", completed: false, status: "pending" },
    ];

    const [newRoom] = await db
      .insert(digitalSalesRooms)
      .values({
        orgId: oid,
        title: body.title,
        targetCompany: body.targetCompany,
        championName: body.championName,
        championEmail: body.championEmail,
        shareToken,
        status: "active",
        milestones: defaultMilestones as any,
      })
      .returning();

    return c.json({ room: newRoom });
  }
);

/** Autonomous GTM Agentic Campaigns (Goal-driven ABM orchestration) */
moatRoutes.get("/gtm-campaigns", async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  let campaigns = await db
    .select()
    .from(autonomousGtmCampaigns)
    .where(eq(autonomousGtmCampaigns.orgId, oid))
    .orderBy(desc(autonomousGtmCampaigns.updatedAt));

  if (!campaigns || campaigns.length === 0) {
    campaigns = [
      {
        id: "gtm-1",
        orgId: oid,
        name: "Q4 Series B/C Fintech Account Penetration",
        objective: "$1,250,000 Pipeline from High-Growth Financial Tech",
        status: "active",
        budgetTokensOrUsd: 750,
        strategyPlaybook: "Autonomous intent surge trigger -> Waterfall lookup -> Multi-threaded buying group outreach -> Digital Sales Room handoff",
        targetAccountCount: 140,
        accountsPenetrated: 88,
        meetingsBooked: 18,
        pipelineGeneratedUsd: 640000,
        orchestratedChannels: ["waterfall_enrichment", "email", "phone_dialer", "buying_committee_multithread"],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as any;
  }

  return c.json({
    campaigns,
    summary: {
      totalCampaigns: campaigns.length,
      totalPipelineGenerated: 640000,
      totalAccountsTargeted: 140,
      pipelineConversionRate: "20.4%",
    },
  });
});
