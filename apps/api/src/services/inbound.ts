import { and, campaigns, companies, desc, emailAccounts, eq, getDb, integrations, leads, messages, organizations, sql, type Organization } from "@prospex/db";
import { classifyReply, draftReplyToInbound, hasAi, type AiProvider } from "@prospex/core";
import { aiDisabled, aiForOrg, NO_AI } from "../lib/ai.js";
import { tryConsume } from "../lib/quota.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { canonicalEmail } from "./leads.js";
import { markReplied } from "./campaigns.js";
import { classifyReplyByRules } from "./replyRules.js";
import { env } from "../env.js";

/** Positive-signal intents worth drafting an AI follow-up for. */
const REPLY_WORTHY_INTENTS = new Set(["interested", "referral", "question"]);

/** Every intent the classifier may return. Anything else is stored as "other". */
const REPLY_INTENTS = ["interested", "not_interested", "out_of_office", "unsubscribe", "referral", "question", "bounce", "other"] as const;
type ReplyIntent = (typeof REPLY_INTENTS)[number];
const asIntent = (v: unknown): ReplyIntent => (typeof v === "string" && (REPLY_INTENTS as readonly string[]).includes(v) ? (v as ReplyIntent) : "other");

export interface InboundBody {
  /** Already reduced to one canonical address by the caller (parseSender). */
  email: string;
  text: string;
  subject?: string;
}

export interface InboundResult {
  matched: boolean;
  intent: string;
  confidence: number;
  skipped?: string;
  note?: string;
}

/**
 * Record one reply that arrived for a workspace: classify it, stop or pause the sequence
 * (markReplied), keep the message and, for a positive reply from a known lead, draft an
 * answer.
 *
 * Shared by the signed-in route (POST /v1/campaigns/inbound) and the per-workspace secret
 * address (POST /v1/public/inbound/:token), so both behave exactly alike. `ai` is the
 * engine the workspace may use (aiForOrg); it is only ever handed text from one of the
 * workspace's own leads - mail from anyone else is classified by the built-in rules and goes
 * no further (it arrives by mail forwarding, so it can be newsletters, colleagues, family).
 */
export async function ingestInbound(oid: string, org: Organization | null | undefined, b: InboundBody, ai: AiProvider): Promise<InboundResult> {
  const { db } = getDb();
  const email = b.email;
  const knownSender = await db.query.leads.findFirst({ where: and(eq(leads.orgId, oid), eq(leads.email, email)), columns: { id: true } });
  const aiOff = aiDisabled(org);
  const useAi = knownSender && !aiOff ? ai : NO_AI;
  // Classification is an AI call and is metered like one. Over quota it still runs - on the
  // rule-based path - because marking the reply (which stops the sequence) must never depend
  // on the AI budget. Nothing is charged for a message no model will see, nor when there is
  // no engine to run.
  const clsCharge: Awaited<ReturnType<typeof tryConsume>> = knownSender && !aiOff && hasAi(useAi) ? await tryConsume(db, oid, "aiMessages", 1) : { ok: true };
  const replyText = `${b.subject ?? ""}\n${b.text}`;
  // A provider error (a 429, a timeout) must not drop the reply either: any failure falls
  // back to the rules, which need nothing but the text.
  let aiFailed = false;
  const engine = clsCharge.ok ? useAi : NO_AI;
  let raw: { intent: string; confidence: number } = await classifyReply(engine, replyText).catch(() => {
    aiFailed = true;
    console.warn("[campaigns] reply classification failed, using rules");
    return classifyReplyByRules(replyText);
  });
  // With no model in the loop, core's few rules answer "other" for most real replies ("Sounds
  // interesting, can we talk Thursday?") and misread others. The fuller rules here decide
  // then, unless they have nothing to say.
  if (!aiFailed && !hasAi(engine) && (REPLY_INTENTS as readonly string[]).includes(String(raw?.intent))) {
    const rules = classifyReplyByRules(replyText);
    if (rules.intent !== "other") raw = rules;
  }
  // The intent is model output: it is written to messages.intent and into a lead tag, so it
  // is held to the known set before it is stored anywhere.
  const cls = { intent: asIntent(raw?.intent), confidence: typeof raw?.confidence === "number" && Number.isFinite(raw.confidence) ? Math.min(1, Math.max(0, raw.confidence)) : 0 };
  let aiSkipped: string | undefined = !knownSender ? undefined : aiOff ? "ai_off" : clsCharge.ok ? (aiFailed ? "ai_unavailable" : undefined) : clsCharge.reason === "quota" ? "quota" : "error";
  // The message itself goes along so an out-of-office auto-reply is not taken for a real one.
  const matched = await markReplied(oid, email, cls.intent, { subject: b.subject, text: b.text });
  if (matched) {
    const lead = await db.query.leads.findFirst({ where: and(eq(leads.orgId, oid), eq(leads.email, email)) });
    const company = lead?.companyId ? await db.query.companies.findFirst({ where: and(eq(companies.id, lead.companyId), eq(companies.orgId, oid)) }) : null;
    // Reuse the sender identity from the most recent outbound message to this lead, if any.
    const prevOutbound = lead ? await db.query.messages.findFirst({ where: and(eq(messages.orgId, oid), eq(messages.leadId, lead.id), eq(messages.direction, "outbound")), orderBy: desc(messages.createdAt) }) : null;
    // Both scoped to this workspace: the sender identity read here goes into the AI draft.
    const campaign = prevOutbound?.campaignId ? await db.query.campaigns.findFirst({ where: and(eq(campaigns.id, prevOutbound.campaignId), eq(campaigns.orgId, oid)) }) : null;
    const account = campaign?.emailAccountId ? await db.query.emailAccounts.findFirst({ where: and(eq(emailAccounts.id, campaign.emailAccountId), eq(emailAccounts.orgId, oid)) }) : null;
    const cs = (campaign?.settings ?? {}) as Record<string, unknown>;

    let draftReply: { subject: string; body: string } | null = null;
    // Charged before the call, so a workspace past its cap does not keep getting drafts for free.
    const draftCharge = lead && REPLY_WORTHY_INTENTS.has(cls.intent) && !aiSkipped && hasAi(useAi) ? await tryConsume(db, oid, "aiMessages", 1) : null;
    if (draftCharge && !draftCharge.ok) aiSkipped = draftCharge.reason === "quota" ? "quota" : "error";
    if (lead && draftCharge?.ok) {
      const styleExamples = ((org?.settings as Record<string, unknown> | undefined)?.aiReplyStyleExamples as { subject: string; body: string }[] | undefined) ?? [];
      const ws = (org?.settings ?? {}) as Record<string, unknown>;
      draftReply = await draftReplyToInbound(useAi, {
        inboundText: b.text,
        inboundSubject: b.subject,
        intent: cls.intent,
        lead: { ...lead, company: company ? { name: company.name, domain: company.domain, industry: company.industry, description: company.description } : null },
        sender: {
          name: account?.fromName || (typeof cs.senderName === "string" && cs.senderName) || (typeof ws.senderName === "string" && ws.senderName) || "Me",
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
  const notes: Record<string, string> = {
    quota: "AI quota reached: the reply was classified with rules only and no draft was written.",
    ai_unavailable: "The AI engine did not answer: the reply was classified with rules only and no draft was written.",
    ai_off: "AI assistance is turned off for this workspace: the reply was classified with rules only and no draft was written.",
    error: "Could not record AI usage, so the AI steps were skipped.",
  };
  return { matched, intent: cls.intent, confidence: cls.confidence, ...(aiSkipped ? { skipped: aiSkipped, note: notes[aiSkipped] ?? notes.error } : {}) };
}

/* ─────────────────────────── the per-workspace inbound address ─────────────────────────── */

/**
 * Replies only reached Scout through the signed-in POST /v1/campaigns/inbound, which a mail
 * forwarding service (Zapier, Make, a Gmail forwarder) cannot call without holding an API
 * key - so in practice no reply was ever recorded, and nothing learned from replies.
 *
 * Each workspace can now have one secret address, POST /v1/public/inbound/<token>, that such
 * a service posts {from, subject, text} to. The token is 32 random bytes; only its SHA-256 is
 * stored, in an `integrations` row with provider "inbound" (settings.tokenHash), which is
 * never listed by GET /v1/integrations and cannot be written by the integrations PUT. The
 * token itself is shown once, when it is made; making a new one retires the old one.
 */
export const INBOUND_PROVIDER = "inbound";
/** A token as randomToken(32) writes it: 43 base64url characters. Anything else is not looked up. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export const inboundUrlFor = (token: string) => `${env.apiUrl}/v1/public/inbound/${token}`;

/** Make (or replace) this workspace's inbound token. Returns the token, which is not stored. */
export async function rotateInboundToken(orgId: string): Promise<{ token: string; url: string; createdAt: string }> {
  const { db } = getDb();
  const token = randomToken(32);
  const createdAt = new Date().toISOString();
  const settings = { tokenHash: sha256(token), createdAt };
  await db
    .insert(integrations)
    .values({ orgId, provider: INBOUND_PROVIDER, configEncrypted: null, settings, status: "active" })
    .onConflictDoUpdate({ target: [integrations.orgId, integrations.provider], set: { settings, status: "active", configEncrypted: null } });
  return { token, url: inboundUrlFor(token), createdAt };
}

/** Whether the workspace has an inbound address, and when it was made / last used. Never the token or its hash. */
export async function inboundStatus(orgId: string): Promise<{ configured: boolean; createdAt: string | null; lastUsedAt: string | null; received: number }> {
  const { db } = getDb();
  const row = await db.query.integrations.findFirst({ where: and(eq(integrations.orgId, orgId), eq(integrations.provider, INBOUND_PROVIDER)) });
  const s = (row?.settings ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return { configured: !!row && typeof s.tokenHash === "string", createdAt: str(s.createdAt), lastUsedAt: str(s.lastUsedAt), received: typeof s.received === "number" ? s.received : 0 };
}

/** Switch the inbound address off: the token stops working at once. */
export async function removeInboundToken(orgId: string): Promise<boolean> {
  const { db } = getDb();
  const gone = await db.delete(integrations).where(and(eq(integrations.orgId, orgId), eq(integrations.provider, INBOUND_PROVIDER))).returning({ id: integrations.id });
  return gone.length > 0;
}

/** The workspace a token belongs to, or null. Looked up by hash; a malformed token is not looked up at all. */
export async function orgForInboundToken(token: string): Promise<Organization | null> {
  if (!TOKEN_SHAPE.test(token)) return null;
  const { db } = getDb();
  const hash = sha256(token);
  const [row] = await db
    .select({ orgId: integrations.orgId })
    .from(integrations)
    .where(and(eq(integrations.provider, INBOUND_PROVIDER), sql`${integrations.settings}->>'tokenHash' = ${hash}`))
    .limit(1);
  if (!row) return null;
  return (await db.query.organizations.findFirst({ where: eq(organizations.id, row.orgId) })) ?? null;
}

/** Note that the address was used: shown in Settings so the customer can see their forwarder works. */
export async function touchInboundToken(orgId: string): Promise<void> {
  const { db } = getDb();
  await db
    .execute(
      sql`UPDATE integrations SET settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('lastUsedAt', ${new Date().toISOString()}::text, 'received', coalesce((settings->>'received')::int, 0) + 1) WHERE org_id = ${orgId} AND provider = ${INBOUND_PROVIDER}`,
    )
    .catch(() => {});
}

/** The engine a workspace may use for its own replies (none when it switched AI off). */
export const inboundAiFor = (org: Organization | null | undefined): AiProvider => aiForOrg(org);

export { canonicalEmail };
