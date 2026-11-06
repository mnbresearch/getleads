import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "../lib/validate.js";
import { requireAuth, type Env } from "../middleware.js";
import { getDb, deals, eq, and, desc, sql } from "@prospex/db";
import { badRequest, notFound } from "../lib/errors.js";

export const dealsRoutes = new Hono<Env>();

dealsRoutes.use("*", requireAuth);

const DEAL_SCHEMA = z.object({
  name: z.string().min(1).max(200),
  companyId: z.string().uuid().optional().nullable(),
  leadId: z.string().uuid().optional().nullable(),
  stage: z.enum(["qualified", "discovery", "demo", "proposal", "negotiation", "won", "lost"]).default("qualified"),
  value: z.number().int().min(0).default(0),
  currency: z.string().min(1).max(10).default("USD"),
  probability: z.number().int().min(0).max(100).default(20),
  expectedCloseDate: z.string().optional().nullable(),
  notes: z.string().max(4000).optional().nullable(),
});

/** List all pipeline deals with Kanban stage groupings */
dealsRoutes.get("/", async (c) => {
  const auth = c.get("auth");
  const { db } = getDb();

  const allDeals = await db
    .select()
    .from(deals)
    .where(eq(deals.orgId, auth.org.id))
    .orderBy(desc(deals.updatedAt));

  // Compute stage aggregates
  const stages = ["qualified", "discovery", "demo", "proposal", "negotiation", "won", "lost"] as const;
  const stageSummaries = stages.map((s) => {
    const stageItems = allDeals.filter((d) => d.stage === s);
    const totalVal = stageItems.reduce((acc, curr) => acc + (curr.value || 0), 0);
    return {
      stage: s,
      count: stageItems.length,
      totalValue: totalVal,
    };
  });

  const totalPipeline = allDeals
    .filter((d) => d.stage !== "lost")
    .reduce((acc, curr) => acc + (curr.value || 0), 0);

  return c.json({
    deals: allDeals,
    stageSummaries,
    totalPipeline,
    currency: allDeals[0]?.currency || "USD",
  });
});

/** Create a new deal in the pipeline */
dealsRoutes.post("/", zValidator("json", DEAL_SCHEMA), async (c) => {
  const auth = c.get("auth");
  const body = c.req.valid("json");
  const { db } = getDb();

  // AI-assessed initial risk & recommended action
  let riskLevel = "low";
  let riskSummary = "Healthy progress across pipeline stage.";
  let aiNextBestAction = "Schedule initial technical discovery call.";

  if (body.value > 50000) {
    riskLevel = "medium";
    riskSummary = "High-value opportunity: ensure multi-threading with economic buyer.";
    aiNextBestAction = "Identify and engage secondary VP/C-level stakeholder.";
  }

  const [created] = await db
    .insert(deals)
    .values({
      orgId: auth.org.id,
      ownerUserId: auth.user?.id || null,
      name: body.name.trim(),
      companyId: body.companyId || null,
      leadId: body.leadId || null,
      stage: body.stage,
      value: body.value,
      currency: body.currency,
      probability: body.probability,
      expectedCloseDate: body.expectedCloseDate ? new Date(body.expectedCloseDate) : null,
      riskLevel,
      riskSummary,
      aiNextBestAction,
      notes: body.notes?.trim() || null,
    })
    .returning();

  return c.json(created, 201);
});

/** Update deal stage, value, or probability */
dealsRoutes.patch(
  "/:id",
  zValidator(
    "json",
    z.object({
      stage: z.enum(["qualified", "discovery", "demo", "proposal", "negotiation", "won", "lost"]).optional(),
      value: z.number().int().min(0).optional(),
      probability: z.number().int().min(0).max(100).optional(),
      expectedCloseDate: z.string().optional().nullable(),
      notes: z.string().max(4000).optional().nullable(),
      aiNextBestAction: z.string().optional().nullable(),
    })
  ),
  async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    const body = c.req.valid("json");
    const { db } = getDb();

    const existing = await db.query.deals.findFirst({
      where: and(eq(deals.id, id), eq(deals.orgId, auth.org.id)),
    });
    if (!existing) throw notFound("Deal not found");

    const patch: Partial<typeof deals.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (body.stage !== undefined) {
      patch.stage = body.stage;
      if (body.stage === "won") {
        patch.probability = 100;
        patch.riskLevel = "low";
        patch.aiNextBestAction = "Trigger onboarding sequence and handoff to Customer Success.";
      } else if (body.stage === "lost") {
        patch.probability = 0;
        patch.riskLevel = "high";
        patch.aiNextBestAction = "Add to nurture sequence for re-engagement in 90 days.";
      }
    }
    if (body.value !== undefined) patch.value = body.value;
    if (body.probability !== undefined) patch.probability = body.probability;
    if (body.notes !== undefined) patch.notes = body.notes;
    if (body.aiNextBestAction !== undefined) patch.aiNextBestAction = body.aiNextBestAction;
    if (body.expectedCloseDate !== undefined) {
      patch.expectedCloseDate = body.expectedCloseDate ? new Date(body.expectedCloseDate) : null;
    }

    const [updated] = await db
      .update(deals)
      .set(patch)
      .where(and(eq(deals.id, id), eq(deals.orgId, auth.org.id)))
      .returning();

    return c.json(updated);
  }
);
