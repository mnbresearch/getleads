import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, asc, inArray, campaignContacts, campaigns, companies, consume, desc, emailAccounts, enqueue, eq, getDb, leads, listLeads, messages, organizations, sequenceSteps, sql } from "@prospex/db";
import { createAiProvider, createAiProviderForPlan, generateOutreach, classifyReply, draftReplyToInbound } from "@prospex/core";
import { env } from "../env.js";
import { encryptJson } from "../lib/crypto.js";
import { badRequest, notFound } from "../lib/errors.js";
import { testMailer, systemMailerConfig } from "../lib/mailer.js";
import { orgId, requireAuth, type Env } from "../middleware.js";
import { enrollLeads, mailerFromAccount, markReplied, tickCampaign } from "../services/campaigns.js";
import { sendMail } from "../lib/mailer.js";
import { emitEvent } from "../lib/events.js";

export const campaignRoutes = new Hono<Env>();
campaignRoutes.use("*", requireAuth);

// ── Email accounts (senders) ──
const accountInput = z.object({
  provider: z.enum(["resend", "smtp", "system"]),
  fromName: z.string().min(1),
  fromEmail: z.string().email(),
  replyTo: z.string().email().optional(),
  signature: z.string().optional(),
  dailyLimit: z.number().int().min(1).max(2000).default(50),
  config: z.object({ apiKey: z.string().optional(), host: z.string().optional(), port: z.number().optional(), user: z.string().optional(), pass: z.string().optional(), secure: z.boolean().optional() }).optional(),
});

campaignRoutes.get("/email-accounts", async (c) => {
  const { db } = getDb();
  const rows = await db.select().from(emailAccounts).where(eq(emailAccounts.orgId, orgId(c))).orderBy(desc(emailAccounts.createdAt));
  return c.json({ emailAccounts: rows.map(({ configEncrypted: _c, ...r }) => r), systemProviderAvailable: !!systemMailerConfig() || env.nodeEnv !== "production" });
});

campaignRoutes.post("/email-accounts", zValidator("json", accountInput), async (c) => {
  const b = c.req.valid("json");
  const { db } = getDb();
  if (b.provider === "system" && !systemMailerConfig() && env.nodeEnv === "production") throw badRequest("No system email provider configured on the server (RESEND_API_KEY or SMTP_*)");
  if (b.provider === "resend" && !b.config?.apiKey) throw badRequest("config.apiKey required for Resend");
  if (b.provider === "smtp" && !b.config?.host) throw badRequest("config.host required for SMTP");
  const [row] = await db
    .insert(emailAccounts)
    .values({ orgId: orgId(c), provider: b.provider, fromName: b.fromName, fromEmail: b.fromEmail, replyTo: b.replyTo, signature: b.signature, dailyLimit: b.dailyLimit, configEncrypted: b.config ? encryptJson(b.config) : null })
    .returning();
  const test = b.provider === "system" ? { ok: true } : await testMailer(mailerFromAccount(row)!);
  if (!test.ok) await db.update(emailAccounts).set({ status: "error" }).where(eq(emailAccounts.id, row.id));
  const { configEncrypted: _c, ...pub } = row;
  return c.json({ emailAccount: { ...pub, status: test.ok ? "active" : "error" }, test }, 201);
});

campaignRoutes.delete("/email-accounts/:id", async (c) => {
  const { db } = getDb();
  await db.delete(emailAccounts).where(and(eq(emailAccounts.id, c.req.param("id")), eq(emailAccounts.orgId, orgId(c))));
  return c.json({ ok: true });
});

// ── Campaigns ──
const stepInput = z.object({ delayDays: z.number().int().min(0).max(60).default(0), channel: z.enum(["email", "linkedin_connect", "linkedin_message", "whatsapp", "call", "task"]).default("email"), subjectTemplate: z.string().default(""), bodyTemplate: z.string().min(1), aiPersonalize: z.boolean().default(true), aiInstructions: z.string().optional(), variants: z.array(z.object({ subjectTemplate: z.string(), bodyTemplate: z.string() })).max(4).default([]) });
const settingsInput = z.object({
  dailyLimit: z.number().int().min(1).max(2000).optional(),
  timezone: z.string().optional(),
  sendWindow: z.object({ start: z.string(), end: z.string(), days: z.array(z.number().int().min(0).max(6)) }).optional(),
  stopOnReply: z.boolean().optional(),
  trackOpens: z.boolean().optional(),
  trackClicks: z.boolean().optional(),
  unsubscribeFooter: z.boolean().optional(),
  senderName: z.string().optional(),
  senderCompany: z.string().optional(),
  senderTitle: z.string().optional(),
  valueProp: z.string().optional(),
  tone: z.enum(["friendly", "direct", "formal", "casual"]).optional(),
});
const campaignInput = z.object({ name: z.string().min(1), icpId: z.string().uuid().optional(), listId: z.string().uuid().optional(), emailAccountId: z.string().uuid().optional(), settings: settingsInput.optional(), steps: z.array(stepInput).max(10).optional() });

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
  const [row] = await db.insert(campaigns).values({ orgId: oid, name: b.name, icpId: b.icpId, listId: b.listId, emailAccountId: b.emailAccountId, settings: b.settings ?? {} }).returning();
  if (b.steps?.length) await db.insert(sequenceSteps).values(b.steps.map((s, i) => ({ campaignId: row.id, stepNo: i + 1, ...s })));
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
  await db
    .update(campaigns)
    .set({ ...(b.name ? { name: b.name } : {}), ...(b.icpId !== undefined ? { icpId: b.icpId } : {}), ...(b.listId !== undefined ? { listId: b.listId } : {}), ...(b.emailAccountId !== undefined ? { emailAccountId: b.emailAccountId } : {}), ...(b.settings ? { settings: { ...existing.settings, ...b.settings } } : {}), updatedAt: new Date() })
    .where(eq(campaigns.id, existing.id));
  if (b.steps) {
    await db.delete(sequenceSteps).where(eq(sequenceSteps.campaignId, existing.id));
    if (b.steps.length) await db.insert(sequenceSteps).values(b.steps.map((s, i) => ({ campaignId: existing.id, stepNo: i + 1, ...s })));
  }
  return c.json(await fullCampaign(oid, existing.id));
});

campaignRoutes.delete("/:id", async (c) => {
  const { db } = getDb();
  await db.delete(campaigns).where(and(eq(campaigns.id, c.req.param("id")), eq(campaigns.orgId, orgId(c))));
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
  // only leads with a usable email
  const valid = await db.select({ id: leads.id }).from(leads).where(and(eq(leads.orgId, oid), inArray(leads.id, ids), sql`${leads.email} IS NOT NULL`, sql`${leads.emailStatus} <> 'invalid'`));
  const n = await enrollLeads(cp, valid.map((v) => v.id));
  return c.json({ enrolled: n, skippedNoEmail: ids.length - valid.length });
});

campaignRoutes.post("/:id/start", async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const cp = await db.query.campaigns.findFirst({ where: and(eq(campaigns.id, c.req.param("id")), eq(campaigns.orgId, oid)) });
  if (!cp) throw notFound("Campaign");
  const steps = await db.select().from(sequenceSteps).where(eq(sequenceSteps.campaignId, cp.id));
  if (!steps.length) throw badRequest("Add at least one sequence step");
  if (steps.some((s) => s.channel === "email") && !cp.emailAccountId) throw badRequest("Attach an email account first (the sequence has email steps)");
  await db.update(campaigns).set({ status: "active", updatedAt: new Date() }).where(eq(campaigns.id, cp.id));
  await emitEvent(oid, "campaign.started", { campaignId: cp.id }, { type: "campaign", id: cp.id });
  const tick = await tickCampaign(cp.id);
  return c.json({ status: "active", tick });
});

campaignRoutes.post("/:id/pause", async (c) => {
  const { db } = getDb();
  await db.update(campaigns).set({ status: "paused", updatedAt: new Date() }).where(and(eq(campaigns.id, c.req.param("id")), eq(campaigns.orgId, orgId(c))));
  return c.json({ status: "paused" });
});

campaignRoutes.get("/:id/contacts", async (c) => {
  const oid = orgId(c);
  const { db } = getDb();
  const rows = await db
    .select({ contact: campaignContacts, lead: leads, company: companies })
    .from(campaignContacts)
    .innerJoin(leads, eq(campaignContacts.leadId, leads.id))
    .leftJoin(companies, eq(leads.companyId, companies.id))
    .where(and(eq(campaignContacts.campaignId, c.req.param("id")), eq(leads.orgId, oid)))
    .orderBy(desc(campaignContacts.updatedAt))
    .limit(500);
  return c.json({ contacts: rows.map((r) => ({ ...r.contact, lead: { ...r.lead, company: r.company } })) });
});

campaignRoutes.get("/:id/messages", async (c) => {
  const { db } = getDb();
  const rows = await db
    .select({ message: messages, lead: leads })
    .from(messages)
    .leftJoin(leads, eq(messages.leadId, leads.id))
    .where(and(eq(messages.campaignId, c.req.param("id")), eq(messages.orgId, orgId(c))))
    .orderBy(desc(messages.createdAt))
    .limit(200);
  return c.json({ messages: rows.map((r) => ({ ...r.message, bodyHtml: undefined, lead: r.lead ? { id: r.lead.id, fullName: r.lead.fullName, title: r.lead.title } : null })) });
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
  const company = lead.companyId ? await db.query.companies.findFirst({ where: eq(companies.id, lead.companyId) }) : null;
  const account = cp.emailAccountId ? await db.query.emailAccounts.findFirst({ where: eq(emailAccounts.id, cp.emailAccountId) }) : null;
  const s = cp.settings as Record<string, unknown>;
  if (step.aiPersonalize) await consume(db, oid, "aiMessages", 1);
  const out = await generateOutreach(step.aiPersonalize ? createAiProvider() : { name: "none", model: "none", complete: async () => "" }, {
    lead: { ...lead, company: company ? { name: company.name, domain: company.domain, industry: company.industry, description: company.description } : null },
    sender: { name: account?.fromName ?? "Me", company: String(s.senderCompany ?? ""), title: s.senderTitle ? String(s.senderTitle) : undefined, valueProp: String(s.valueProp ?? step.aiInstructions ?? ""), signature: account?.signature ?? undefined, tone: s.tone as "friendly" | undefined },
    subjectTemplate: step.subjectTemplate,
    bodyTemplate: step.bodyTemplate,
    instructions: step.aiInstructions ?? undefined,
    stepNo: step.stepNo,
  });
  return c.json(out);
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
  if (b.leadId) {
    const l = await db.query.leads.findFirst({ where: and(eq(leads.id, b.leadId), eq(leads.orgId, oid)) });
    if (!l) throw notFound("Lead");
    const co = l.companyId ? await db.query.companies.findFirst({ where: eq(companies.id, l.companyId) }) : null;
    lead = { firstName: l.firstName ?? undefined, lastName: l.lastName ?? undefined, fullName: l.fullName ?? undefined, title: l.title ?? undefined, company: co ? { name: co.name ?? undefined, domain: co.domain, industry: co.industry ?? undefined, description: co.description ?? undefined } : undefined };
  }
  if (!lead) throw badRequest("lead or leadId required");
  await consume(db, oid, "aiMessages", 1);
  return c.json(await generateOutreach(createAiProvider(), { lead, sender: b.sender, instructions: b.instructions, stepNo: b.stepNo, language: b.language }));
});

/** Positive-signal intents worth drafting an AI follow-up for. */
const REPLY_WORTHY_INTENTS = new Set(["interested", "referral", "question"]);

/** Inbound reply ingestion (Resend inbound webhook, Gmail/Zapier forward, or manual). Stops sequences + classifies intent. */
campaignRoutes.post("/inbound", zValidator("json", z.object({ from: z.string(), text: z.string().default(""), subject: z.string().optional() })), async (c) => {
  const oid = orgId(c);
  const b = c.req.valid("json");
  const email = (b.from.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0] ?? b.from).toLowerCase();
  const org = await getDb().db.query.organizations.findFirst({ where: eq(organizations.id, oid) });
  const ai = createAiProviderForPlan(org?.plan ?? "free");
  const cls = await classifyReply(ai, `${b.subject ?? ""}\n${b.text}`);
  const { db } = getDb();
  const matched = await markReplied(oid, email, cls.intent);
  if (matched) {
    const lead = await db.query.leads.findFirst({ where: and(eq(leads.orgId, oid), eq(leads.email, email)) });
    const company = lead?.companyId ? await db.query.companies.findFirst({ where: eq(companies.id, lead.companyId) }) : null;

    // Reuse the sender identity from the most recent outbound message to this lead, if any.
    const prevOutbound = lead
      ? await db.query.messages.findFirst({ where: and(eq(messages.orgId, oid), eq(messages.leadId, lead.id), eq(messages.direction, "outbound")), orderBy: desc(messages.createdAt) })
      : null;
    const campaign = prevOutbound?.campaignId ? await db.query.campaigns.findFirst({ where: eq(campaigns.id, prevOutbound.campaignId) }) : null;
    const account = campaign?.emailAccountId ? await db.query.emailAccounts.findFirst({ where: eq(emailAccounts.id, campaign.emailAccountId) }) : null;
    const cs = (campaign?.settings ?? {}) as Record<string, unknown>;

    let draftReply: { subject: string; body: string } | null = null;
    if (lead && REPLY_WORTHY_INTENTS.has(cls.intent)) {
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
      if (draftReply) await consume(db, oid, "aiMessages", 1).catch(() => {});
    }

    await db.insert(messages).values({
      orgId: oid,
      campaignId: campaign?.id,
      leadId: lead?.id,
      direction: "inbound",
      toEmail: email,
      subject: b.subject ?? "(reply)",
      bodyText: b.text.slice(0, 20000),
      status: "received",
      intent: cls.intent,
      draftReply: draftReply ?? undefined,
    });
  }
  return c.json({ matched, intent: cls.intent, confidence: cls.confidence });
});

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
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, inbound.leadId) });
    if (!lead?.email) throw badRequest("Lead has no email");

    const campaign = inbound.campaignId ? await db.query.campaigns.findFirst({ where: eq(campaigns.id, inbound.campaignId) }) : null;
    let account = campaign?.emailAccountId ? await db.query.emailAccounts.findFirst({ where: eq(emailAccounts.id, campaign.emailAccountId) }) : null;
    if (!account) account = await db.query.emailAccounts.findFirst({ where: eq(emailAccounts.orgId, oid), orderBy: desc(emailAccounts.createdAt) });
    if (!account) throw badRequest("No email sending account configured for this org");

    const mailer = mailerFromAccount(account);
    if (!mailer) throw badRequest("Sending account is not configured correctly");

    const [msg] = await db
      .insert(messages)
      .values({ orgId: oid, campaignId: campaign?.id, leadId: lead.id, direction: "outbound", toEmail: lead.email, subject, bodyText, status: "queued" })
      .returning();

    const res = await sendMail(mailer, {
      from: `${account.fromName} <${account.fromEmail}>`,
      to: lead.email,
      subject,
      text: bodyText,
      replyTo: account.replyTo ?? account.fromEmail,
      headers: { "X-Prospex-Message": msg.id },
    });
    if (res.ok) {
      await db.update(messages).set({ status: "sent", sentAt: new Date(), providerMessageId: res.providerMessageId }).where(eq(messages.id, msg.id));
      await db.update(messages).set({ draftReply: null }).where(eq(messages.id, inbound.id));
      await emitEvent(oid, "message.sent", { messageId: msg.id, leadId: lead.id, campaignId: campaign?.id, to: lead.email, subject }, { type: "message", id: msg.id });
      // Learn this org's actual voice: every reply a human actually approved and sent (edited
      // or not) is a better style example than anything we could write for them upfront. Feed
      // the last 5 back into future draftReplyToInbound calls (see /inbound above).
      if (draft) {
        const org = await db.query.organizations.findFirst({ where: eq(organizations.id, oid) });
        const settings = (org?.settings ?? {}) as Record<string, unknown>;
        const prior = (settings.aiReplyStyleExamples as { subject: string; body: string }[] | undefined) ?? [];
        const next = [...prior, { subject, body: bodyText }].slice(-5);
        await db.update(organizations).set({ settings: { ...settings, aiReplyStyleExamples: next } }).where(eq(organizations.id, oid)).catch(() => {});
      }
      return c.json({ sent: true, messageId: msg.id });
    }
    await db.update(messages).set({ status: "failed", error: res.error }).where(eq(messages.id, msg.id));
    throw badRequest(`Send failed: ${res.error}`);
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
