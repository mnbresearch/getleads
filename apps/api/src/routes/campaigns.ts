import { Hono } from "hono";
import { zValidator } from "../lib/validate.js";
import { z } from "zod";
import { and, asc, inArray, campaignContacts, campaigns, clients, companies, consume, desc, emailAccounts, enqueue, eq, getDb, icps, leads, listLeads, lists, messages, organizations, sequenceSteps, sql, suppressions, type EmailAccount } from "@prospex/db";
import { generateOutreach, classifyReply, draftReplyToInbound, hasAi, assertPublicHost, isSsrfBlocked, redact } from "@prospex/core";
import { AI_OFF_NOTE, aiDisabled, aiFor, NO_AI } from "../lib/ai.js";
import { contactBlock, shownAddress } from "../lib/privacySuppression.js";
import { assertRowCap } from "../lib/limits.js";
import { tryConsume } from "../lib/quota.js";
import { env } from "../env.js";
import { randomToken } from "../lib/crypto.js";
import { sealOrgJson } from "../lib/credentials.js";
import { ApiError, badRequest, notFound, requireSomeFields } from "../lib/errors.js";
import { assertOwned } from "../lib/ownership.js";
import { testMailer, systemMailerConfig, allowedSmtpPorts } from "../lib/mailer.js";
import { orgId, requireAuth, type Env } from "../middleware.js";
import { enrollLeads, experimentForStep, leadsWithUsableEmail, mailingAddressOf, markReplied, outreachReasonOf, reserveManualSend, unsubscribeFooter, resolveMailer, resumeContact, sendFailureCategory, tickCampaign, SEND_REJECTED } from "../services/campaigns.js";
import { sendMail } from "../lib/mailer.js";
import { emitEvent } from "../lib/events.js";
import { audit } from "../lib/audit.js";
import { emailField } from "../lib/fields.js";
import { addressOf, safeDisplayName, stripControl } from "../lib/sanitize.js";
import { orgMemberEmail, orgOwnerEmail } from "../lib/members.js";
import { ownerOrAdmin } from "../lib/roles.js";
import { canonicalEmail } from "../services/leads.js";
import { requireVerifiedEmail, workspaceEmailVerified } from "../lib/emailVerification.js";
import { pendingDeletion } from "../services/accountDeletion.js";

export const campaignRoutes = new Hono<Env>();
campaignRoutes.use("*", requireAuth);

// ── Email accounts (senders) ──
const accountInput = z.object({
  provider: z.enum(["resend", "smtp", "system"]),
  // The display name of a From header. `< > " , ;` and control characters end the name and
  // start another mailbox or another header, so they are removed before it is stored.
  fromName: z
    .string()
    .min(1)
    .max(200)
    .transform((v) => safeDisplayName(v))
    .refine((v) => v.length > 0, { message: "Enter a sender name using letters or digits" }),
  fromEmail: emailField,
  replyTo: emailField.optional(),
  signature: z.string().max(5000).optional(),
  dailyLimit: z.number().int().min(1).max(2000).default(50),
  config: z.object({ apiKey: z.string().max(500).optional(), host: z.string().max(253).optional(), port: z.number().int().min(1).max(65535).optional(), user: z.string().max(320).optional(), pass: z.string().max(1000).optional(), secure: z.boolean().optional() }).optional(),
});

/** The platform's own sending address (the address part of MAIL_FROM). */
const platformFromAddress = () => addressOf(env.mailFrom);

campaignRoutes.get("/email-accounts", async (c) => {
  const { db } = getDb();
  const rows = await db.select().from(emailAccounts).where(eq(emailAccounts.orgId, orgId(c))).orderBy(desc(emailAccounts.createdAt));
  return c.json({ emailAccounts: rows.map(({ configEncrypted: _c, ...r }) => r), systemProviderAvailable: !!systemMailerConfig() || env.nodeEnv !== "production" });
});

/**
 * An SMTP host must be a public mail server.
 *
 * Saving an account immediately opens a connection to the host and port it names and reports
 * whether that worked - so with any host allowed, this endpoint was a port scanner for our
 * own private network (database, metadata service, internal admin ports), one probe per
 * request. The name is checked, and so is every address it resolves to, so a public name
 * pointed at 10.0.0.5 is refused too.
 */
async function assertPublicSmtpHost(host: string) {
  const bad = () => badRequest("SMTP host must be a public mail server address (for example smtp.gmail.com). Private, local and internal addresses are not allowed.");
  // The same resolver the send path uses, so what is accepted here is what gets connected to.
  try {
    await assertPublicHost(host);
  } catch (e) {
    throw isSsrfBlocked(e) ? bad() : badRequest(`SMTP host "${host}" could not be found. Check the spelling.`);
  }
}

type SenderTest = { ok: true } | { ok: false; error: string };

/** What a customer is told when a sender's saved credentials cannot be decrypted or are incomplete. */
const UNREADABLE_SENDER = "This sender's saved settings can no longer be read, so it cannot be tested or used. Remove the sender and add it again with its host, username and password (or API key).";

/**
 * The connection test for one sender - the same one whether the sender was just added or is
 * being tested again.
 *
 *  - "system" (the platform sender) has nothing of the customer's to test: it passes.
 *  - SMTP: the port must be a mail port and the host a public mail server (checked again
 *    here, at connect time, by the mailer), then the server must let us sign in.
 *  - Resend: the API key must be accepted.
 *
 * The driver's own error text distinguishes "connection refused" from "timed out" from
 * "auth failed", which is a port-state oracle; it is logged in full and the caller gets a
 * message that says what to check without describing the network. A setting WE refuse (a
 * port that is not a mail port, a private host) is different: that message is written for
 * the customer and is passed through as it is.
 */
async function testSender(row: EmailAccount, opts: { retest?: boolean } = {}): Promise<{ kind: "tested"; test: SenderTest } | { kind: "unreadable" }> {
  if (row.provider === "system") return { kind: "tested", test: { ok: true } };
  const resolved = resolveMailer(row);
  if (!resolved.ok) return { kind: "unreadable" };
  const raw = await testMailer(resolved.mailer);
  if (raw.ok) return { kind: "tested", test: { ok: true } };
  // The driver's text can echo what was typed into the form (a username, a key in a URL): redacted before it is logged.
  console.warn(`[campaigns] email account ${row.id} test failed: ${redact(String(raw.error ?? "unknown error"), { max: 300, maskEmails: true })}`);
  const error =
    raw.refused && raw.error
      ? raw.error
      : row.provider === "smtp"
        ? "Could not connect and sign in to the SMTP server. Check the host, port, security setting, username and password."
        : raw.unreachable
          ? // "The sender was saved" is news when it was just added. On a re-test it is not:
            // the text sits on the sender's own row, next to the "Test again" button it names.
            opts.retest
            ? "Could not reach the email provider to check this key."
            : 'Could not reach the email provider to check this key. The sender was saved; use "Test again" on it in a few minutes.'
          : "The email provider rejected the API key. Check that it is correct and active.";
  return { kind: "tested", test: { ok: false, error } };
}

// Owner/admin only: a sender is the identity the workspace's outreach goes out under.
campaignRoutes.post("/email-accounts", ownerOrAdmin("sender.created"), zValidator("json", accountInput), async (c) => {
  const b = c.req.valid("json");
  const oid = orgId(c);
  const { db } = getDb();
  if (b.provider === "system" && !systemMailerConfig() && env.nodeEnv === "production") {
    // Which settings are missing is for whoever runs the server, not for the customer.
    console.warn("[campaigns] platform sender requested but no system email provider is configured (RESEND_API_KEY or SMTP_*)");
    throw badRequest("The platform sender isn't available on this workspace yet. Connect your own Resend or SMTP account, or contact support.");
  }
  // The shared platform sender sends from Scout's own address. An account that has not yet
  // confirmed its email address does not get to add it (it can still connect its own
  // Resend or SMTP account). A no-op when verification is not available.
  if (b.provider === "system") await requireVerifiedEmail(c);
  if (b.provider === "resend" && !b.config?.apiKey) throw badRequest("config.apiKey required for Resend");
  if (b.provider === "smtp" && !b.config?.host) throw badRequest("config.host required for SMTP");
  if (b.provider === "smtp") {
    await assertPublicSmtpHost(b.config!.host!);
    // Mail ports only. Any other port turns "add a sender" into a way to reach arbitrary services.
    const port = Number((b.config as { port?: number } | undefined)?.port ?? 587);
    if (!allowedSmtpPorts().includes(port)) throw badRequest(`SMTP port ${port} is not allowed. Use one of: ${allowedSmtpPorts().join(", ")}.`);
  }

  /**
   * The platform sender sends from the PLATFORM'S address.
   *
   * With provider "system" the mail leaves through Scout's own mail account, and `fromEmail`
   * was whatever the tenant typed: any workspace could send as billing@<our domain>, or as
   * anyone else's address, with our DKIM signature and our reputation behind it. For this
   * provider the From address is now always the platform's (MAIL_FROM); the tenant chooses
   * the display name. Replies go to a person in the workspace: the Reply-To must be a
   * member's address, and defaults to the address they asked to send from when that is a
   * member's, otherwise to the person adding the sender.
   */
  let fromEmail = b.fromEmail;
  let replyTo = b.replyTo;
  let note: string | undefined;
  if (b.provider === "system") {
    if (replyTo) {
      const member = await orgMemberEmail(oid, replyTo);
      if (!member) throw badRequest("For the platform sender, Reply-To must be the email address of a member of this workspace. Leave it empty to use your own address, or connect your own Resend or SMTP account to use any address.");
      replyTo = member;
    } else {
      replyTo = (await orgMemberEmail(oid, b.fromEmail)) ?? canonicalEmail(c.get("auth").user?.email) ?? (await orgOwnerEmail(oid)) ?? undefined;
    }
    fromEmail = platformFromAddress();
    if (b.fromEmail !== fromEmail) note = `The platform sender always sends from ${fromEmail}. Your sender name is shown to recipients and replies go to ${replyTo ?? "the workspace owner"}. To send from ${b.fromEmail}, connect your own Resend or SMTP account.`;
  }
  const [row] = await db
    .insert(emailAccounts)
    .values({ orgId: oid, provider: b.provider, fromName: b.fromName, fromEmail, replyTo, signature: b.signature, dailyLimit: b.dailyLimit, configEncrypted: b.config ? sealOrgJson(oid, "email-account", b.config) : null })
    .returning();
  const tested = await testSender(row);
  // Freshly encrypted a moment ago, so "unreadable" cannot happen here; treated as a failed test if it somehow does.
  const test: SenderTest = tested.kind === "tested" ? tested.test : { ok: false, error: UNREADABLE_SENDER };
  if (!test.ok) await db.update(emailAccounts).set({ status: "error" }).where(eq(emailAccounts.id, row.id));
  const { configEncrypted: _c, ...pub } = row;
  // No credentials: the provider, the visible identity and whether the test passed.
  await audit(c, "sender.created", { targetType: "email_account", targetId: row.id, data: { provider: row.provider, fromEmail: row.fromEmail, replyTo: row.replyTo, dailyLimit: row.dailyLimit, testOk: test.ok } });
  return c.json({ emailAccount: { ...pub, status: test.ok ? "active" : "error" }, test, ...(note ? { note } : {}) }, 201);
});

/**
 * Test a saved sender again.
 *
 * A sender whose connection test failed is marked "error", and a campaign will not start (and
 * a reply will not send) through it. Nothing ever ran the test a second time, so one bad
 * minute at the mail provider - or a password fixed on the provider's side - left the sender
 * dead until it was deleted and typed in again, which also detached it from its campaigns.
 *
 * Runs exactly the test that adding a sender runs (for SMTP that includes the host and port
 * rules), sets the status from the result, and returns the same shape. Credentials are never
 * returned. Stored credentials that can no longer be read cannot be tested: 409, in words.
 */
campaignRoutes.post("/email-accounts/:id/retest", ownerOrAdmin("sender.retested"), async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const row = await db.query.emailAccounts.findFirst({ where: and(eq(emailAccounts.id, c.req.param("id")), eq(emailAccounts.orgId, oid)) });
  if (!row) throw notFound("Email account");
  const tested = await testSender(row, { retest: true });
  if (tested.kind === "unreadable") {
    if (row.status !== "error") await db.update(emailAccounts).set({ status: "error" }).where(and(eq(emailAccounts.id, row.id), eq(emailAccounts.orgId, oid)));
    await audit(c, "sender.retested", { result: "failed", targetType: "email_account", targetId: row.id, data: { provider: row.provider, fromEmail: row.fromEmail, reason: "credentials_unreadable", previousStatus: row.status } });
    throw new ApiError(409, UNREADABLE_SENDER, "credential_unreadable");
  }
  const status = tested.test.ok ? "active" : "error";
  if (status !== row.status) await db.update(emailAccounts).set({ status }).where(and(eq(emailAccounts.id, row.id), eq(emailAccounts.orgId, oid)));
  await audit(c, "sender.retested", { targetType: "email_account", targetId: row.id, data: { provider: row.provider, fromEmail: row.fromEmail, testOk: tested.test.ok, previousStatus: row.status, status } });
  const { configEncrypted: _c, ...pub } = row;
  return c.json({ emailAccount: { ...pub, status }, test: tested.test });
});

campaignRoutes.delete("/email-accounts/:id", ownerOrAdmin("sender.deleted"), async (c) => {
  const { db } = getDb();
  const gone = await db.delete(emailAccounts).where(and(eq(emailAccounts.id, c.req.param("id")), eq(emailAccounts.orgId, orgId(c)))).returning({ id: emailAccounts.id, provider: emailAccounts.provider, fromEmail: emailAccounts.fromEmail });
  if (!gone.length) throw notFound("Email account");
  await audit(c, "sender.deleted", { targetType: "email_account", targetId: gone[0].id, data: { provider: gone[0].provider, fromEmail: gone[0].fromEmail } });
  return c.json({ ok: true });
});

// ── Campaigns ──
/**
 * `aiInstructions` is nullable because GET returns null for a step that has none. The edit
 * page sends back what it read, so with `.optional()` saving ANY campaign that had such a
 * step failed validation. `id` is optional: a step that carries its id is updated in place.
 */
const stepInput = z.object({ id: z.string().uuid().optional(), delayDays: z.number().int().min(0).max(60).default(0), channel: z.enum(["email", "linkedin_connect", "linkedin_message", "whatsapp", "call", "task"]).default("email"), subjectTemplate: z.string().max(500).nullish().transform((v) => v ?? ""), bodyTemplate: z.string().min(1).max(20_000), aiPersonalize: z.boolean().default(true), aiInstructions: z.string().max(5000).nullish(), variants: z.array(z.object({ subjectTemplate: z.string().max(500), bodyTemplate: z.string().max(20_000) })).max(4).nullish().transform((v) => v ?? []) });
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const SEND_WINDOW_TIME = "Send window times must be 24-hour HH:MM, for example 09:00.";
/** A real IANA zone. An unknown one made the scheduler throw on every tick for that campaign. */
const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
const settingsInput = z.object({
  dailyLimit: z.number().int().min(1).max(2000).optional(),
  // Whole sentences (they end with a period), so they are shown as written - see describeIssue.
  timezone: z.string().refine(isTimeZone, { message: "Unknown time zone. Use a name like Asia/Kolkata or America/New_York." }).optional(),
  sendWindow: z.object({ start: z.string().regex(HHMM, SEND_WINDOW_TIME), end: z.string().regex(HHMM, SEND_WINDOW_TIME), days: z.array(z.number().int().min(0).max(6)) }).optional(),
  stopOnReply: z.boolean().optional(),
  trackOpens: z.boolean().optional(),
  trackClicks: z.boolean().optional(),
  unsubscribeFooter: z.boolean().optional(),
  senderName: z.string().max(200).optional(),
  senderCompany: z.string().max(200).optional(),
  senderTitle: z.string().max(300).optional(),
  valueProp: z.string().max(5000).optional(),
  tone: z.enum(["friendly", "direct", "formal", "casual"]).optional(),
});
// The references are nullable so a PATCH can detach them (`listId: null`), and so a body
// read back from GET - where an unset reference is null - is accepted as-is.
const campaignInput = z.object({ name: z.string().min(1).max(200), icpId: z.string().uuid().nullish(), listId: z.string().uuid().nullish(), emailAccountId: z.string().uuid().nullish(), clientId: z.string().uuid().nullish(), settings: settingsInput.optional(), steps: z.array(stepInput).max(10).optional() });

campaignRoutes.get("/", async (c) => {
  const { db } = getDb();
  const rows = await db
    .select({ campaign: campaigns, contacts: sql<number>`(SELECT count(*)::int FROM campaign_contacts WHERE campaign_id = ${campaigns.id})` })
    .from(campaigns)
    .where(eq(campaigns.orgId, orgId(c)))
    .orderBy(desc(campaigns.createdAt));
  return c.json({ campaigns: rows.map((r) => ({ ...r.campaign, contacts: r.contacts })) });
});

campaignRoutes.post("/", zValidator("json", campaignInput), async (c) => {
  const oid = orgId(c);
  const b = c.req.valid("json");
  const { db } = getDb();
  // A generous ceiling on how many campaigns one workspace can hold (lib/limits.ts); existing ones are untouched.
  await assertRowCap(db, campaigns, oid, "campaigns");
  // Every id in the body names a row this org must actually own. See lib/ownership.ts.
  await assertOwned(emailAccounts, b.emailAccountId, oid, "Email account", c);
  await assertOwned(icps, b.icpId, oid, "ICP", c);
  await assertOwned(lists, b.listId, oid, "List", c);
  await assertOwned(clients, b.clientId, oid, "Client", c);
  const [row] = await db.insert(campaigns).values({ orgId: oid, name: b.name, icpId: b.icpId ?? null, listId: b.listId ?? null, emailAccountId: b.emailAccountId ?? null, clientId: b.clientId ?? null, settings: b.settings ?? {} }).returning();
  if (b.steps?.length) await db.insert(sequenceSteps).values(b.steps.map(({ id: _id, ...s }, i) => ({ campaignId: row.id, stepNo: i + 1, ...s })));
  return c.json(await fullCampaign(oid, row.id), 201);
});

campaignRoutes.get("/:id", async (c) => {
  const r = await fullCampaign(orgId(c), c.req.param("id"));
  if (!r) throw notFound("Campaign");
  return c.json(r);
});

campaignRoutes.patch("/:id", zValidator("json", campaignInput.partial()), async (c) => {
  const oid = orgId(c);
  const b = c.req.valid("json");
  const { db } = getDb();
  const existing = await db.query.campaigns.findFirst({ where: and(eq(campaigns.id, c.req.param("id")), eq(campaigns.orgId, oid)) });
  if (!existing) throw notFound("Campaign");
  await assertOwned(emailAccounts, b.emailAccountId, oid, "Email account", c);
  await assertOwned(icps, b.icpId, oid, "ICP", c);
  await assertOwned(lists, b.listId, oid, "List", c);
  await assertOwned(clients, b.clientId, oid, "Client", c);
  requireSomeFields(b);
  await db
    .update(campaigns)
    .set({ ...(b.name ? { name: b.name } : {}), ...(b.clientId !== undefined ? { clientId: b.clientId } : {}), ...(b.icpId !== undefined ? { icpId: b.icpId } : {}), ...(b.listId !== undefined ? { listId: b.listId } : {}), ...(b.emailAccountId !== undefined ? { emailAccountId: b.emailAccountId } : {}), ...(b.settings ? { settings: { ...existing.settings, ...b.settings } } : {}), updatedAt: new Date() })
    .where(eq(campaigns.id, existing.id));
  if (b.steps) await syncSteps(existing.id, b.steps);
  return c.json(await fullCampaign(oid, existing.id));
});

/**
 * Bring a campaign's steps in line with the edited list, keeping step identity.
 *
 * This used to delete every step and insert new ones. Step ids are not just keys: queued
 * send jobs carry them (and then found nothing and dropped the send), sent messages point
 * at them (and had step_id nulled by the cascade), and A/B results are grouped by them (and
 * were wiped). So a typo fix in step 2 silently broke a running campaign.
 *
 * Matching: a step that carries an id keeps that row. A step without one takes over the
 * row at the same position, unless that row was claimed by id elsewhere in the list. Only
 * rows nothing matched are deleted.
 */
async function syncSteps(campaignId: string, steps: z.infer<typeof stepInput>[]) {
  const { db } = getDb();
  const current = await db.select().from(sequenceSteps).where(eq(sequenceSteps.campaignId, campaignId)).orderBy(asc(sequenceSteps.stepNo));
  const byId = new Map(current.map((s) => [s.id, s]));
  const claimedById = new Set(steps.map((s) => s.id).filter((id): id is string => !!id && byId.has(id)));
  const used = new Set<string>();
  for (let i = 0; i < steps.length; i++) {
    const { id, ...fields } = steps[i];
    let target = id && byId.has(id) && !used.has(id) ? byId.get(id)! : undefined;
    if (!target && !id) {
      const atPos = current[i];
      if (atPos && !claimedById.has(atPos.id) && !used.has(atPos.id)) target = atPos;
    }
    const values = { ...fields, aiInstructions: fields.aiInstructions ?? null, stepNo: i + 1 };
    if (target) {
      used.add(target.id);
      await db.update(sequenceSteps).set(values).where(eq(sequenceSteps.id, target.id));
    } else {
      await db.insert(sequenceSteps).values({ campaignId, ...values });
    }
  }
  const removed = current.filter((s) => !used.has(s.id)).map((s) => s.id);
  if (removed.length) await db.delete(sequenceSteps).where(and(eq(sequenceSteps.campaignId, campaignId), inArray(sequenceSteps.id, removed)));
}

campaignRoutes.delete("/:id", async (c) => {
  const { db } = getDb();
  const gone = await db.delete(campaigns).where(and(eq(campaigns.id, c.req.param("id")), eq(campaigns.orgId, orgId(c)))).returning({ id: campaigns.id, name: campaigns.name, status: campaigns.status });
  if (!gone.length) throw notFound("Campaign");
  await audit(c, "campaign.deleted", { targetType: "campaign", targetId: gone[0].id, data: { name: gone[0].name, status: gone[0].status } });
  return c.json({ ok: true });
});

/** Enroll leads: explicit ids, or everything in the campaign's list, or filter by ICP min score. */
campaignRoutes.post("/:id/enroll", zValidator("json", z.object({ leadIds: z.array(z.string().uuid()).optional(), fromList: z.boolean().default(false), minScore: z.number().optional() })), async (c) => {
  const oid = orgId(c);
  const b = c.req.valid("json");
  const { db } = getDb();
  const cp = await db.query.campaigns.findFirst({ where: and(eq(campaigns.id, c.req.param("id")), eq(campaigns.orgId, oid)) });
  if (!cp) throw notFound("Campaign");
  let ids = b.leadIds ?? [];
  if (b.fromList && cp.listId) ids.push(...(await db.select({ id: listLeads.leadId }).from(listLeads).where(eq(listLeads.listId, cp.listId))).map((r) => r.id));
  if (b.minScore !== undefined) ids.push(...(await db.select({ id: leads.id }).from(leads).where(and(eq(leads.orgId, oid), sql`${leads.score} >= ${b.minScore}`, sql`${leads.email} IS NOT NULL`, cp.icpId ? eq(leads.icpId, cp.icpId) : sql`true`))).map((r) => r.id));
  ids = [...new Set(ids)];
  // Only leads with a usable email: one valid address, not known to be bad. A stored value
  // that is not a single address ("Name <a@b>", "a@x, b@x" - rows from before imports were
  // validated) used to be enrolled and only failed when its first email was due; it is left
  // out here and counted, so the person enrolling learns of it now.
  const usable = await leadsWithUsableEmail(db, oid, ids);
  let toEnroll = usable.ids;
  // A campaign run for a client only contacts that client's leads. Unowned ones are claimed
  // for it (they are about to be contacted on its behalf); another client's are left out
  // and counted. Without this, one-owner-per-lead held everywhere except at the point where
  // emails are actually sent.
  let clientNote: { claimedForClient: number; skippedOtherClient: number } | undefined;
  if (cp.clientId) {
    const { partitionForClientCampaign } = await import("../services/clients.js");
    const p = await partitionForClientCampaign(db, oid, cp.clientId, toEnroll);
    toEnroll = p.allowed;
    clientNote = { claimedForClient: p.claimed, skippedOtherClient: p.ownedByAnotherClient };
  }
  const n = await enrollLeads(cp, toEnroll);
  return c.json({ enrolled: n, skippedNoEmail: usable.skippedNoEmail, skippedInvalidEmail: usable.skippedInvalidEmail, ...(clientNote ?? {}) });
});

/**
 * A/B results per sequence step. Steps with a single variant are omitted: there is nothing
 * to compare.
 */
campaignRoutes.get("/:id/experiments", async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const cp = await db.query.campaigns.findFirst({ where: and(eq(campaigns.id, c.req.param("id")), eq(campaigns.orgId, oid)) });
  if (!cp) throw notFound("Campaign");
  const steps = await db.select().from(sequenceSteps).where(eq(sequenceSteps.campaignId, cp.id)).orderBy(asc(sequenceSteps.stepNo));
  const out = [];
  for (const st of steps) {
    const result = await experimentForStep(db, st);
    if (result) out.push({ stepId: st.id, stepNo: st.stepNo, subjects: [st.subjectTemplate, ...(st.variants ?? []).map((v) => v.subjectTemplate)], result });
  }
  return c.json({ experiments: out });
});

campaignRoutes.post("/:id/start", async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const cp = await db.query.campaigns.findFirst({ where: and(eq(campaigns.id, c.req.param("id")), eq(campaigns.orgId, oid)) });
  if (!cp) throw notFound("Campaign");
  // A workspace that is scheduled for deletion does not start (or restart) outreach.
  const deletion = await pendingDeletion(oid);
  if (deletion) {
    throw new ApiError(409, `This workspace is scheduled for deletion on ${deletion.scheduledFor.toISOString().slice(0, 10)}, so campaigns cannot be started. An owner can cancel the deletion under Settings > Workspace.`, "workspace_deletion_pending");
  }
  const steps = await db.select().from(sequenceSteps).where(eq(sequenceSteps.campaignId, cp.id));
  if (!steps.length) throw badRequest("Add at least one sequence step");
  if (steps.some((s) => s.channel === "email") && !cp.emailAccountId) throw badRequest("Attach a sender account first - this sequence has email steps.");
  if (steps.some((s) => s.channel === "email") && cp.emailAccountId) {
    // A sender whose connection test failed sends nothing. Starting anyway showed "active"
    // with every contact queued forever and no reason given.
    const sender = await db.query.emailAccounts.findFirst({ where: and(eq(emailAccounts.id, cp.emailAccountId), eq(emailAccounts.orgId, oid)) });
    if (!sender) throw badRequest("The sender attached to this campaign no longer exists. Attach another sender, then start.");
    if (sender.status !== "active") throw badRequest(`The sender ${sender.fromEmail} failed its connection test, so this campaign would not send anything. Use "Test again" on that sender under Campaigns (or attach another sender), then start.`);
  }
  await db.update(campaigns).set({ status: "active", updatedAt: new Date() }).where(eq(campaigns.id, cp.id));
  await emitEvent(oid, "campaign.started", { campaignId: cp.id }, { type: "campaign", id: cp.id });
  await audit(c, "campaign.started", { targetType: "campaign", targetId: cp.id, data: { name: cp.name, steps: steps.length, emailAccountId: cp.emailAccountId } });
  const tick = await tickCampaign(cp.id);
  // Starting an empty campaign is allowed (contacts can be enrolled later), but it must not
  // look like sending has begun.
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(campaignContacts).where(eq(campaignContacts.campaignId, cp.id));
  return c.json({ status: "active", tick, contacts: n, ...(n === 0 ? { warning: "This campaign has no contacts yet - enroll leads to start sending." } : {}) });
});

campaignRoutes.post("/:id/pause", async (c) => {
  const { db } = getDb();
  const [row] = await db.update(campaigns).set({ status: "paused", updatedAt: new Date() }).where(and(eq(campaigns.id, c.req.param("id")), eq(campaigns.orgId, orgId(c)))).returning({ id: campaigns.id, name: campaigns.name });
  if (!row) throw notFound("Campaign");
  await audit(c, "campaign.paused", { targetType: "campaign", targetId: row.id, data: { name: row.name } });
  return c.json({ status: "paused" });
});

/**
 * Put a stopped contact back into its sequence.
 *
 * sendStep stops a contact when a send's outcome could not be established - neither
 * resending nor advancing is safe without knowing which way it went. A person who checks
 * the mailbox can settle it: `resend: false` means it arrived, move on; `true` means it
 * did not, try that step again. Without this, one dropped connection ended that prospect's
 * sequence permanently, recoverable only by hand-written SQL.
 */
campaignRoutes.post("/:id/contacts/:contactId/resume", zValidator("json", z.object({ resend: z.boolean().default(false) }).optional()), async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  // campaign_contacts has no orgId of its own, so ownership comes through the campaign.
  const campaign = await db.query.campaigns.findFirst({ where: and(eq(campaigns.id, c.req.param("id")), eq(campaigns.orgId, oid)) });
  if (!campaign) throw notFound("Campaign");
  const cc = await db.query.campaignContacts.findFirst({
    where: and(eq(campaignContacts.id, c.req.param("contactId")), eq(campaignContacts.campaignId, campaign.id)),
  });
  if (!cc) throw notFound("Contact");
  const r = await resumeContact(cc.id, { resend: c.req.valid("json")?.resend });
  if (!r.ok) throw badRequest(r.error);
  return c.json(r);
});

/**
 * A campaign id that is not this workspace's answers 404 on these two, like every other
 * campaign route. They used to answer 200 with an empty list, which reads as "this campaign
 * has no contacts" - a statement about a campaign the caller was never shown.
 */
async function ownCampaign(c: import("hono").Context<Env>) {
  const { db } = getDb();
  const cp = await db.query.campaigns.findFirst({ where: and(eq(campaigns.id, c.req.param("id")!), eq(campaigns.orgId, orgId(c))) });
  if (!cp) throw notFound("Campaign");
  return cp;
}

campaignRoutes.get("/:id/contacts", async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const cp = await ownCampaign(c);
  const rows = await db
    .select({ contact: campaignContacts, lead: leads, company: companies })
    .from(campaignContacts)
    .innerJoin(leads, eq(campaignContacts.leadId, leads.id))
    .leftJoin(companies, and(eq(leads.companyId, companies.id), eq(companies.orgId, oid)))
    .where(and(eq(campaignContacts.campaignId, cp.id), eq(leads.orgId, oid)))
    .orderBy(desc(campaignContacts.updatedAt))
    .limit(500);
  return c.json({ contacts: rows.map((r) => ({ ...r.contact, lead: { ...r.lead, company: r.company } })) });
});

campaignRoutes.get("/:id/messages", async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const cp = await ownCampaign(c);
  const rows = await db
    .select({ message: messages, lead: leads })
    .from(messages)
    // Scoped join: a message row pointing at another workspace's lead shows no lead.
    .leftJoin(leads, and(eq(messages.leadId, leads.id), eq(leads.orgId, oid)))
    .where(and(eq(messages.campaignId, cp.id), eq(messages.orgId, oid)))
    .orderBy(desc(messages.createdAt))
    .limit(200);
  // `trackingToken` is what the open / click / unsubscribe links of a message are keyed on;
  // it has no use in a list and is not part of one.
  // A message whose contact was deleted keeps its row without content; its stored address
  // is a fingerprint, which is not shown: `toEmail` is null and `recipientRemoved` is true.
  return c.json({
    messages: rows.map((r) => {
      const to = shownAddress(r.message.toEmail);
      return { ...r.message, toEmail: to.address, recipientRemoved: to.recipientRemoved, bodyHtml: undefined, trackingToken: undefined, lead: r.lead ? { id: r.lead.id, fullName: r.lead.fullName, title: r.lead.title } : null };
    }),
  });
});

/** Preview AI-personalized copy for a lead without sending. */
campaignRoutes.post("/:id/preview", zValidator("json", z.object({ leadId: z.string().uuid(), stepNo: z.number().int().min(1).default(1) })), async (c) => {
  const oid = orgId(c);
  const b = c.req.valid("json");
  const { db } = getDb();
  const cp = await db.query.campaigns.findFirst({ where: and(eq(campaigns.id, c.req.param("id")), eq(campaigns.orgId, oid)) });
  if (!cp) throw notFound("Campaign");
  const step = await db.query.sequenceSteps.findFirst({ where: and(eq(sequenceSteps.campaignId, cp.id), eq(sequenceSteps.stepNo, b.stepNo)) });
  if (!step) throw notFound("Step");
  const lead = await db.query.leads.findFirst({ where: and(eq(leads.id, b.leadId), eq(leads.orgId, oid)) });
  if (!lead) throw notFound("Lead");
  const company = lead.companyId ? await db.query.companies.findFirst({ where: and(eq(companies.id, lead.companyId), eq(companies.orgId, oid)) }) : null;
  const account = cp.emailAccountId ? await db.query.emailAccounts.findFirst({ where: and(eq(emailAccounts.id, cp.emailAccountId), eq(emailAccounts.orgId, oid)) }) : null;
  const s = cp.settings as Record<string, unknown>;
  // A workspace with AI assistance turned off gets the rendered template, is not charged
  // for an AI message, and is told why the preview is not personalised.
  const previewAiOff = step.aiPersonalize && aiDisabled(c.get("auth").org);
  const previewAi = step.aiPersonalize ? aiFor(c.get("auth")) : NO_AI;
  // Charged only when a model will actually run, as /generate does: with no AI engine the
  // preview is the rendered template, and that used to cost an AI message all the same.
  if (step.aiPersonalize && !previewAiOff && hasAi(previewAi)) await consume(db, oid, "aiMessages", 1);
  const out = await generateOutreach(previewAi, {
    lead: { ...lead, company: company ? { name: company.name, domain: company.domain, industry: company.industry, description: company.description } : null },
    sender: { name: account?.fromName ?? "Me", company: String(s.senderCompany ?? ""), title: s.senderTitle ? String(s.senderTitle) : undefined, valueProp: String(s.valueProp ?? step.aiInstructions ?? ""), signature: account?.signature ?? undefined, tone: s.tone as "friendly" | undefined },
    subjectTemplate: step.subjectTemplate,
    bodyTemplate: step.bodyTemplate,
    instructions: step.aiInstructions ?? undefined,
    stepNo: step.stepNo,
    // The same "relevant because" a real send carries, so the preview is what goes out.
    ...(outreachReasonOf(lead) ? { reason: outreachReasonOf(lead) } : {}),
  });
  return c.json(previewAiOff ? { ...out, aiOff: true, note: AI_OFF_NOTE } : out);
});

/** Standalone AI message generation (no campaign needed) - for agents. */
campaignRoutes.post("/generate", zValidator("json", z.object({
  leadId: z.string().uuid().optional(),
  lead: z.object({ firstName: z.string().optional(), lastName: z.string().optional(), fullName: z.string().optional(), title: z.string().optional(), company: z.object({ name: z.string().optional(), domain: z.string().optional(), industry: z.string().optional(), description: z.string().optional() }).optional() }).optional(),
  sender: z.object({ name: z.string(), company: z.string(), title: z.string().optional(), valueProp: z.string(), signature: z.string().optional(), tone: z.enum(["friendly", "direct", "formal", "casual"]).optional() }),
  instructions: z.string().optional(),
  stepNo: z.number().int().min(1).default(1),
  language: z.string().optional(),
})), async (c) => {
  const oid = orgId(c);
  const b = c.req.valid("json");
  const { db } = getDb();
  let lead = b.lead;
  let reason: string | undefined;
  if (b.leadId) {
    const l = await db.query.leads.findFirst({ where: and(eq(leads.id, b.leadId), eq(leads.orgId, oid)) });
    if (!l) throw notFound("Lead");
    reason = outreachReasonOf(l);
    const co = l.companyId ? await db.query.companies.findFirst({ where: and(eq(companies.id, l.companyId), eq(companies.orgId, oid)) }) : null;
    lead = { firstName: l.firstName ?? undefined, lastName: l.lastName ?? undefined, fullName: l.fullName ?? undefined, title: l.title ?? undefined, company: co ? { name: co.name ?? undefined, domain: co.domain, industry: co.industry ?? undefined, description: co.description ?? undefined } : undefined };
  }
  if (!lead) throw badRequest("lead or leadId required");
  const ai = aiFor(c.get("auth"));
  const aiConfigured = hasAi(ai);
  // No engine: nothing to meter, and the answer must say it is a template. It used to come
  // back looking like a personalised draft (and was charged as an AI message).
  if (aiConfigured) await consume(db, oid, "aiMessages", 1);
  const out = await generateOutreach(ai, { lead, sender: b.sender, instructions: b.instructions, stepNo: b.stepNo, language: b.language, ...(reason ? { reason } : {}) });
  const personalised = !!(out as { personalized?: boolean }).personalized;
  return c.json({
    ...out,
    ai: personalised,
    ...(personalised ? {} : { note: aiConfigured ? "The AI engine did not return a usable draft - this is a template, not a personalised draft." : aiDisabled(c.get("auth").org) ? "AI assistance is turned off for this workspace, so this is a template, not a personalised draft. An owner or admin can turn it back on under Settings." : "AI drafting isn't switched on for this workspace yet, so this is a template, not a personalised draft. Contact support to enable it." }),
  });
});

/** Positive-signal intents worth drafting an AI follow-up for. */
const REPLY_WORTHY_INTENTS = new Set(["interested", "referral", "question"]);

/** Every intent the classifier may return. Anything else is stored as "other". */
const REPLY_INTENTS = ["interested", "not_interested", "out_of_office", "unsubscribe", "referral", "question", "bounce", "other"] as const;
type ReplyIntent = (typeof REPLY_INTENTS)[number];
const asIntent = (v: unknown): ReplyIntent => (typeof v === "string" && (REPLY_INTENTS as readonly string[]).includes(v) ? (v as ReplyIntent) : "other");

/**
 * The sender's address out of a From value - strictly.
 *
 * This used to be "the first thing in the string that looks like an email". A From header
 * is `"display name" <address>`, and the display name is whatever the sender typed, so
 * `"ceo@bigprospect.test" <attacker@evil.example>` was read as a reply FROM the CEO: the
 * attacker's "unsubscribe" suppressed someone else's lead and stopped their sequence.
 *
 * The address is what is inside the LAST `<...>`. With no angle brackets the whole value
 * must be one bare address. Anything else is null, and the request is refused.
 */
export function parseSender(from: string): string | null {
  const s = stripControl(from).trim();
  if (!s || s.length > 1000) return null;
  const open = s.lastIndexOf("<");
  if (open !== -1) {
    const close = s.indexOf(">", open);
    // The mailbox must be the END of the value: nothing but whitespace may follow it.
    if (close === -1 || s.slice(close + 1).trim() !== "") return null;
    return canonicalEmail(s.slice(open + 1, close));
  }
  if (s.includes(">")) return null;
  return canonicalEmail(s);
}

/** Inbound reply ingestion (Resend inbound webhook, Gmail/Zapier forward, or manual). Stops sequences + classifies intent. */
campaignRoutes.post("/inbound", zValidator("json", z.object({ from: z.string().max(1000), text: z.string().max(200_000).default(""), subject: z.string().max(1000).optional() })), async (c) => {
  const oid = orgId(c);
  const b = c.req.valid("json");
  const email = parseSender(b.from);
  if (!email) throw badRequest("`from` must be the sender's address: either a bare address (jane@example.com) or Name <jane@example.com>.");
  const { db } = getDb();
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, oid) });
  /**
   * Matched BEFORE any AI sees it.
   *
   * This endpoint is fed by mail forwarding, so it receives whatever lands in the mailbox -
   * newsletters, colleagues, family. The text used to go to the AI classifier first and was
   * only then compared with the workspace's leads, so mail from people who had nothing to do
   * with any campaign was sent to a third party. Now the sender must be one of this
   * workspace's leads before a model is asked anything; mail from anyone else is classified
   * by the built-in rules (which is all it takes to honour an "unsubscribe") and goes no
   * further. A workspace that has turned AI assistance off gets the rules for every reply.
   */
  const knownSender = await db.query.leads.findFirst({ where: and(eq(leads.orgId, oid), eq(leads.email, email)), columns: { id: true } });
  const aiOff = aiDisabled(org ?? c.get("auth").org);
  const ai = knownSender && !aiOff ? aiFor(c.get("auth")) : NO_AI;
  // Classification is an AI call and is metered like one. Over quota it still runs - on the
  // rule-based path - because marking the reply (which stops the sequence) must never depend
  // on the AI budget. The response says which path was taken. Nothing is charged for a
  // message no model will see.
  const clsCharge: Awaited<ReturnType<typeof tryConsume>> = knownSender && !aiOff ? await tryConsume(db, oid, "aiMessages", 1) : { ok: true };
  const replyText = `${b.subject ?? ""}\n${b.text}`;
  /**
   * Nor on the AI provider being up. A provider error (a 429, a timeout) used to escape
   * from here as a 500: the reply was dropped, nothing was marked, and the sequence kept
   * emailing someone who had just answered - or asked to be removed. Any failure falls
   * back to the rule-based classifier, which needs nothing but the text.
   */
  let aiFailed = false;
  const raw = await classifyReply(clsCharge.ok ? ai : NO_AI, replyText).catch(async (e) => {
    aiFailed = true;
    console.warn(`[campaigns] reply classification failed, using rules: ${(e as Error)?.name ?? "Error"}`);
    return classifyReply(NO_AI, replyText).catch(() => ({ intent: "other", confidence: 0 }) as Awaited<ReturnType<typeof classifyReply>>);
  });
  // The intent is model output: it is written to messages.intent and into a lead tag
  // (`replied:<intent>`), so it is held to the known set before it is stored anywhere.
  const cls = { ...raw, intent: asIntent(raw?.intent), confidence: typeof raw?.confidence === "number" && Number.isFinite(raw.confidence) ? Math.min(1, Math.max(0, raw.confidence)) : 0 };
  let aiSkipped: string | undefined = !knownSender ? undefined : aiOff ? "ai_off" : clsCharge.ok ? (aiFailed ? "ai_unavailable" : undefined) : clsCharge.reason === "quota" ? "quota" : "error";
  // The message itself goes along so an out-of-office auto-reply is not taken for a real one.
  const matched = await markReplied(oid, email, cls.intent, { subject: b.subject, text: b.text });
  if (matched) {
    const lead = await db.query.leads.findFirst({ where: and(eq(leads.orgId, oid), eq(leads.email, email)) });
    const company = lead?.companyId ? await db.query.companies.findFirst({ where: and(eq(companies.id, lead.companyId), eq(companies.orgId, oid)) }) : null;

    // Reuse the sender identity from the most recent outbound message to this lead, if any.
    const prevOutbound = lead
      ? await db.query.messages.findFirst({ where: and(eq(messages.orgId, oid), eq(messages.leadId, lead.id), eq(messages.direction, "outbound")), orderBy: desc(messages.createdAt) })
      : null;
    // Both scoped to this workspace: the sender identity (name, signature) read here goes
    // into the AI draft, and must never be another tenant's.
    const campaign = prevOutbound?.campaignId ? await db.query.campaigns.findFirst({ where: and(eq(campaigns.id, prevOutbound.campaignId), eq(campaigns.orgId, oid)) }) : null;
    const account = campaign?.emailAccountId ? await db.query.emailAccounts.findFirst({ where: and(eq(emailAccounts.id, campaign.emailAccountId), eq(emailAccounts.orgId, oid)) }) : null;
    const cs = (campaign?.settings ?? {}) as Record<string, unknown>;

    let draftReply: { subject: string; body: string } | null = null;
    // Charged before the call, so an org past its cap does not keep getting drafts for free
    // (the old charge-after was wrapped in `.catch(() => {})`).
    const draftCharge = lead && REPLY_WORTHY_INTENTS.has(cls.intent) && !aiSkipped ? await tryConsume(db, oid, "aiMessages", 1) : null;
    if (draftCharge && !draftCharge.ok) aiSkipped = draftCharge.reason === "quota" ? "quota" : "error";
    if (lead && draftCharge?.ok) {
      const styleExamples = ((org?.settings as Record<string, unknown> | undefined)?.aiReplyStyleExamples as { subject: string; body: string }[] | undefined) ?? [];
      draftReply = await draftReplyToInbound(ai, {
        inboundText: b.text,
        inboundSubject: b.subject,
        intent: cls.intent,
        lead: { ...lead, company: company ? { name: company.name, domain: company.domain, industry: company.industry, description: company.description } : null },
        sender: {
          name: account?.fromName ?? "Me",
          company: String(cs.senderCompany ?? ""),
          title: cs.senderTitle ? String(cs.senderTitle) : undefined,
          valueProp: String(cs.valueProp ?? ""),
          signature: account?.signature ?? undefined,
          tone: (cs.tone as "friendly" | undefined) ?? "friendly",
        },
        styleExamples,
      }).catch(() => null);
    }

    await db.insert(messages).values({
      orgId: oid,
      campaignId: campaign?.id,
      leadId: lead?.id,
      direction: "inbound",
      toEmail: email,
      subject: (b.subject ?? "(reply)").slice(0, 500),
      bodyText: b.text.slice(0, 20000),
      status: "received",
      intent: cls.intent,
      draftReply: draftReply ?? undefined,
    });
  }
  return c.json({ matched, intent: cls.intent, confidence: cls.confidence, ...(aiSkipped ? { skipped: aiSkipped, note: aiSkipped === "quota" ? "AI quota reached: the reply was classified with rules only and no draft was written." : aiSkipped === "ai_unavailable" ? "The AI engine did not answer: the reply was classified with rules only and no draft was written." : aiSkipped === "ai_off" ? "AI assistance is turned off for this workspace: the reply was classified with rules only and no draft was written." : "Could not record AI usage, so the AI steps were skipped." } : {}) });
});

/** How long after a person wrote in an answer to them still counts as an answer (not held back by sender warm-up). */
const REPLY_WINDOW_DAYS = 14;

/** Send (or edit-and-send) the AI-drafted follow-up for an inbound message. */
campaignRoutes.post(
  "/messages/:id/send-reply",
  zValidator("json", z.object({ subject: z.string().min(1).optional(), body: z.string().min(1).optional() })),
  async (c) => {
    const oid = orgId(c);
    const b = c.req.valid("json");
    const { db } = getDb();
    const inbound = await db.query.messages.findFirst({ where: and(eq(messages.id, c.req.param("id")), eq(messages.orgId, oid)) });
    if (!inbound || inbound.direction !== "inbound") throw notFound("Inbound message");
    const draft = inbound.draftReply as { subject: string; body: string } | null;
    const subject = b.subject ?? draft?.subject;
    const bodyText = b.body ?? draft?.body;
    if (!subject || !bodyText) throw badRequest("No draft available - pass subject and body");
    if (!inbound.leadId) throw badRequest("Inbound message has no matched lead");
    const lead = await db.query.leads.findFirst({ where: and(eq(leads.id, inbound.leadId), eq(leads.orgId, oid)) });
    if (!lead?.email) throw badRequest("Lead has no email");
    // One recipient, in canonical form - the same rule a sequence send applies. A lead row
    // written before that rule could hold "a@x, b@x": sent verbatim it reached both, and the
    // exact-string suppression check below missed the one who had unsubscribed.
    const to = canonicalEmail(lead.email);
    if (!to) throw badRequest("This lead's email is not a single valid address, so no email was sent. Correct it on the lead first.");
    // The same gates every campaign send passes: it would otherwise email someone who had
    // unsubscribed. Compared on the canonical address and on the stored spelling.
    // The workspace's own list, the lead's own "unsubscribed" status, and the platform-wide
    // list of people who asked never to be contacted through Scout: one check, the same one
    // a sequence send makes.
    const block = await contactBlock(oid, [to, lead.email], { leadStatus: lead.status });
    if (block?.list === "platform") throw new ApiError(409, `${to} has asked not to be contacted through Scout, so no email was sent.`, "suppressed");
    if (block) throw new ApiError(409, `${to} has unsubscribed or is on your suppression list, so no email was sent.`, "suppressed");

    // Both scoped to the caller's org. This path also reaches mailerFromAccount, so it
    // decrypts SMTP credentials and sends from that address - exactly what the sendStep
    // scoping was for, in a second place an earlier pass missed.
    const campaign = inbound.campaignId ? await db.query.campaigns.findFirst({ where: and(eq(campaigns.id, inbound.campaignId), eq(campaigns.orgId, oid)) }) : null;
    let account = campaign?.emailAccountId ? await db.query.emailAccounts.findFirst({ where: and(eq(emailAccounts.id, campaign.emailAccountId), eq(emailAccounts.orgId, oid)) }) : null;
    // No sender on the campaign (or no campaign): the workspace's newest WORKING sender, and
    // only when there is none the newest of any - so the refusal below names a real sender.
    if (!account) account = await db.query.emailAccounts.findFirst({ where: eq(emailAccounts.orgId, oid), orderBy: [sql`(${emailAccounts.status} = 'active') DESC`, desc(emailAccounts.createdAt)] });
    if (!account) throw badRequest("No sender is set up yet. Add a sender under Campaigns, then send the reply.");
    // A sender whose connection test failed sends nothing - the same rule as starting a
    // campaign. Attempting anyway reported "the sending provider rejected the message",
    // which sent the customer looking at the recipient instead of at their own sender.
    if (account.status !== "active") {
      throw badRequest(`The sender ${account.fromEmail} failed its connection test, so the reply was not sent. Use "Test again" on that sender under Campaigns (or attach another sender to the campaign), then send the reply.`);
    }

    // The shared platform sender is not available to a workspace whose owner has not
    // confirmed their email address yet (when verification is available at all).
    if (account.provider === "system" && !(await workspaceEmailVerified(oid))) throw new ApiError(403, "The shared platform sender cannot be used until the workspace owner has confirmed their email address. Ask the owner to open the link in the verification email, or send this reply from your own connected sender.", "email_unverified");

    const resolved = resolveMailer(account);
    if (!resolved.ok) throw badRequest(`The sender ${account.fromEmail} cannot be used: its saved settings can no longer be read. Remove that sender and add it again under Campaigns, then send the reply.`);
    const mailer = resolved.mailer;
    if (bodyText.length > 20_000) throw badRequest("That reply is too long to send (20,000 characters at most).");
    const sendOrg = await db.query.organizations.findFirst({ where: eq(organizations.id, oid) });
    if (!sendOrg) throw notFound("Workspace");
    // Kill switch, the sender's daily cap, the workspace ceiling and the shared sender's cap:
    // the limits a sequence send is held to. This route used to pass none of them.
    // Answering someone who wrote in during the last 14 days is not held back by the warm-up
    // ladder of the workspace's own new sender (every other limit still applies; the shared
    // platform sender is never exempt - see reserveManualSend). A reply sent long after the
    // conversation went quiet is a cold send again, and is treated as one.
    const [wroteIn] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.orgId, oid), eq(messages.leadId, lead.id), eq(messages.direction, "inbound"), sql`${messages.createdAt} > now() - interval '${sql.raw(String(REPLY_WINDOW_DAYS))} days'`))
      .limit(1);
    const slot = await reserveManualSend(sendOrg, account, { answeringInbound: !!wroteIn });
    if (!slot.ok) throw new ApiError(slot.status, slot.message, slot.code);
    try {
      await consume(db, oid, "emails", 1);
    } catch (e) {
      await slot.release();
      throw e;
    }

    // A reply still carries a way out, and the same one-click header a sequence email has.
    const unsubToken = randomToken(16);
    const unsub = `${env.apiUrl}/t/u/${unsubToken}`;
    // The same foot as a sequence email, including the workspace's mailing address when set.
    const text = `${bodyText}${unsubscribeFooter(unsub, mailingAddressOf(sendOrg)).text}`;
    const mailto = account.replyTo ?? (account.provider === "system" ? null : account.fromEmail);
    const [msg] = await db
      .insert(messages)
      .values({ orgId: oid, campaignId: campaign?.id, leadId: lead.id, direction: "outbound", toEmail: to, subject, bodyText: text, trackingToken: unsubToken, status: "queued" })
      .returning();

    /** Not sent: give back the daily slot and the monthly unit it took. */
    const giveBack = async () => {
      await slot.release();
      await consume(db, oid, "emails", -1, { allowOverage: true }).catch(() => {});
    };
    let res: Awaited<ReturnType<typeof sendMail>>;
    try {
      res = await sendMail(mailer, {
        from: `${safeDisplayName(account.fromName) || "Sender"} <${account.provider === "system" ? platformFromAddress() : account.fromEmail}>`,
        // The canonical address and nothing else: one recipient per send.
        to,
        subject: stripControl(subject).slice(0, 500),
        text,
        replyTo: account.replyTo ?? account.fromEmail,
        headers: { "X-Prospex-Message": msg.id, "List-Unsubscribe": mailto ? `<${unsub}>, <mailto:${mailto}?subject=unsubscribe>` : `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      });
    } catch (e) {
      // A send that THROWS never reported an outcome. Only a returned { ok: false } used to
      // give the reservation back, so a throw here kept one of the sender's daily slots and
      // one unit of the month's allowance for an email that did not go out.
      await giveBack();
      const thrown = sendFailureCategory((e as Error)?.message ?? "");
      const category = thrown === SEND_REJECTED ? "The email could not be handed to the sending server" : thrown;
      await db.update(messages).set({ status: "failed", error: category }).where(eq(messages.id, msg.id)).catch(() => {});
      console.warn(`[campaigns] reply send threw for message ${msg.id}: ${(e as Error)?.name ?? "Error"}`);
      throw new ApiError(502, `Send failed: ${category}. Nothing was sent and nothing was counted against your limits - try again.`, "send_failed");
    }
    if (!res.ok) await giveBack();
    if (res.ok) {
      await db.update(messages).set({ status: "sent", sentAt: new Date(), providerMessageId: res.providerMessageId }).where(eq(messages.id, msg.id));
      await db.update(messages).set({ draftReply: null }).where(eq(messages.id, inbound.id));
      await emitEvent(oid, "message.sent", { messageId: msg.id, leadId: lead.id, campaignId: campaign?.id, to, subject }, { type: "message", id: msg.id });
      // Learn this org's actual voice: every reply a human actually approved and sent (edited
      // or not) is a better style example than anything we could write for them upfront. Feed
      // the last 5 back into future draftReplyToInbound calls (see /inbound above).
      if (draft) {
        const org = await db.query.organizations.findFirst({ where: eq(organizations.id, oid) });
        const settings = (org?.settings ?? {}) as Record<string, unknown>;
        const prior = (settings.aiReplyStyleExamples as { subject: string; body: string }[] | undefined) ?? [];
        // The lead is remembered with the example, so deleting that lead removes it (see
        // lib/privacyErase.ts): an example is a copy of what was written to that person.
        const next = [...prior, { subject, body: bodyText, leadId: lead.id }].slice(-5);
        // Only this key is written (see the note in services/visibility.ts saveVisibilityConfig).
        await db.execute(sql`UPDATE organizations SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{aiReplyStyleExamples}', ${JSON.stringify(next)}::jsonb) WHERE id = ${oid}`).catch(() => {});
      }
      return c.json({ sent: true, messageId: msg.id });
    }
    // A category, never the provider's own text: that can carry credentials or account ids.
    // (A setting we refused ourselves - a port that is not a mail port - is the exception:
    // that sentence is ours, written for the customer, and says what to change.)
    const category = sendFailureCategory(res);
    await db.update(messages).set({ status: "failed", error: category }).where(eq(messages.id, msg.id));
    console.warn(`[campaigns] reply send failed for message ${msg.id}`);
    throw badRequest(`Send failed: ${category}`);
  },
);

campaignRoutes.get("/:id/stats", async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const cp = await db.query.campaigns.findFirst({ where: and(eq(campaigns.id, c.req.param("id")), eq(campaigns.orgId, oid)) });
  if (!cp) throw notFound("Campaign");
  const [m] = await db
    .select({
      sent: sql<number>`count(*) FILTER (WHERE status IN ('sent','opened','clicked','replied'))::int`,
      opened: sql<number>`count(*) FILTER (WHERE opened_at IS NOT NULL)::int`,
      clicked: sql<number>`count(*) FILTER (WHERE clicked_at IS NOT NULL)::int`,
      replied: sql<number>`count(*) FILTER (WHERE replied_at IS NOT NULL)::int`,
      bounced: sql<number>`count(*) FILTER (WHERE status = 'bounced')::int`,
      failed: sql<number>`count(*) FILTER (WHERE status = 'failed')::int`,
    })
    .from(messages)
    .where(and(eq(messages.campaignId, cp.id), eq(messages.direction, "outbound")));
  const byStatus = await db.select({ status: campaignContacts.status, n: sql<number>`count(*)::int` }).from(campaignContacts).where(eq(campaignContacts.campaignId, cp.id)).groupBy(campaignContacts.status);
  const byVariant = await db
    .select({ stepId: messages.stepId, variant: messages.variant, sent: sql<number>`count(*) FILTER (WHERE sent_at IS NOT NULL)::int`, opened: sql<number>`count(*) FILTER (WHERE opened_at IS NOT NULL)::int`, replied: sql<number>`count(*) FILTER (WHERE replied_at IS NOT NULL)::int` })
    .from(messages)
    .where(and(eq(messages.campaignId, cp.id), eq(messages.direction, "outbound")))
    .groupBy(messages.stepId, messages.variant);
  return c.json({ messages: m, contacts: Object.fromEntries(byStatus.map((r) => [r.status, r.n])), variants: byVariant, rates: { open: m.sent ? +(m.opened / m.sent).toFixed(3) : 0, click: m.sent ? +(m.clicked / m.sent).toFixed(3) : 0, reply: m.sent ? +(m.replied / m.sent).toFixed(3) : 0 } });
});

async function fullCampaign(oid: string, id: string) {
  const { db } = getDb();
  const cp = await db.query.campaigns.findFirst({ where: and(eq(campaigns.id, id), eq(campaigns.orgId, oid)) });
  if (!cp) return null;
  const steps = await db.select().from(sequenceSteps).where(eq(sequenceSteps.campaignId, cp.id)).orderBy(asc(sequenceSteps.stepNo));
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(campaignContacts).where(eq(campaignContacts.campaignId, cp.id));
  return { ...cp, steps, contacts: n };
}

export { env };
