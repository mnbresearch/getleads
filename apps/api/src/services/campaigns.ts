import { and, asc, campaignContacts, campaigns, companies, emailAccounts, enqueue, eq, getDb, integrations, leads, lte, messages, sequenceSteps, suppressions, tasks, sql, type Campaign, type CampaignSettings, type EmailAccount } from "@prospex/db";
import { createAiProvider, generateOutreach, leadVars, renderTemplate, textToHtml, normalizePhone, sendWhatsApp } from "@prospex/core";
import { decryptJson as decryptCfg } from "../lib/crypto.js";
import { consume } from "@prospex/db";
import { env } from "../env.js";
import { decryptJson, randomToken } from "../lib/crypto.js";
import { sendMail, type MailerConfig } from "../lib/mailer.js";
import { emitEvent } from "../lib/events.js";

const DEFAULT_SETTINGS: Required<CampaignSettings> = {
  dailyLimit: 50,
  timezone: "Asia/Kolkata",
  sendWindow: { start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5] },
  stopOnReply: true,
  trackOpens: true,
  trackClicks: true,
  unsubscribeFooter: true,
};

export function settingsOf(c: Campaign): Required<CampaignSettings> {
  return { ...DEFAULT_SETTINGS, ...(c.settings ?? {}), sendWindow: { ...DEFAULT_SETTINGS.sendWindow, ...(c.settings?.sendWindow ?? {}) } };
}

/** Is `now` inside the campaign's send window (in its timezone)? */
export function inSendWindow(s: Required<CampaignSettings>, now = new Date()) {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: s.timezone, hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit" });
    const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
    const dayIdx = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
    if (!s.sendWindow.days.includes(dayIdx)) return false;
    const hm = `${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`;
    return hm >= s.sendWindow.start && hm <= s.sendWindow.end;
  } catch {
    return true;
  }
}

/** Enroll all leads in the campaign's list (or explicit ids). */
export async function enrollLeads(campaign: Campaign, leadIds: string[]) {
  const { db } = getDb();
  let n = 0;
  let i = 0;
  for (const leadId of leadIds) {
    const r = await db
      .insert(campaignContacts)
      .values({ campaignId: campaign.id, leadId, status: "queued", currentStep: 0, nextSendAt: new Date(), variant: i++ })
      .onConflictDoNothing()
      .returning();
    n += r.length;
  }
  return n;
}

/**
 * One scheduler tick for an active campaign: pick due contacts, respect daily limit + window,
 * enqueue message.send jobs. Called by the campaign.tick job every minute.
 */
export async function tickCampaign(campaignId: string) {
  const { db } = getDb();
  const campaign = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaignId) });
  if (!campaign || campaign.status !== "active") return { sent: 0, reason: "not active" };
  const s = settingsOf(campaign);
  if (!inSendWindow(s)) return { sent: 0, reason: "outside send window" };
  const account = campaign.emailAccountId ? await db.query.emailAccounts.findFirst({ where: eq(emailAccounts.id, campaign.emailAccountId) }) : null;
  const steps = await db.select().from(sequenceSteps).where(eq(sequenceSteps.campaignId, campaign.id)).orderBy(asc(sequenceSteps.stepNo));
  if (steps.length === 0) return { sent: 0, reason: "no steps" };
  const needsEmail = steps.some((st) => st.channel === "email");
  if (needsEmail && (!account || account.status !== "active")) return { sent: 0, reason: "no active email account" };

  const today = new Date().toISOString().slice(0, 10);
  const sentToday = account && account.sentTodayDate === today ? account.sentToday : 0;
  const budget = Math.min(s.dailyLimit, account?.dailyLimit ?? s.dailyLimit) - sentToday;
  if (budget <= 0) return { sent: 0, reason: "daily limit reached" };

  const due = await db
    .select()
    .from(campaignContacts)
    .where(and(eq(campaignContacts.campaignId, campaign.id), sql`${campaignContacts.status} IN ('queued','active')`, lte(campaignContacts.nextSendAt, new Date())))
    .orderBy(asc(campaignContacts.nextSendAt))
    .limit(Math.min(budget, 25));

  let queued = 0;
  for (const cc of due) {
    const step = steps[cc.currentStep];
    if (!step) {
      await db.update(campaignContacts).set({ status: "completed", updatedAt: new Date() }).where(eq(campaignContacts.id, cc.id));
      continue;
    }
    await db.update(campaignContacts).set({ status: "active", nextSendAt: null, updatedAt: new Date() }).where(eq(campaignContacts.id, cc.id));
    if (step.channel === "email" || step.channel === "whatsapp") {
      await enqueue(db, "message.send", { campaignId: campaign.id, contactId: cc.id, stepId: step.id }, { orgId: campaign.orgId, priority: 5 });
    } else {
      await createStepTask(campaign, cc.id, cc.leadId, step, steps.length);
    }
    queued++;
  }
  return { sent: queued, reason: "ok" };
}

export function mailerFromAccount(a: EmailAccount): MailerConfig | null {
  if (a.provider === "system") return { provider: "system" };
  const cfg = decryptJson<Record<string, unknown>>(a.configEncrypted);
  if (a.provider === "resend") return { provider: "resend", resendApiKey: String(cfg?.apiKey ?? "") };
  if (a.provider === "smtp") return { provider: "smtp", smtp: { host: String(cfg?.host ?? ""), port: Number(cfg?.port ?? 587), user: cfg?.user ? String(cfg.user) : undefined, pass: cfg?.pass ? String(cfg.pass) : undefined, secure: !!cfg?.secure } };
  return null;
}

/** Render + personalize + send one sequence step to one contact. */
export async function sendStep(campaignId: string, contactId: string, stepId: string) {
  const { db } = getDb();
  const campaign = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaignId) });
  const cc = await db.query.campaignContacts.findFirst({ where: eq(campaignContacts.id, contactId) });
  const step = await db.query.sequenceSteps.findFirst({ where: eq(sequenceSteps.id, stepId) });
  if (!campaign || !cc || !step) return { skipped: "missing" };
  if (campaign.status !== "active") return { skipped: "campaign not active" };
  if (cc.status === "replied" || cc.status === "unsubscribed" || cc.status === "bounced") return { skipped: cc.status };
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, cc.leadId) });
  if (!lead) return { skipped: "lead missing" };
  const company = lead.companyId ? await db.query.companies.findFirst({ where: eq(companies.id, lead.companyId) }) : null;

  if (step.channel === "whatsapp") {
    const phone = lead.whatsapp ?? lead.phone;
    if (!phone) {
      await createStepTask(campaign, cc.id, lead.id, step, 0); // no number → hand to a human
      return { skipped: "no phone, task created" };
    }
    const os = campaign.settings as Record<string, unknown>;
    const vars = leadVars({ ...lead, company: company ? { name: company.name, domain: company.domain, industry: company.industry, description: company.description } : null }, { name: String(os.senderName ?? ""), company: String(os.senderCompany ?? "") });
    const text = renderTemplate(pickVariant(step, cc.variant).bodyTemplate, vars);
    const r = await sendWhatsAppStep(campaign.orgId, phone, text);
    const [wm] = await db.insert(messages).values({ orgId: campaign.orgId, campaignId: campaign.id, stepId: step.id, leadId: lead.id, channel: "whatsapp", toEmail: phone, subject: "(whatsapp)", bodyText: text, status: r.ok ? "sent" : "failed", providerMessageId: r.messageId, error: r.error, sentAt: r.ok ? new Date() : null }).returning();
    if (!r.ok) throw new Error(`whatsapp: ${r.error}`);
    await db.update(campaignContacts).set({ lastMessageId: wm.id, updatedAt: new Date() }).where(eq(campaignContacts.id, cc.id));
    await advanceContact(cc.id);
    await emitEvent(campaign.orgId, "message.sent", { messageId: wm.id, leadId: lead.id, campaignId: campaign.id, channel: "whatsapp" }, { type: "message", id: wm.id });
    return { sent: true, messageId: wm.id, channel: "whatsapp" };
  }

  if (!lead.email) {
    await db.update(campaignContacts).set({ status: "failed", updatedAt: new Date() }).where(eq(campaignContacts.id, cc.id));
    return { skipped: "no email" };
  }
  if (lead.emailStatus === "invalid") {
    await db.update(campaignContacts).set({ status: "failed", updatedAt: new Date() }).where(eq(campaignContacts.id, cc.id));
    return { skipped: "invalid email" };
  }
  const sup = await db.query.suppressions.findFirst({ where: and(eq(suppressions.orgId, campaign.orgId), eq(suppressions.email, lead.email)) });
  if (sup) {
    await db.update(campaignContacts).set({ status: "unsubscribed", updatedAt: new Date() }).where(eq(campaignContacts.id, cc.id));
    return { skipped: "suppressed" };
  }
  const account = campaign.emailAccountId ? await db.query.emailAccounts.findFirst({ where: eq(emailAccounts.id, campaign.emailAccountId) }) : null;
  if (!account) return { skipped: "no account" };

  await consume(db, campaign.orgId, "emails", 1);

  const s = settingsOf(campaign);
  const orgSettings = (await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaignId) }))?.settings as Record<string, unknown> | undefined;
  const sender = {
    name: account.fromName,
    company: String(orgSettings?.senderCompany ?? ""),
    title: orgSettings?.senderTitle ? String(orgSettings.senderTitle) : undefined,
    valueProp: String(orgSettings?.valueProp ?? step.aiInstructions ?? ""),
    signature: account.signature ?? undefined,
    tone: (orgSettings?.tone as "friendly" | undefined) ?? "friendly",
  };
  const prevMsg = cc.lastMessageId ? await db.query.messages.findFirst({ where: eq(messages.id, cc.lastMessageId) }) : null;
  const leadForTpl = { ...lead, company: company ? { name: company.name, domain: company.domain, industry: company.industry, description: company.description } : null };

  const variant = pickVariant(step, cc.variant);
  let subject: string;
  let body: string;
  if (step.aiPersonalize) {
    await consume(db, campaign.orgId, "aiMessages", 1).catch(() => {});
    const out = await generateOutreach(createAiProvider(), {
      lead: leadForTpl,
      sender,
      subjectTemplate: variant.subjectTemplate,
      bodyTemplate: variant.bodyTemplate,
      instructions: step.aiInstructions ?? undefined,
      stepNo: step.stepNo,
      previousSubject: prevMsg?.subject,
    });
    subject = out.subject;
    body = out.body;
  } else {
    const vars = leadVars(leadForTpl, { name: sender.name, company: sender.company, signature: sender.signature });
    subject = renderTemplate(variant.subjectTemplate, vars);
    body = renderTemplate(variant.bodyTemplate, vars);
  }
  if (step.stepNo > 1 && prevMsg && !/^re:/i.test(subject)) subject = `Re: ${prevMsg.subject.replace(/^re:\s*/i, "")}`;

  const token = randomToken(16);
  let html = textToHtml(body);
  if (s.trackClicks) html = html.replace(/href="(https?:\/\/[^"]+)"/g, (_, u) => `href="${env.apiUrl}/t/c/${token}?u=${encodeURIComponent(u)}"`);
  if (s.trackOpens) html += `<img src="${env.apiUrl}/t/o/${token}.gif" width="1" height="1" alt="" style="display:none">`;
  let text = body;
  if (s.unsubscribeFooter) {
    const unsub = `${env.apiUrl}/t/u/${token}`;
    text += `\n\n--\nIf you'd rather not hear from me, reply "unsubscribe" or click: ${unsub}`;
    html += `<p style="color:#888;font-size:12px;margin-top:2em">If you'd rather not hear from me, <a href="${unsub}" style="color:#888">unsubscribe here</a>.</p>`;
  }

  const [msg] = await db
    .insert(messages)
    .values({ orgId: campaign.orgId, campaignId: campaign.id, stepId: step.id, leadId: lead.id, toEmail: lead.email, subject, bodyText: text, bodyHtml: html, trackingToken: token, status: "queued", variant: variant.index })
    .returning();

  const res = await sendMail(mailerFromAccount(account), {
    from: `${account.fromName} <${account.fromEmail}>`,
    to: lead.email,
    subject,
    text,
    html,
    replyTo: account.replyTo ?? account.fromEmail,
    headers: { "X-Prospex-Message": msg.id, "List-Unsubscribe": `<${env.apiUrl}/t/u/${token}>` },
  });

  const today = new Date().toISOString().slice(0, 10);
  if (res.ok) {
    await db.update(messages).set({ status: "sent", sentAt: new Date(), providerMessageId: res.providerMessageId }).where(eq(messages.id, msg.id));
    await db
      .update(emailAccounts)
      .set({ sentToday: account.sentTodayDate === today ? account.sentToday + 1 : 1, sentTodayDate: today })
      .where(eq(emailAccounts.id, account.id));
    const steps = await db.select().from(sequenceSteps).where(eq(sequenceSteps.campaignId, campaign.id)).orderBy(asc(sequenceSteps.stepNo));
    const next = steps[cc.currentStep + 1];
    await db
      .update(campaignContacts)
      .set({
        currentStep: cc.currentStep + 1,
        lastMessageId: msg.id,
        status: next ? "active" : "completed",
        nextSendAt: next ? new Date(Date.now() + next.delayDays * 86_400_000) : null,
        updatedAt: new Date(),
      })
      .where(eq(campaignContacts.id, cc.id));
    await bumpStat(campaign.id, "sent");
    await db.execute(sql`UPDATE leads SET status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END WHERE id = ${lead.id}`);
    await emitEvent(campaign.orgId, "message.sent", { messageId: msg.id, leadId: lead.id, campaignId: campaign.id, to: lead.email, subject, variant: variant.index }, { type: "message", id: msg.id });
    return { sent: true, messageId: msg.id };
  }
  await db.update(messages).set({ status: "failed", error: res.error }).where(eq(messages.id, msg.id));
  await db.update(campaignContacts).set({ status: "queued", nextSendAt: new Date(Date.now() + 30 * 60_000), updatedAt: new Date() }).where(eq(campaignContacts.id, cc.id));
  await bumpStat(campaign.id, "failed");
  throw new Error(`send failed: ${res.error}`);
}

export async function bumpStat(campaignId: string, key: string, n = 1) {
  const { db } = getDb();
  await db.execute(sql`UPDATE campaigns SET stats = jsonb_set(coalesce(stats,'{}'::jsonb), ${`{${key}}`}::text[], (coalesce((stats->>${key})::int,0) + ${n})::text::jsonb), updated_at = now() WHERE id = ${campaignId}`);
}

export async function markReplied(orgId: string, leadEmail: string, intent: string) {
  const { db } = getDb();
  const lead = await db.query.leads.findFirst({ where: and(eq(leads.orgId, orgId), eq(leads.email, leadEmail)) });
  if (!lead) return false;
  const ccs = await db.select().from(campaignContacts).where(and(eq(campaignContacts.leadId, lead.id), sql`${campaignContacts.status} IN ('queued','active')`));
  for (const cc of ccs) {
    await db.update(campaignContacts).set({ status: intent === "unsubscribe" ? "unsubscribed" : "replied", nextSendAt: null, updatedAt: new Date() }).where(eq(campaignContacts.id, cc.id));
    await bumpStat(cc.campaignId, "replied");
    if (cc.lastMessageId) await db.update(messages).set({ status: "replied", repliedAt: new Date() }).where(eq(messages.id, cc.lastMessageId));
  }
  if (intent === "unsubscribe") await db.insert(suppressions).values({ orgId, email: leadEmail, reason: "reply" }).onConflictDoNothing();
  await db.update(leads).set({ tags: sql`array_append(array_remove(${leads.tags}, ${"replied:" + intent}), ${"replied:" + intent})`, updatedAt: new Date() }).where(eq(leads.id, lead.id));
  await bumpEngagement(lead.id, "reply");
  await emitEvent(orgId, "lead.replied", { leadId: lead.id, email: leadEmail, intent }, { type: "lead", id: lead.id });
  return true;
}


/** Manual channels (LinkedIn connect/message, call, custom task) become tasks for a human; the sequence advances when the task is completed. */
export async function createStepTask(campaign: Campaign, contactId: string, leadId: string, step: { id: string; stepNo: number; channel: string; subjectTemplate: string; bodyTemplate: string; aiPersonalize: boolean; aiInstructions: string | null }, totalSteps: number) {
  const { db } = getDb();
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, leadId) });
  const company = lead?.companyId ? await db.query.companies.findFirst({ where: eq(companies.id, lead.companyId) }) : null;
  const os = campaign.settings as Record<string, unknown>;
  const vars = leadVars({ ...(lead ?? {}), company: company ? { name: company.name, domain: company.domain, industry: company.industry, description: company.description } : null }, { name: String(os.senderName ?? ""), company: String(os.senderCompany ?? "") });
  let body = renderTemplate(step.bodyTemplate, vars);
  if (step.aiPersonalize && lead) {
    const out = await generateOutreach(createAiProvider(), { lead: { ...lead, company: company ? { name: company.name, domain: company.domain, industry: company.industry, description: company.description } : null }, sender: { name: String(os.senderName ?? ""), company: String(os.senderCompany ?? ""), valueProp: String(os.valueProp ?? ""), tone: os.tone as "friendly" | undefined }, bodyTemplate: step.bodyTemplate, instructions: `${step.channel === "linkedin_connect" ? "This is a LinkedIn connection note: max 280 characters, no subject." : step.channel === "linkedin_message" ? "This is a LinkedIn DM: short, casual, no subject line." : step.channel === "call" ? "Write a 60-second call opener script." : ""} ${step.aiInstructions ?? ""}`, stepNo: step.stepNo }).catch(() => null);
    if (out?.body) body = out.body;
  }
  const titles: Record<string, string> = { linkedin_connect: "Send LinkedIn connection request", linkedin_message: "Send LinkedIn message", call: "Call", whatsapp: "Send WhatsApp message", task: renderTemplate(step.subjectTemplate, vars) || "Task" };
  const [t] = await db.insert(tasks).values({ orgId: campaign.orgId, leadId, campaignId: campaign.id, contactId, stepId: step.id, type: step.channel, title: `${titles[step.channel] ?? "Task"}: ${lead?.fullName ?? ""}`, body, dueAt: new Date() }).returning();
  await emitEvent(campaign.orgId, "task.created", { taskId: t.id, type: step.channel, leadId, campaignId: campaign.id }, { type: "task", id: t.id });
  void totalSteps;
  return t;
}

/** Advance a contact after a manual/task step is completed. */
export async function advanceContact(contactId: string) {
  const { db } = getDb();
  const cc = await db.query.campaignContacts.findFirst({ where: eq(campaignContacts.id, contactId) });
  if (!cc) return;
  const steps = await db.select().from(sequenceSteps).where(eq(sequenceSteps.campaignId, cc.campaignId)).orderBy(asc(sequenceSteps.stepNo));
  const next = steps[cc.currentStep + 1];
  await db.update(campaignContacts).set({ currentStep: cc.currentStep + 1, status: next ? "active" : "completed", nextSendAt: next ? new Date(Date.now() + next.delayDays * 86_400_000) : null, updatedAt: new Date() }).where(eq(campaignContacts.id, cc.id));
  await bumpStat(cc.campaignId, "sent");
  if (next && next.delayDays === 0) await tickCampaign(cc.campaignId).catch(() => {}); // fire the next step promptly
}

/** Pick an A/B variant for a step (round-robin by contact variant index). */
export function pickVariant(step: { subjectTemplate: string; bodyTemplate: string; variants: { subjectTemplate: string; bodyTemplate: string }[] }, variantIdx: number) {
  const all = [{ subjectTemplate: step.subjectTemplate, bodyTemplate: step.bodyTemplate }, ...(step.variants ?? [])];
  const i = all.length ? variantIdx % all.length : 0;
  return { ...all[i], index: i };
}

/** Engagement scoring: opens +5, clicks +15, replies +40 (capped 100), and lead status progression. */
export async function bumpEngagement(leadId: string | null | undefined, kind: "open" | "click" | "reply") {
  if (!leadId) return;
  const { db } = getDb();
  const delta = kind === "open" ? 5 : kind === "click" ? 15 : 40;
  const status = kind === "reply" ? "replied" : "engaged";
  await db.execute(sql`UPDATE leads SET engagement_score = LEAST(100, engagement_score + ${delta}), last_engaged_at = now(), status = CASE WHEN status IN ('new','contacted','engaged') THEN ${status} ELSE status END, updated_at = now() WHERE id = ${leadId}`);
}

/** WhatsApp send via the org's configured Cloud API integration. */
export async function sendWhatsAppStep(orgId: string, to: string, text: string) {
  const { db } = getDb();
  const integ = await db.query.integrations.findFirst({ where: and(eq(integrations.orgId, orgId), eq(integrations.provider, "whatsapp"), eq(integrations.status, "active")) });
  if (!integ) return { ok: false, error: "WhatsApp integration not configured (Settings → Integrations → WhatsApp Cloud API)" };
  const cfg = decryptCfg<{ phoneNumberId: string; accessToken: string; templateName?: string; templateLanguage?: string }>(integ.configEncrypted);
  if (!cfg?.phoneNumberId || !cfg.accessToken) return { ok: false, error: "WhatsApp config incomplete" };
  const phone = normalizePhone(to, String((integ.settings as Record<string, unknown>).defaultCountryCode ?? "91"));
  // Outbound-first messages must use an approved template; text is passed as the first body parameter.
  const r = cfg.templateName ? await sendWhatsApp(cfg, phone, { template: { name: cfg.templateName, language: cfg.templateLanguage, params: [text] } }) : await sendWhatsApp(cfg, phone, { text });
  return r;
}
