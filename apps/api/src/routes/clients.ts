import { Hono } from "hono";
import { zValidator } from "../lib/validate.js";
import { z } from "zod";
import { and, clients, enqueue, eq, getDb, getUsage, listLeads, lists, organizations } from "@prospex/db";
import { orgId, rateLimit, requireAuth, type Env } from "../middleware.js";
import { ApiError, notFound } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { ownerOrAdmin } from "../lib/roles.js";
import {
  assignLeads,
  attentionLeadIds,
  autoRoute,
  clientDetail,
  clientOverview,
  createClient,
  deleteClient,
  disableSharing,
  enableSharing,
  publicReport,
  requireClient,
  routeSuggestions,
  unassignLeads,
  updateClient,
} from "../services/clients.js";

/**
 * Client workspaces. See services/clients.ts for the rules this enforces.
 *
 * Route order matters in Hono: the fixed paths (/routing, /unassign, /pool/...) are declared
 * before /:id so they are never captured as an id.
 */
export const clientRoutes = new Hono<Env>();
clientRoutes.use("*", requireAuth);

const clientInput = z.object({
  name: z.string().trim().min(1).max(120),
  domain: z.string().max(253).nullish(),
  industry: z.string().max(120).nullish(),
  status: z.enum(["active", "paused", "archived"]).optional(),
  // A CSS hex colour, nothing else: it is rendered into a style attribute.
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
  icpId: z.string().uuid().nullish(),
  monthlyLeadTarget: z.number().int().min(0).max(1_000_000).nullish(),
  notes: z.string().max(5000).nullish(),
  reportShowTarget: z.boolean().optional(),
});

const leadIdsInput = z.object({ leadIds: z.array(z.string().uuid()).min(1).max(5000) });
const BUCKETS = ["noEmail", "unverified", "badEmail", "readyButIdle"] as const;

clientRoutes.get("/", zValidator("query", z.object({ includeArchived: z.enum(["true", "false"]).optional() })), async (c) =>
  c.json(await clientOverview(orgId(c), { includeArchived: c.req.valid("query").includeArchived === "true" })),
);

clientRoutes.post("/", zValidator("json", clientInput), async (c) => {
  const created = await createClient(orgId(c), c.req.valid("json"));
  await audit(c, "client.created", { targetType: "client", targetId: created.id, data: { name: created.name } });
  return c.json(created, 201);
});

// ── Pool routing ──
clientRoutes.get("/routing", zValidator("query", z.object({ limit: z.coerce.number().min(1).max(1000).default(200) })), async (c) =>
  c.json(await routeSuggestions(orgId(c), { limit: c.req.valid("query").limit })),
);

clientRoutes.post(
  "/routing/auto",
  rateLimit({ perMinute: 6 }),
  zValidator("json", z.object({ limit: z.number().int().min(1).max(1000).default(500), leadIds: z.array(z.string().uuid()).max(1000).optional() })),
  async (c) => {
    const b = c.req.valid("json");
    return c.json(await autoRoute(orgId(c), { limit: b.leadIds ? Math.max(b.leadIds.length, 1) : b.limit, leadIds: b.leadIds }));
  },
);

clientRoutes.post("/unassign", zValidator("json", leadIdsInput), async (c) => c.json(await unassignLeads(orgId(c), c.req.valid("json").leadIds)));

/** The unassigned pool's own attention buckets, with the same actions a client has. */
clientRoutes.post(
  "/pool/act",
  rateLimit({ perMinute: 10 }),
  zValidator("json", z.object({ bucket: z.enum(BUCKETS), action: z.enum(["enrich", "verify"]) })),
  async (c) => {
    const b = c.req.valid("json");
    return c.json(await act(orgId(c), null, b.bucket, b.action));
  },
);

// ── One client ──
clientRoutes.get("/:id", async (c) => c.json(await clientDetail(orgId(c), c.req.param("id"))));

clientRoutes.patch("/:id", zValidator("json", clientInput.partial()), async (c) => {
  const patch = c.req.valid("json");
  // What the client-facing report shows is part of the share settings, which are owner/admin
  // only; a member could otherwise change the report through this general edit route.
  const role = c.get("auth")?.user?.role;
  if ((patch as { reportShowTarget?: unknown }).reportShowTarget !== undefined && role && role !== "owner" && role !== "admin") {
    await audit(c, "client.report_settings_changed", { result: "denied", targetType: "client", targetId: c.req.param("id"), data: { reason: "role", role } });
    throw new ApiError(403, `Only a workspace owner or admin can change what the client report shows. Your role is "${role}" - ask an owner or admin.`, "forbidden_role");
  }
  return c.json(await updateClient(orgId(c), c.req.param("id"), patch));
});

clientRoutes.delete("/:id", async (c) => {
  const before = await requireClient(orgId(c), c.req.param("id"));
  const r = await deleteClient(orgId(c), c.req.param("id"));
  await audit(c, "client.deleted", { targetType: "client", targetId: before.id, data: { name: before.name, leadsReturnedToPool: r.leadsReturnedToPool, hadShareLink: !!before.shareToken } });
  return c.json(r);
});

clientRoutes.post("/:id/assign", zValidator("json", leadIdsInput.extend({ move: z.boolean().default(false) })), async (c) => {
  const b = c.req.valid("json");
  return c.json(await assignLeads(orgId(c), c.req.param("id"), b.leadIds, { move: b.move }));
});

clientRoutes.get("/:id/attention/:bucket", async (c) => {
  const bucket = c.req.param("bucket") as (typeof BUCKETS)[number];
  if (!BUCKETS.includes(bucket)) throw notFound("Bucket");
  await requireClient(orgId(c), c.req.param("id"));
  const r = await attentionLeadIds(orgId(c), c.req.param("id"), bucket);
  return c.json({ leadIds: r.ids, total: r.total });
});

/**
 * Act on an attention bucket in one click.
 *
 * Every action here is one that recovers value from a lead rather than discarding it:
 * enrich finds the missing (or a correct replacement) address, verify checks an unchecked
 * one, and "list" gathers ready-but-idle leads into a list a campaign can be pointed at.
 */
clientRoutes.post(
  "/:id/act",
  rateLimit({ perMinute: 10 }),
  zValidator("json", z.object({ bucket: z.enum(BUCKETS), action: z.enum(["enrich", "verify", "list"]) })),
  async (c) => {
    const b = c.req.valid("json");
    await requireClient(orgId(c), c.req.param("id"));
    return c.json(await act(orgId(c), c.req.param("id"), b.bucket, b.action));
  },
);

// ── Sharing ──
// Owner/admin only. A share link is an unauthenticated, forwardable view of a client's
// pipeline; turning one on (or replacing it) is publishing data outside the workspace, and
// each change is on the audit trail. The token itself is never written there.
clientRoutes.post("/:id/share", ownerOrAdmin("client.share_enabled"), async (c) => {
  const before = await requireClient(orgId(c), c.req.param("id"));
  const r = await enableSharing(orgId(c), c.req.param("id"));
  // POST on a client that already has a link replaces it: the old link stops working.
  await audit(c, before.shareToken ? "client.share_rotated" : "client.share_enabled", { targetType: "client", targetId: before.id, data: { name: before.name } });
  return c.json(r);
});
clientRoutes.delete("/:id/share", ownerOrAdmin("client.share_disabled"), async (c) => {
  const before = await requireClient(orgId(c), c.req.param("id"));
  const r = await disableSharing(orgId(c), c.req.param("id"));
  await audit(c, "client.share_disabled", { targetType: "client", targetId: before.id, data: { name: before.name, hadShareLink: !!before.shareToken } });
  return c.json(r);
});

async function act(oid: string, clientId: string | null, bucket: (typeof BUCKETS)[number], action: "enrich" | "verify" | "list") {
  const { db } = getDb();
  const { ids: all, total } = await attentionLeadIds(oid, clientId, bucket);
  if (all.length === 0) return { action, bucket, queued: 0, note: "Nothing in that bucket right now." };

  // Enrich and verify each spend a verification from the plan inside the job. Queueing more
  // than the plan has left used to enqueue work that then failed job by job on the quota,
  // while the page reported the whole batch as queued.
  let ids = all;
  let skippedForQuota = 0;
  if (action === "enrich" || action === "verify") {
    const u = (await getUsage(db, oid)).usage.verifications;
    if (u.limit > 0) {
      const left = Math.max(0, u.limit - u.used);
      if (left < ids.length) {
        skippedForQuota = ids.length - left;
        ids = ids.slice(0, left);
      }
    }
    if (ids.length === 0) {
      return { action, bucket, queued: 0, skippedForQuota, note: "Your plan has no verifications left this month, so nothing was queued." };
    }
  }
  // Said when a bucket is bigger than one action takes, so "queued 1,000" is not read as
  // "the bucket is now empty".
  const remainingInBucket = Math.max(0, total - all.length);

  if (action === "enrich") {
    // A known-bad address is a different job from a missing one: enrichment normally leaves
    // a lead that already has an email alone, so "find a working address" queued work that
    // could never change anything. `replaceInvalid` tells the job to look for a replacement.
    const replaceInvalid = bucket === "badEmail";
    for (const id of ids) await enqueue(db, "lead.enrich", { leadId: id, ...(replaceInvalid ? { replaceInvalid: true } : {}) }, { orgId: oid });
    return { action, bucket, queued: ids.length, skippedForQuota, remainingInBucket };
  }
  if (action === "verify") {
    for (const id of ids) await enqueue(db, "lead.verify", { leadId: id }, { orgId: oid });
    return { action, bucket, queued: ids.length, skippedForQuota, remainingInBucket };
  }
  // "list": a list named for the client, reused on every click, that a campaign can target.
  if (!clientId) return { action, bucket, queued: 0, note: "Lists are per client. Assign these leads to a client first." };
  const client = await requireClient(oid, clientId);
  const name = `${client.name}: ready to contact`;
  let list = await db.query.lists.findFirst({ where: and(eq(lists.orgId, oid), eq(lists.clientId, clientId), eq(lists.name, name)) });
  if (!list) [list] = await db.insert(lists).values({ orgId: oid, clientId, name, description: "Verified leads nobody had contacted yet, gathered from the client dashboard." }).returning();
  const inserted = await db
    .insert(listLeads)
    .values(ids.map((leadId) => ({ listId: list!.id, leadId })))
    .onConflictDoNothing()
    .returning({ leadId: listLeads.leadId });
  return { action, bucket, listId: list.id, listName: list.name, added: inserted.length, alreadyOnList: ids.length - inserted.length, remainingInBucket };
}

/**
 * The client-facing report. No auth: the unguessable token in the URL is the credential.
 * Rate-limited per IP, because a public endpoint keyed on a secret is an endpoint someone
 * will eventually try to enumerate.
 */
export const clientReportPublic = new Hono<Env>();
clientReportPublic.get("/clients/report/:token", rateLimit({ perMinute: 30 }), async (c) => {
  // A suspended workspace's reports go dark with the rest of it, and an archived client's
  // report is closed - both answer exactly like a token that never existed.
  const { db } = getDb();
  const client = await db.query.clients.findFirst({ where: eq(clients.shareToken, c.req.param("token")) });
  if (!client || client.status === "archived") throw notFound("Report");
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, client.orgId) });
  if (!org || org.status === "deactivated" || org.status === "revoked") throw notFound("Report");
  const r = await publicReport(c.req.param("token"));
  // One answer for "no such token" and "sharing was turned off": telling them apart would
  // confirm which tokens once existed.
  if (!r) throw notFound("Report");
  c.header("cache-control", "private, no-store");
  c.header("x-robots-tag", "noindex");
  return c.json(r);
});

