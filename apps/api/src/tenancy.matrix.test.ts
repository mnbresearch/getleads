/**
 * Two-tenant authorization matrix over EVERY registered route - the permanent form of the
 * security review's cross-tenant sweep.
 *
 * Two workspaces are seeded with a full object graph each (leads, lists, clients, campaigns,
 * senders, webhooks, pixels, monitors, saved searches ...), every row carrying a marker
 * string unique to its tenant. Then, for every route the app registers:
 *
 *  1. with no credentials (and with a garbage JWT, and an unknown API key) it must answer
 *     401 - or 403/503 for the internal job runner;
 *  2. as tenant B - owner session, API key and member session - it is called with tenant
 *     A's ids in the path, the query string and the body. The answer must be a 4xx (or an
 *     explicitly neutral 2xx) and must not contain A's marker or any of A's ids;
 *  3. afterwards A's rows are byte-identical, and no row outside A references an A id.
 *
 * THE PLAN IS THE CONTRACT. `plan()` has one entry per route. A route that is registered
 * without an entry FAILS this file - so a new endpoint cannot ship without someone deciding,
 * in this table, how it treats another tenant's ids. When that happens: add the entry, with
 * a case for each place the route accepts an id (path, query, body).
 *
 * It runs in its own Postgres schema (`sec_tenancy`) when it may create one, so job queues
 * drained by other test files cannot touch these tenants; otherwise it uses unique orgs in
 * the default schema. Nothing leaves the machine: `fetch` is stubbed and every attempt is
 * refused.
 *
 *   TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npm test -w apps/api
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;
const SCHEMA = "sec_tenancy";

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET ??= "x".repeat(48);
  process.env.ENCRYPTION_KEY ??= "y".repeat(48);
  process.env.SMTP_PROBE_ENABLED = "false";
  process.env.PILOT_MODE = "false";
  process.env.JOB_MODE = "worker"; // routes only enqueue; nothing here drains the queue
  process.env.INTERNAL_TOKEN ??= "internal-token-tenancy-0123456789";
  for (const k of ["RESEND_API_KEY", "SMTP_HOST", "HUNTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GROQ_API_KEY", "GEMINI_API_KEY", "SERPER_API_KEY", "APOLLO_API_KEY", "STRIPE_SECRET_KEY", "IPINFO_TOKEN", "PILOT_INVITE_CODE"]) delete process.env[k];
}

/** No mail leaves this file either; what would have been sent is kept for inspection. */
const mail = vi.hoisted(() => ({ sent: [] as { to: string; subject: string }[] }));
vi.mock("./lib/mailer.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./lib/mailer.js")>();
  return {
    ...orig,
    sendMail: vi.fn(async (_cfg: unknown, input: { to: string; subject: string }) => {
      mail.sent.push({ to: input.to, subject: input.subject });
      return { ok: true, provider: "test", providerMessageId: `t-${Date.now()}` };
    }),
    testMailer: vi.fn(async () => ({ ok: true })),
  };
});

if (!TEST_DB) {
  process.stderr.write(
    `\n[!] ${JSON.stringify("tenancy matrix")} did NOT run: TEST_DATABASE_URL is not set.\n` +
      "    This is the test that proves one workspace cannot read or change another's data, route by route.\n" +
      "    Run it with: TEST_DATABASE_URL=postgres://user@localhost:5432/scout_test npm test -w apps/api\n",
  );
}

const suite = TEST_DB ? describe : describe.skip;

/* eslint-disable @typescript-eslint/no-explicit-any */
let S: any; // @prospex/db
let db: any;
let rawSql: any;
let app: any;

/** Outbound requests the app attempted. Every one is refused. */
const egress: string[] = [];

let ipSeq = 0;
/** A distinct client IP per request, so the per-IP limiters do not couple cases. */
const nextIp = () => `198.51.${Math.floor(++ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;

async function req(method: string, path: string, auth?: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const h: Record<string, string> = { "cf-connecting-ip": nextIp(), ...headers };
  if (auth) {
    if (/^(px_live_|px_test_|gl_)/.test(auth)) h["x-api-key"] = auth;
    else h.authorization = `Bearer ${auth}`;
  }
  if (body !== undefined && !h["content-type"]) h["content-type"] = "application/json";
  const res = await app.request(path, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, text, body: json, headers: res.headers };
}

// ── seeding ──────────────────────────────────────────────────────────────────────────
interface Tenant {
  tag: string; // distinctive marker, e.g. "zqalpha7f3a91c2"
  dom: string; // unique email/company domain for this tenant
  orgId: string;
  ownerId: string;
  ownerEmail: string;
  ownerPassword: string;
  jwt: string;
  apiKey: string; // the "Default" key shown at signup
  apiKeyId: string;
  memberId: string;
  memberEmail: string;
  memberJwt: string;
  ids: Record<string, string>;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const short = () => randomUUID().slice(0, 8);

async function makeTenant(label: string): Promise<Tenant> {
  const tag = `zq${label}${short()}`.toLowerCase();
  const dom = `${tag}.example`;
  const ownerEmail = `owner@${dom}`;
  const ownerPassword = "correct-horse-battery";
  const su = await req("POST", "/v1/auth/signup", null, { email: ownerEmail, password: ownerPassword, name: `${tag} owner`, orgName: `${tag} Org` });
  if (su.status !== 201) throw new Error(`signup failed ${su.status} ${su.text}`);
  const orgId = su.body.org.id as string;
  const ownerId = su.body.user.id as string;
  const jwt = su.body.token as string;
  const apiKey = su.body.apiKey as string;
  // Roomy limits so quota never masks an authorization result.
  await db.update(S.organizations).set({ plan: "scale", planLimits: S.limitsFor("scale") }).where(S.eq(S.organizations.id, orgId));
  const [keyRow] = await db.select().from(S.apiKeys).where(S.eq(S.apiKeys.orgId, orgId));

  // a `member` in the same org, through the real invite + join flow
  const memberEmail = `member@${dom}`;
  const inv = await req("POST", "/v1/tools/team/invite", jwt, { email: memberEmail, role: "member" });
  if (inv.status !== 201) throw new Error(`invite failed ${inv.status} ${inv.text}`);
  const token = new URL(inv.body.link).searchParams.get("token")!;
  const join = await req("POST", "/v1/auth/join", null, { token, password: "member-password-1", name: `${tag} member` });
  if (join.status !== 200) throw new Error(`join failed ${join.status} ${join.text}`);
  const memberId = join.body.user.id as string;
  const memberJwt = join.body.token as string;

  const { encryptJson } = await import("./lib/crypto.js");
  const ids: Record<string, string> = {};
  const ins = async (table: unknown, values: Record<string, unknown>) => (await db.insert(table).values(values).returning())[0];

  const company = await ins(S.companies, { orgId, domain: `corp.${dom}`, name: `${tag} Corp`, industry: `${tag}-industry`, description: `${tag} company description`, aiBrief: { summary: `${tag} brief`, whyNow: "x", angles: [] }, aiBriefAt: new Date() });
  ids.company = company.id;
  ids.companyDomain = company.domain;
  const icp = await ins(S.icps, { orgId, name: `${tag} ICP`, description: `${tag} icp description`, criteria: { titles: ["CEO"], industries: [`${tag}-industry`] }, seedDomains: [`seed.${dom}`] });
  ids.icp = icp.id;
  const client = await ins(S.clients, { orgId, name: `${tag} Client`, domain: `client.${dom}`, icpId: icp.id, notes: `${tag} client notes`, shareToken: randomBytes(32).toString("base64url"), monthlyLeadTarget: 10 });
  ids.client = client.id;
  ids.shareToken = client.shareToken;
  const old = new Date(Date.now() - 20 * 86_400_000);
  // one lead per attention bucket, all owned by the client, plus one pooled lead
  const mk = (n: number, extra: Record<string, unknown>) =>
    ins(S.leads, { orgId, companyId: company.id, icpId: icp.id, firstName: `${tag}first${n}`, lastName: `${tag}last${n}`, fullName: `${tag}first${n} ${tag}last${n}`, title: `${tag} CEO`, phone: `+1555${tag}`, linkedinUrl: `https://www.linkedin.com/in/${tag}-${n}`, tags: [`${tag}-tag`], score: 90, clientId: client.id, clientAssignedAt: old, createdAt: old, custom: { secret: `${tag}-custom` }, ...extra });
  const lead1 = await mk(1, { email: `lead1@${dom}`, emailStatus: "valid" }); // readyButIdle unless enrolled; enrolled below
  const lead2 = await mk(2, { email: `lead2@${dom}`, emailStatus: "valid" }); // readyButIdle
  const lead3 = await mk(3, { email: null }); // noEmail
  const lead4 = await mk(4, { email: `lead4@${dom}`, emailStatus: "unknown" }); // unverified
  const lead5 = await mk(5, { email: `lead5@${dom}`, emailStatus: "invalid" }); // badEmail
  const lead6 = await mk(6, { email: `lead6@${dom}`, emailStatus: "valid", clientId: null, clientAssignedAt: null }); // pool
  Object.assign(ids, { lead: lead1.id, lead2: lead2.id, lead3: lead3.id, lead4: lead4.id, lead5: lead5.id, lead6: lead6.id, leadEmail: lead1.email, lead2Email: lead2.email });
  for (const l of [lead1, lead2, lead3, lead4, lead5]) await db.insert(S.clientLeadDeliveries).values({ clientId: client.id, leadId: l.id });

  const list = await ins(S.lists, { orgId, name: `${tag} List`, description: `${tag} list description`, clientId: client.id });
  ids.list = list.id;
  for (const l of [lead1, lead2, lead3]) await db.insert(S.listLeads).values({ listId: list.id, leadId: l.id });

  const acct = await ins(S.emailAccounts, { orgId, provider: "smtp", fromName: `${tag} Sender`, fromEmail: `sender@${dom}`, configEncrypted: encryptJson({ host: `smtp.${dom}`, port: 587, user: `smtp-user-${tag}`, pass: `smtp-pass-${tag}` }), signature: `${tag} signature` });
  ids.emailAccount = acct.id;
  const campaign = await ins(S.campaigns, { orgId, name: `${tag} Campaign`, status: "paused", icpId: icp.id, listId: list.id, emailAccountId: acct.id, clientId: client.id, settings: { senderCompany: `${tag} sender co`, valueProp: `${tag} value prop` }, stats: { sent: 1 } });
  ids.campaign = campaign.id;
  const step = await ins(S.sequenceSteps, { campaignId: campaign.id, stepNo: 1, subjectTemplate: `${tag} subject A`, bodyTemplate: `${tag} body`, aiPersonalize: false, variants: [{ subjectTemplate: `${tag} subject B`, bodyTemplate: `${tag} body B` }] });
  ids.step = step.id;
  const contact = await ins(S.campaignContacts, { campaignId: campaign.id, leadId: lead1.id, status: "active", currentStep: 0, nextSendAt: new Date() });
  ids.contact = contact.id;
  const failedContact = await ins(S.campaignContacts, { campaignId: campaign.id, leadId: lead4.id, status: "failed", currentStep: 0, lastError: `${tag} stopped for review` });
  ids.failedContact = failedContact.id;
  const trackingToken = randomBytes(16).toString("base64url");
  const out = await ins(S.messages, { orgId, campaignId: campaign.id, stepId: step.id, leadId: lead1.id, direction: "outbound", toEmail: lead1.email, subject: `${tag} outbound subject`, bodyText: `${tag} outbound body https://link.${dom}/x`, bodyHtml: `<p>${tag} html <a href="https://link.${dom}/x">x</a></p>`, status: "sent", sentAt: new Date(), trackingToken, providerMessageId: `prov-${tag}` });
  ids.message = out.id;
  ids.trackingToken = trackingToken;
  await db.update(S.campaignContacts).set({ lastMessageId: out.id }).where(S.eq(S.campaignContacts.id, contact.id));
  const inbound = await ins(S.messages, { orgId, campaignId: campaign.id, leadId: lead1.id, direction: "inbound", toEmail: lead1.email, subject: `${tag} inbound subject`, bodyText: `${tag} inbound body`, status: "received", intent: "interested", draftReply: { subject: `${tag} draft subject`, body: `${tag} draft body` } });
  ids.inbound = inbound.id;

  const supp = await ins(S.suppressions, { orgId, email: `suppressed@${dom}`, reason: "manual" });
  ids.suppression = supp.id;
  const saved = await ins(S.savedSearches, { orgId, name: `${tag} Saved`, query: { query: `${tag} saved query`, clientId: client.id }, listId: list.id, alert: true, alertEmail: `alerts@${dom}` });
  ids.savedSearch = saved.id;
  const ap = await ins(S.autopilots, { orgId, name: `${tag} Autopilot`, query: { query: `${tag} autopilot query` }, icpId: icp.id, listId: list.id, campaignId: campaign.id, autoEnroll: true, active: false });
  ids.autopilot = ap.id;
  const hook = await ins(S.webhooks, { orgId, url: `https://hooks.${dom}/in`, events: ["*"], secret: `whsec-${tag}-${randomBytes(12).toString("hex")}`, active: false });
  ids.webhook = hook.id;
  ids.webhookSecret = hook.secret;
  const integ = await ins(S.integrations, { orgId, provider: label === "alpha" ? "hubspot" : "pipedrive", configEncrypted: encryptJson({ accessToken: `crm-token-${tag}`, apiToken: `crm-token-${tag}` }), settings: { note: `${tag} integration` }, status: "active" });
  ids.integration = integ.id;
  ids.integrationProvider = integ.provider;
  const pixel = await ins(S.pixels, { orgId, key: `px_${randomBytes(12).toString("base64url")}`, name: `${tag} Pixel`, allowedDomains: [] });
  ids.pixel = pixel.id;
  ids.pixelKey = pixel.key;
  const visit = await ins(S.visits, { orgId, pixelId: pixel.id, sessionId: `${tag}-session`, ipHash: sha256(tag), companyDomain: `visitor.${dom}`, companyName: `${tag} Visitor`, page: `/${tag}/pricing` });
  ids.visit = visit.id;
  const vc = await ins(S.visitorCompanies, { orgId, domain: `visitor.${dom}`, name: `${tag} Visitor`, companyId: company.id, visits: 3, sessions: 1, pages: { [`/${tag}/pricing`]: 3 }, intentScore: 60 });
  ids.visitorCompany = vc.id;
  ids.visitorDomain = vc.domain;
  const task = await ins(S.tasks, { orgId, leadId: lead1.id, campaignId: campaign.id, contactId: contact.id, stepId: step.id, type: "call", title: `${tag} Task`, body: `${tag} task body` });
  ids.task = task.id;
  const sub = await ins(S.signalSubscriptions, { orgId, name: `${tag} Subscription`, types: ["funding"], keywords: [`${tag}-kw`], icpId: icp.id, campaignId: campaign.id, active: false });
  ids.subscription = sub.id;
  const sig = await ins(S.signals, { orgId, type: "job_change", companyName: `${tag} Corp`, companyDomain: company.domain, title: `${tag} private job change`, summary: `${tag} moved`, url: `https://signals.${dom}/${short()}` });
  ids.signal = sig.id;
  await db.insert(S.signalMatches).values({ signalId: sig.id, subscriptionId: sub.id, orgId });
  const mon = await ins(S.monitors, { orgId, type: "keyword", name: `${tag} Monitor`, target: `${tag}-target`, active: false });
  ids.monitor = mon.id;
  const mres = await ins(S.monitorResults, { monitorId: mon.id, orgId, kind: "mention", title: `${tag} monitor result`, url: `https://mon.${dom}/1`, snippet: `${tag} snippet`, leadId: lead1.id });
  ids.monitorResult = mres.id;
  const vp = await ins(S.visibilityPrompts, { orgId, text: `${tag} best tools for outreach?`, topic: `${tag}-topic`, active: false });
  ids.prompt = vp.id;
  const vr = await ins(S.visibilityRuns, { orgId, promptId: vp.id, engine: "test", answer: `${tag} visibility answer`, analysis: { note: tag }, brands: [`${tag}-brand`] });
  ids.visibilityRun = vr.id;
  await db.update(S.organizations).set({ settings: { visibility: { brand: { name: `${tag} Brand`, aliases: [], domain: dom }, competitors: [] }, senderCompany: `${tag} sender co` } }).where(S.eq(S.organizations.id, orgId));
  const pendingInvite = await ins(S.invites, { orgId, email: `pending@${dom}`, role: "admin", token: randomBytes(24).toString("base64url"), invitedBy: ownerId, expiresAt: new Date(Date.now() + 14 * 86_400_000) });
  ids.invite = pendingInvite.id;
  ids.inviteToken = pendingInvite.token;
  // an async search and its job, whose result carries lead ids (what GET /v1/search/:id reads back)
  const searchJob = await ins(S.jobs, { orgId, type: "search.run", payload: { query: { query: `${tag} search query` } }, status: "done", result: { results: 2, leadIds: [lead1.id, lead2.id], marker: tag } });
  const search = await ins(S.searches, { orgId, query: { query: `${tag} search query` }, status: "done", resultCount: 2, jobId: searchJob.id, clientId: client.id, completedAt: new Date() });
  ids.search = search.id;
  ids.searchJob = searchJob.id;
  const enrichJob = await ins(S.jobs, { orgId, type: "lead.enrich", payload: { leadId: lead3.id, marker: tag }, status: "done", result: { email: `found@${dom}` } });
  ids.enrichJob = enrichJob.id;
  const ev = await ins(S.events, { orgId, type: "lead.created", entityType: "lead", entityId: lead1.id, data: { email: lead1.email, marker: tag } });
  ids.event = ev.id;
  const run = await ins(S.agentRuns, { orgId, agentType: "discovery", status: "done", rowsCreated: 1, error: `${tag} run note`, completedAt: new Date() });
  ids.agentRun = run.id;
  await ins(S.scrapedLeads, { orgId, leadId: lead1.id, agentRunId: run.id, name: lead1.fullName, company: `${tag} Corp`, email: lead1.email, enrichedData: { query: `${tag} discovery query` }, source: "agent:discovery" });
  await db.insert(S.usage).values({ orgId, period: S.currentPeriod(), metric: "leads", count: 7 }).onConflictDoNothing();
  ids.owner = ownerId;
  ids.member = memberId;
  ids.apiKey = keyRow.id;
  ids.org = orgId;
  return { tag, dom, orgId, ownerId, ownerEmail, ownerPassword, jwt, apiKey, apiKeyId: keyRow.id, memberId, memberEmail, memberJwt, ids };
}

/** Every UUID that identifies one of this tenant's rows. */
function uuidsOf(t: Tenant): string[] {
  return [...new Set(Object.values(t.ids).filter((v) => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(v)))];
}

/**
 * count + content hash of every row a tenant owns, table by table.
 * Tables without org_id are reached through their parent.
 */
async function snapshot(sql: any, orgId: string): Promise<Record<string, { n: number; h: string }>> {
  const out: Record<string, { n: number; h: string }> = {};
  const tables: { table_name: string }[] = await sql`SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'org_id' ORDER BY 1`;
  for (const { table_name: t } of tables) {
    // api_keys.last_used_at is stamped on every authenticated call by its own tenant; not a cross-tenant write.
    const [r] = await sql.unsafe(`SELECT count(*)::int AS n, coalesce(md5(string_agg(md5(x::text), '' ORDER BY md5(x::text))), '') AS h FROM (SELECT * FROM "${t}" WHERE org_id = $1) x`, [orgId]);
    out[t] = { n: r.n, h: r.h };
  }
  const children: Record<string, string> = {
    organizations: `SELECT * FROM organizations WHERE id = $1`,
    list_leads: `SELECT ll.* FROM list_leads ll JOIN lists l ON l.id = ll.list_id WHERE l.org_id = $1`,
    sequence_steps: `SELECT s.* FROM sequence_steps s JOIN campaigns c ON c.id = s.campaign_id WHERE c.org_id = $1`,
    campaign_contacts: `SELECT cc.* FROM campaign_contacts cc JOIN campaigns c ON c.id = cc.campaign_id WHERE c.org_id = $1`,
    client_lead_deliveries: `SELECT d.* FROM client_lead_deliveries d JOIN clients c ON c.id = d.client_id WHERE c.org_id = $1`,
    password_reset_tokens: `SELECT p.* FROM password_reset_tokens p JOIN users u ON u.id = p.user_id WHERE u.org_id = $1`,
  };
  for (const [t, q] of Object.entries(children)) {
    const [r] = await sql.unsafe(`SELECT count(*)::int AS n, coalesce(md5(string_agg(md5(x::text), '' ORDER BY md5(x::text))), '') AS h FROM (${q}) x`, [orgId]);
    out[t] = { n: r.n, h: r.h };
  }
  return out;
}

function diffSnapshots(a: Record<string, { n: number; h: string }>, b: Record<string, { n: number; h: string }>): string[] {
  const d: string[] = [];
  for (const t of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!a[t] || !b[t]) d.push(`${t}: table set changed`);
    else if (a[t].n !== b[t].n) d.push(`${t}: row count ${a[t].n} -> ${b[t].n}`);
    else if (a[t].h !== b[t].h) d.push(`${t}: content changed (${a[t].n} rows)`);
  }
  return d;
}

/**
 * Rows that do NOT belong to `victim` but mention one of its UUIDs or its marker: a foreign
 * key planted across the tenant boundary, or a job queued in someone else's name against it.
 */
async function foreignReferences(sql: any, victim: Tenant, echoes: string[] = []): Promise<string[]> {
  const strip = (j: string) => {
    let o = j.toLowerCase();
    for (const e of [...echoes].sort((x, y) => y.length - x.length)) o = o.split(e).join("");
    return o;
  };
  const needles = [...uuidsOf(victim).filter((u) => u !== victim.orgId), victim.tag];
  const hits: string[] = [];
  const tables: { table_name: string }[] = await sql`SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'org_id' ORDER BY 1`;
  for (const { table_name: t } of tables) {
    // The audit log is where a refused cross-tenant request is SUPPOSED to be written down,
    // under the attacker's own workspace, naming the id it asked for. That it never lands
    // in the victim's log is checked by the snapshot (audit_log has org_id).
    if (t === "audit_log") continue;
    const rows: { j: string }[] = await sql.unsafe(`SELECT x::text AS j FROM "${t}" x WHERE org_id IS DISTINCT FROM $1`, [victim.orgId]);
    for (const r of rows) for (const n of needles) if (strip(r.j).includes(n)) hits.push(`${t}: ${r.j.slice(0, 260)}`);
  }
  const kids: Record<string, string> = {
    list_leads: `SELECT ll::text AS j FROM list_leads ll JOIN lists l ON l.id = ll.list_id WHERE l.org_id <> $1`,
    sequence_steps: `SELECT s::text AS j FROM sequence_steps s JOIN campaigns c ON c.id = s.campaign_id WHERE c.org_id <> $1`,
    campaign_contacts: `SELECT cc::text AS j FROM campaign_contacts cc JOIN campaigns c ON c.id = cc.campaign_id WHERE c.org_id <> $1`,
    client_lead_deliveries: `SELECT d::text AS j FROM client_lead_deliveries d JOIN clients c ON c.id = d.client_id WHERE c.org_id <> $1`,
  };
  for (const [t, q] of Object.entries(kids)) {
    const rows: { j: string }[] = await sql.unsafe(q, [victim.orgId]);
    for (const r of rows) for (const n of needles) if (strip(r.j).includes(n)) hits.push(`${t}: ${r.j.slice(0, 260)}`);
  }
  return [...new Set(hits)];
}

// ── the plan ─────────────────────────────────────────────────────────────────────────

type Case = { name: string; path: string; body?: unknown; ok2xx?: boolean; also?: number[]; headers?: Record<string, string>; echoesOwnHistory?: boolean };
type Entry = { cls: "public" | "auth" | "admin" | "internal"; refs?: string; cases?: Case[]; skip?: string };

const BUCKETS = ["noEmail", "unverified", "badEmail", "readyButIdle"];

function plan(A: Tenant, B: Tenant): Record<string, Entry> {
  const a = A.ids;
  const b = B.ids;
  const pub = (why = "public by design - covered by security.auth.test.ts"): Entry => ({ cls: "public", skip: why });
  const list = (path: string, refs = "none (collection scoped by session org)"): Entry => ({ cls: "auth", refs, cases: [{ name: "list as B", path, ok2xx: true }] });
  const noref = (why: string): Entry => ({ cls: "auth", refs: "none", skip: why });
  const X = (name: string, path: string, body?: unknown, ok2xx = false): Case => ({ name, path, body, ok2xx });
  const E = (refs: string, ...cases: Case[]): Entry => ({ cls: "auth", refs, cases });
  const provider = "no object reference; a valid call fans out to external providers (fetch is stubbed in this file)";

  const leadFilters = [
    "",
    `?listId=${a.list}`,
    `?clientId=${a.client}`,
    `?icpId=${a.icp}`,
    `?tag=${A.tag}-tag`,
    `?companyDomain=${a.companyDomain}`,
    `?q=${A.tag}`,
    `?q=lead1%40${A.dom}`,
    ...BUCKETS.map((k) => `?attention=${k}`),
    ...BUCKETS.map((k) => `?attention=${k}&clientId=${a.client}`),
    `?clientId=none`,
    `?status=new&hasEmail=true&emailStatus=valid,unknown,invalid`,
    `?listId=${a.list}&clientId=${a.client}&icpId=${a.icp}&companyDomain=${a.companyDomain}`,
    `?limit=500&sort=score&order=desc&minScore=0`,
  ];

  return {
    // ── infrastructure / public ──
    "GET /": pub("static service descriptor"),
    "GET /health": pub("health check"),
    "GET /openapi.json": pub("static spec"),
    "GET /docs": pub("static docs"),
    "POST /v1/auth/signup": pub(),
    "POST /v1/auth/login": pub(),
    "POST /v1/auth/password/forgot": pub(),
    "POST /v1/auth/password/reset": pub(),
    "GET /v1/auth/google/status": pub(),
    "GET /v1/auth/google/start": pub(),
    "GET /v1/auth/google/callback": pub(),
    "POST /v1/auth/join": pub(),
    "POST /v1/auth/google/exchange": pub("one-time code exchange; covered by security.auth.test.ts"),
    "GET /v1/public/clients/report/:token": pub(),
    "GET /px/:file": pub(),
    "OPTIONS /px/:key/collect": pub(),
    "POST /px/:key/collect": pub(),
    "GET /t/o/:token": pub(),
    "GET /t/c/:token": pub(),
    "GET /t/u/:token": pub(),
    "POST /t/u/:token": pub(),
    "GET /v1/billing/plans": pub("static plan catalogue"),
    "POST /v1/billing/webhook": pub("Stripe-signed; out of scope without a Stripe secret"),
    "POST /v1/upgrade-requests": pub(),
    "POST /v1/email-events/resend": pub("provider-signed; covered by security.auth.test.ts"),
    "POST /internal/jobs/run": { cls: "internal", skip: "INTERNAL_TOKEN; covered by security.auth.test.ts" },
    "GET /internal/jobs/run": { cls: "internal", skip: "INTERNAL_TOKEN; covered by security.auth.test.ts" },

    // ── admin (must refuse every customer credential) ──
    "POST /v1/admin/login": pub("admin credential endpoint; covered by security.auth.test.ts"),
    "GET /v1/admin/session": { cls: "admin", cases: [X("customer credential", "/v1/admin/session")] },
    "POST /v1/admin/logout": { cls: "admin", cases: [X("customer credential", "/v1/admin/logout", {})] },
    "GET /v1/admin/orgs": { cls: "admin", cases: [X("customer credential", `/v1/admin/orgs?q=${A.tag}`)] },
    "GET /v1/admin/orgs/:id": { cls: "admin", cases: [X("customer credential", `/v1/admin/orgs/${a.org}`)] },
    "PATCH /v1/admin/orgs/:id/plan": { cls: "admin", cases: [X("self-upgrade", `/v1/admin/orgs/${b.org}/plan`, { plan: "enterprise" }), X("downgrade A", `/v1/admin/orgs/${a.org}/plan`, { plan: "free" })] },
    "PATCH /v1/admin/orgs/:id/status": { cls: "admin", cases: [X("suspend A", `/v1/admin/orgs/${a.org}/status`, { status: "revoked" })] },
    "PATCH /v1/admin/orgs/:id/credits": { cls: "admin", cases: [X("grant self credits", `/v1/admin/orgs/${b.org}/credits`, { metric: "leads", action: "set", amount: 0 })] },
    "GET /v1/admin/plans": { cls: "admin", cases: [X("customer credential", "/v1/admin/plans")] },
    "GET /v1/admin/upgrade-requests": { cls: "admin", cases: [X("customer credential", "/v1/admin/upgrade-requests")] },
    "PATCH /v1/admin/upgrade-requests/:id": { cls: "admin", cases: [X("customer credential", `/v1/admin/upgrade-requests/${randomUUID()}`, { status: "dismissed" })] },
    "GET /v1/admin/balances": { cls: "admin", cases: [X("customer credential", "/v1/admin/balances")] },
    "GET /v1/admin/tools": { cls: "admin", cases: [X("customer credential", "/v1/admin/tools")] },
    "POST /v1/admin/tools/check": { cls: "admin", cases: [X("customer credential", "/v1/admin/tools/check", {})] },
    "PATCH /v1/admin/tools/:provider": { cls: "admin", cases: [X("customer credential", "/v1/admin/tools/hunter", { usageLimit: 0 })] },

    // ── auth / org / keys ──
    "POST /v1/auth/password/change": noref("acts on the calling user only; session behaviour covered by security.auth.test.ts"),
    "POST /v1/auth/logout-all": noref("acts on the calling user only (it would end the session this sweep runs on)"),
    "GET /v1/auth/me": list("/v1/auth/me"),
    // The caller's own audit trail. It legitimately contains ids the caller itself sent in
    // refused requests (that is what a `denied` row records), so those are not a disclosure.
    "GET /v1/audit-log": E("none (collection scoped by session org)", { ...X("own audit trail", "/v1/audit-log?limit=200", undefined, true), echoesOwnHistory: true }),
    "PATCH /v1/auth/org": E("none in path; body tries to name another org", X("body names org A", "/v1/auth/org", { name: `${B.tag} Org`, id: a.org, orgId: a.org, slug: `${A.tag}-org` }, true)),
    "GET /v1/auth/api-keys": list("/v1/auth/api-keys"),
    "POST /v1/auth/api-keys": noref("mints a key for the caller's own org; role gate covered by security.auth.test.ts"),
    "DELETE /v1/auth/api-keys/:id": E("path :id", X("revoke A's key", `/v1/auth/api-keys/${a.apiKey}`)),

    // ── leads ──
    "GET /v1/leads": E("query listId, clientId, icpId, tag, companyDomain, q, attention", ...leadFilters.map((f) => X(`filter ${f || "(none)"}`, `/v1/leads${f}`, undefined, true))),
    "GET /v1/leads/export.csv": E("query listId, clientId, icpId, tag, companyDomain, q, attention", ...leadFilters.map((f) => X(`export ${f || "(none)"}`, `/v1/leads/export.csv${f}`, undefined, true))),
    "POST /v1/leads": E(
      "body icpId (+ unknown id fields)",
      X("icpId of A", "/v1/leads", { email: `x1@${B.dom}`, firstName: "X", icpId: a.icp }),
      X("A's lead email + stray A ids", "/v1/leads", { email: a.leadEmail, firstName: "Bcopy", orgId: a.org, id: a.lead, clientId: a.client, companyId: a.company, listId: a.list }, true),
    ),
    "POST /v1/leads/import": E("body rows", X("row with A's lead email", "/v1/leads/import", [{ email: a.lead2Email, name: "Bcopy Two" }], true)),
    "POST /v1/leads/bulk/delete": E("body ids[]", X("delete A's leads", "/v1/leads/bulk/delete", { ids: [a.lead, a.lead2, a.lead3] }, true)),
    "POST /v1/leads/bulk/tag": E("body ids[]", X("tag A's leads", "/v1/leads/bulk/tag", { ids: [a.lead, a.lead2], add: ["pwned"], remove: [`${A.tag}-tag`] }, true)),
    "POST /v1/leads/bulk/enrich": E("body ids[]", X("enrich A's leads", "/v1/leads/bulk/enrich", { ids: [a.lead3, a.lead4] }, true)),
    "GET /v1/leads/lists/all": list("/v1/leads/lists/all"),
    "POST /v1/leads/lists": E("body clientId", X("list under A's client", "/v1/leads/lists", { name: "x", clientId: a.client })),
    "DELETE /v1/leads/lists/:listId": E("path :listId", X("delete A's list", `/v1/leads/lists/${a.list}`)),
    "POST /v1/leads/lists/:listId/leads": E(
      "path :listId, body ids[]",
      X("A list + A leads", `/v1/leads/lists/${a.list}/leads`, { ids: [a.lead4] }),
      X("A list + B leads", `/v1/leads/lists/${a.list}/leads`, { ids: [b.lead] }),
      X("B list + A leads", `/v1/leads/lists/${b.list}/leads`, { ids: [a.lead, a.lead2] }, true),
    ),
    "DELETE /v1/leads/lists/:listId/leads/:leadId": E("path :listId, :leadId", X("A list + A lead", `/v1/leads/lists/${a.list}/leads/${a.lead}`), X("B list + A lead", `/v1/leads/lists/${b.list}/leads/${a.lead}`)),
    "GET /v1/leads/suppressions/all": list("/v1/leads/suppressions/all"),
    "POST /v1/leads/suppressions": E("none (address only)", X("A's suppressed address", "/v1/leads/suppressions", { emails: [`suppressed@${A.dom}`.replace(A.dom, B.dom)] }, true)),
    "GET /v1/leads/hot/list": list("/v1/leads/hot/list?limit=200"),
    "GET /v1/leads/:id": E("path :id", X("read A's lead", `/v1/leads/${a.lead}`)),
    "GET /v1/leads/:id/priority": E("path :id", X("A's lead", `/v1/leads/${a.lead}/priority`)),
    "PATCH /v1/leads/:id": E("path :id, body icpId", X("edit A's lead", `/v1/leads/${a.lead}`, { title: "pwned" }), X("B lead, icpId of A", `/v1/leads/${b.lead}`, { icpId: a.icp }), X("B lead, A's company domain", `/v1/leads/${b.lead6}`, { companyDomain: a.companyDomain }, true)),
    "DELETE /v1/leads/:id": E("path :id", X("delete A's lead", `/v1/leads/${a.lead}`)),
    "POST /v1/leads/:id/enrich": E("path :id", X("A's lead", `/v1/leads/${a.lead3}/enrich`, {})),
    "POST /v1/leads/:id/verify": E("path :id", X("A's lead", `/v1/leads/${a.lead4}/verify`, {})),
    "POST /v1/leads/:id/find-email": E("path :id", X("A's lead", `/v1/leads/${a.lead3}/find-email?domain=${a.companyDomain}`, {})),

    // ── clients ──
    "GET /v1/clients": E("none", X("list", "/v1/clients", undefined, true), X("list incl. archived", "/v1/clients?includeArchived=true", undefined, true)),
    "POST /v1/clients": E("body icpId", X("client on A's ICP", "/v1/clients", { name: `x-${randomUUID().slice(0, 6)}`, icpId: a.icp })),
    "GET /v1/clients/routing": list("/v1/clients/routing?limit=1000"),
    "POST /v1/clients/routing/auto": E("body leadIds[]", X("route A's pooled lead", "/v1/clients/routing/auto", { leadIds: [a.lead6, a.lead] }, true)),
    "POST /v1/clients/unassign": E("body leadIds[]", X("unassign A's leads", "/v1/clients/unassign", { leadIds: [a.lead, a.lead2] }, true)),
    "POST /v1/clients/pool/act": noref("acts on the caller's own unassigned pool; enqueues jobs for its own leads only"),
    "GET /v1/clients/:id": E("path :id", X("A's client", `/v1/clients/${a.client}`)),
    "PATCH /v1/clients/:id": E("path :id, body icpId", X("edit A's client", `/v1/clients/${a.client}`, { name: "pwned" }), X("B client on A's ICP", `/v1/clients/${b.client}`, { icpId: a.icp })),
    "DELETE /v1/clients/:id": E("path :id", X("delete A's client", `/v1/clients/${a.client}`)),
    "POST /v1/clients/:id/assign": E(
      "path :id, body leadIds[]",
      X("A client + A leads", `/v1/clients/${a.client}/assign`, { leadIds: [a.lead6], move: true }),
      X("A client + B leads", `/v1/clients/${a.client}/assign`, { leadIds: [b.lead6], move: true }),
      X("B client + A leads (move)", `/v1/clients/${b.client}/assign`, { leadIds: [a.lead, a.lead6], move: true }, true),
    ),
    "GET /v1/clients/:id/attention/:bucket": E("path :id", ...BUCKETS.map((k) => X(`A's client ${k}`, `/v1/clients/${a.client}/attention/${k}`))),
    "POST /v1/clients/:id/act": E("path :id", ...["enrich", "verify", "list"].map((act) => X(`A's client ${act}`, `/v1/clients/${a.client}/act`, { bucket: act === "list" ? "readyButIdle" : act === "verify" ? "unverified" : "noEmail", action: act }))),
    "POST /v1/clients/:id/share": E("path :id", X("mint a report link for A's client", `/v1/clients/${a.client}/share`, {})),
    "DELETE /v1/clients/:id/share": E("path :id", X("kill A's report link", `/v1/clients/${a.client}/share`)),

    // ── search + jobs ──
    "POST /v1/search": E("body icpId, listId, clientId", X("A's ICP", "/v1/search", { query: "ceo at saas", icpId: a.icp }), X("A's list", "/v1/search", { query: "ceo at saas", listId: a.list }), X("A's client", "/v1/search", { query: "ceo at saas", clientId: a.client })),
    "GET /v1/search": list("/v1/search"),
    "GET /v1/search/:id": E("path :id", X("A's search (reads job.result.leadIds)", `/v1/search/${a.search}`)),
    "POST /v1/search/quick": E("body icpId, listId, clientId", X("A's ICP", "/v1/search/quick", { query: "ceo at saas", icpId: a.icp, save: true }), X("A's list", "/v1/search/quick", { query: "ceo at saas", listId: a.list, save: true }), X("A's client", "/v1/search/quick", { query: "ceo at saas", clientId: a.client, save: true })),
    "POST /v1/search/parse": noref(provider),
    "POST /v1/search/people": noref(provider),
    "POST /v1/search/companies": noref(provider),
    "POST /v1/search/company/enrich": noref(provider),
    "POST /v1/search/verify": noref(provider),
    "POST /v1/search/find-email": noref(provider),
    "GET /v1/search/jobs/:jobId": E("path :jobId", X("A's search.run job (result holds lead ids)", `/v1/search/jobs/${a.searchJob}`), X("A's lead.enrich job", `/v1/search/jobs/${a.enrichJob}`), X("org-less scheduler job", `/v1/search/jobs/${a.__schedulerJob}`)),

    // ── ICPs ──
    "GET /v1/icps": list("/v1/icps"),
    "POST /v1/icps": E("body clientId", X("ICP for A's client", "/v1/icps", { name: "x", clientId: a.client, buildWithAi: false })),
    "GET /v1/icps/:id": E("path :id", X("A's ICP", `/v1/icps/${a.icp}`)),
    "PATCH /v1/icps/:id": E("path :id, body clientId", X("edit A's ICP", `/v1/icps/${a.icp}`, { name: "pwned" }), X("B ICP -> A's client", `/v1/icps/${b.icp}`, { clientId: a.client })),
    "DELETE /v1/icps/:id": E("path :id", X("delete A's ICP", `/v1/icps/${a.icp}`)),
    "POST /v1/icps/:id/build": E("path :id", X("A's ICP", `/v1/icps/${a.icp}/build`, {})),
    "POST /v1/icps/:id/chat": E("path :id", X("A's ICP", `/v1/icps/${a.icp}/chat`, { message: "show criteria" })),
    "POST /v1/icps/:id/score": E("path :id, body leadIds[]", X("A's ICP", `/v1/icps/${a.icp}/score`, { assign: true }), X("B ICP over A's leads", `/v1/icps/${b.icp}/score`, { leadIds: [a.lead, a.lead6], assign: true, useLearning: false }, true)),

    // ── companies ──
    "GET /v1/companies/:id": E("path :id", X("A's company", `/v1/companies/${a.company}`)),
    "POST /v1/companies/:id/brief": E("path :id", X("A's cached brief", `/v1/companies/${a.company}/brief`, {})),

    // ── campaigns ──
    "GET /v1/campaigns/email-accounts": list("/v1/campaigns/email-accounts"),
    "POST /v1/campaigns/email-accounts": noref("creates a sender for the caller's org and opens an SMTP connection (SSRF surface: security.ssrf.test.ts)"),
    "POST /v1/campaigns/email-accounts/:id/retest": E("path :id", X("retest A's sender", `/v1/campaigns/email-accounts/${a.emailAccount}/retest`, {})),
    "DELETE /v1/campaigns/email-accounts/:id": E("path :id", X("delete A's sender", `/v1/campaigns/email-accounts/${a.emailAccount}`)),
    "GET /v1/campaigns": list("/v1/campaigns"),
    "POST /v1/campaigns": E(
      "body emailAccountId, icpId, listId, clientId",
      X("A's sender", "/v1/campaigns", { name: "x", emailAccountId: a.emailAccount }),
      X("A's ICP", "/v1/campaigns", { name: "x", icpId: a.icp }),
      X("A's list", "/v1/campaigns", { name: "x", listId: a.list }),
      X("A's client", "/v1/campaigns", { name: "x", clientId: a.client }),
    ),
    "GET /v1/campaigns/:id": E("path :id", X("A's campaign", `/v1/campaigns/${a.campaign}`)),
    "PATCH /v1/campaigns/:id": E(
      "path :id, body emailAccountId, icpId, listId, clientId, steps[].id",
      X("edit A's campaign", `/v1/campaigns/${a.campaign}`, { name: "pwned" }),
      X("B campaign -> A's sender", `/v1/campaigns/${b.campaign}`, { emailAccountId: a.emailAccount }),
      X("B campaign -> A's ICP", `/v1/campaigns/${b.campaign}`, { icpId: a.icp }),
      X("B campaign -> A's list", `/v1/campaigns/${b.campaign}`, { listId: a.list }),
      X("B campaign -> A's client", `/v1/campaigns/${b.campaign}`, { clientId: a.client }),
      X("B campaign, step carrying A's step id", `/v1/campaigns/${b.campaign}`, { steps: [{ id: b.step, bodyTemplate: `${B.tag} body`, subjectTemplate: "s" }, { id: a.step, bodyTemplate: "hijack", subjectTemplate: "hijack" }] }, true),
    ),
    "DELETE /v1/campaigns/:id": E("path :id", X("delete A's campaign", `/v1/campaigns/${a.campaign}`)),
    "POST /v1/campaigns/:id/enroll": E(
      "path :id, body leadIds[]",
      X("A campaign + A leads", `/v1/campaigns/${a.campaign}/enroll`, { leadIds: [a.lead2] }),
      X("A campaign fromList", `/v1/campaigns/${a.campaign}/enroll`, { fromList: true }),
      X("B campaign + A leads", `/v1/campaigns/${b.campaign}/enroll`, { leadIds: [a.lead, a.lead2], minScore: 0 }, true),
    ),
    "GET /v1/campaigns/:id/experiments": E("path :id", X("A's A/B results", `/v1/campaigns/${a.campaign}/experiments`)),
    "POST /v1/campaigns/:id/start": E("path :id", X("start A's campaign", `/v1/campaigns/${a.campaign}/start`, {})),
    "POST /v1/campaigns/:id/pause": E("path :id", X("pause A's campaign", `/v1/campaigns/${a.campaign}/pause`, {})),
    "POST /v1/campaigns/:id/contacts/:contactId/resume": E(
      "path :id, :contactId",
      X("A campaign + A contact", `/v1/campaigns/${a.campaign}/contacts/${a.failedContact}/resume`, { resend: true }),
      X("B campaign + A contact", `/v1/campaigns/${b.campaign}/contacts/${a.failedContact}/resume`, { resend: true }),
    ),
    "GET /v1/campaigns/:id/contacts": E("path :id", X("A's contacts", `/v1/campaigns/${a.campaign}/contacts`)),
    "GET /v1/campaigns/:id/messages": E("path :id", X("A's messages", `/v1/campaigns/${a.campaign}/messages`)),
    "POST /v1/campaigns/:id/preview": E("path :id, body leadId", X("A campaign + A lead", `/v1/campaigns/${a.campaign}/preview`, { leadId: a.lead }), X("B campaign + A lead", `/v1/campaigns/${b.campaign}/preview`, { leadId: a.lead })),
    "POST /v1/campaigns/generate": E("body leadId", X("draft from A's lead", "/v1/campaigns/generate", { leadId: a.lead, sender: { name: "B", company: "B", valueProp: "v" } })),
    "POST /v1/campaigns/inbound": E("body from (address)", X("fake a reply from A's lead", "/v1/campaigns/inbound", { from: a.leadEmail, text: "unsubscribe me", subject: "unsubscribe" }, true)),
    "POST /v1/campaigns/messages/:id/send-reply": E("path :id", X("send A's drafted reply", `/v1/campaigns/messages/${a.inbound}/send-reply`, {}), X("A's outbound message", `/v1/campaigns/messages/${a.message}/send-reply`, { subject: "s", body: "b" })),
    "GET /v1/campaigns/:id/stats": E("path :id", X("A's stats", `/v1/campaigns/${a.campaign}/stats`)),

    // ── visibility ──
    "GET /v1/visibility/config": list("/v1/visibility/config"),
    "PUT /v1/visibility/config": noref("writes the caller's own org settings; no object reference"),
    "GET /v1/visibility/prompts": list("/v1/visibility/prompts"),
    "POST /v1/visibility/prompts": noref("creates a prompt for the caller's org; no object reference"),
    "PATCH /v1/visibility/prompts/:id": E("path :id", X("edit A's prompt", `/v1/visibility/prompts/${a.prompt}`, { active: true })),
    "DELETE /v1/visibility/prompts/:id": E("path :id", X("delete A's prompt", `/v1/visibility/prompts/${a.prompt}`)),
    "POST /v1/visibility/prompts/:id/run": E("path :id", X("run A's prompt", `/v1/visibility/prompts/${a.prompt}/run`, {})),
    "POST /v1/visibility/prompts/suggest": noref("reads the caller's own config; no object reference"),
    "POST /v1/visibility/prompts/bulk": noref("creates prompts for the caller's org; no object reference"),
    "GET /v1/visibility/engines": list("/v1/visibility/engines"),
    "GET /v1/visibility/overview": list("/v1/visibility/overview?days=90"),
    "GET /v1/visibility/observations": E("query promptId", X("all", "/v1/visibility/observations?days=90", undefined, true), X("A's prompt", `/v1/visibility/observations?days=90&promptId=${a.prompt}`, undefined, true)),
    "GET /v1/visibility/runs": E("query promptId", X("all", "/v1/visibility/runs?limit=100", undefined, true), X("A's prompt", `/v1/visibility/runs?promptId=${a.prompt}&limit=100`, undefined, true)),

    // ── agent / automation ──
    "POST /v1/agent/prospect": noref(provider),
    "GET /v1/agent/capabilities": list("/v1/agent/capabilities"),
    "POST /v1/automation/discover": E("body icpId", { ...X("score against A's ICP (preview)", "/v1/automation/discover", { query: "ceo at saas companies", count: 1, icpId: a.icp, preview: true }, true), also: [502] }),
    "POST /v1/automation/linkedin-scrape": E("body icpId", { ...X("score against A's ICP (preview)", "/v1/automation/linkedin-scrape", { query: "ceo at saas companies", count: 1, icpId: a.icp, preview: true }, true), also: [502] }),
    "GET /v1/automation/leads": E("query runId, company", X("all", "/v1/automation/leads?limit=500", undefined, true), X("A's run", `/v1/automation/leads?runId=${a.agentRun}`, undefined, true), X("A's company", `/v1/automation/leads?company=${encodeURIComponent(`${A.tag} Corp`)}`, undefined, true)),
    "GET /v1/automation/runs": list("/v1/automation/runs?limit=100"),

    // ── visitors ──
    "GET /v1/visitors/pixels": list("/v1/visitors/pixels"),
    "POST /v1/visitors/pixels": noref("creates a pixel for the caller's org; no object reference"),
    "DELETE /v1/visitors/pixels/:id": E("path :id", X("delete A's pixel", `/v1/visitors/pixels/${a.pixel}`)),
    "GET /v1/visitors": list("/v1/visitors?days=365&limit=500"),
    "GET /v1/visitors/:domain/visits": E("path :domain", X("A's visitor domain", `/v1/visitors/${a.visitorDomain}/visits`)),
    "PATCH /v1/visitors/:domain": E("path :domain", X("A's visitor domain", `/v1/visitors/${a.visitorDomain}`, { status: "ignored" })),
    "POST /v1/visitors/:domain/decision-makers": E("path :domain", X("A's visitor domain", `/v1/visitors/${a.visitorDomain}/decision-makers`, { save: true })),

    // ── signals / monitors ──
    "GET /v1/signals": E("query q, type", X("feed", "/v1/signals?days=365&limit=500", undefined, true), X("feed q=marker", `/v1/signals?days=365&q=${A.tag}`, undefined, true), X("feed type=job_change", "/v1/signals?days=365&type=job_change&matched=true", undefined, true)),
    "GET /v1/signals/types": list("/v1/signals/types"),
    "POST /v1/signals/job-changes/scan": noref(provider),
    "GET /v1/signals/job-changes": list("/v1/signals/job-changes?days=365&limit=200"),
    "POST /v1/signals/scan": noref(provider),
    "GET /v1/signals/subscriptions": list("/v1/signals/subscriptions"),
    "POST /v1/signals/subscriptions": E("body campaignId, icpId", X("A's campaign", "/v1/signals/subscriptions", { name: "x", types: ["funding"], campaignId: a.campaign, active: false }), X("A's ICP", "/v1/signals/subscriptions", { name: "x", types: ["funding"], icpId: a.icp, active: false })),
    "PATCH /v1/signals/subscriptions/:id": E("path :id, body campaignId, icpId", X("edit A's subscription", `/v1/signals/subscriptions/${a.subscription}`, { name: "pwned" }), X("B sub -> A's campaign", `/v1/signals/subscriptions/${b.subscription}`, { campaignId: a.campaign }), X("B sub -> A's ICP", `/v1/signals/subscriptions/${b.subscription}`, { icpId: a.icp })),
    "DELETE /v1/signals/subscriptions/:id": E("path :id", X("delete A's subscription", `/v1/signals/subscriptions/${a.subscription}`)),
    "POST /v1/signals/subscriptions/:id/run": E("path :id", X("run A's subscription", `/v1/signals/subscriptions/${a.subscription}/run`, {})),
    "GET /v1/signals/monitors": list("/v1/signals/monitors"),
    "POST /v1/signals/monitors": noref("creates a monitor for the caller's org; no object reference"),
    "PATCH /v1/signals/monitors/:id": E("path :id", X("edit A's monitor", `/v1/signals/monitors/${a.monitor}`, { name: "pwned" })),
    "DELETE /v1/signals/monitors/:id": E("path :id", X("delete A's monitor", `/v1/signals/monitors/${a.monitor}`)),
    "POST /v1/signals/monitors/:id/run": E("path :id", X("run A's monitor", `/v1/signals/monitors/${a.monitor}/run`, {})),
    "GET /v1/signals/monitors/:id/results": E("path :id", X("A's monitor results", `/v1/signals/monitors/${a.monitor}/results`)),

    // ── tools ──
    "GET /v1/tools/personas": list("/v1/tools/personas"),
    "POST /v1/tools/linkedin-to-email": noref(provider),
    "POST /v1/tools/email-to-linkedin": noref(provider),
    "POST /v1/tools/colleagues": E("body leadId", X("colleagues of A's lead", "/v1/tools/colleagues", { leadId: a.lead, save: true })),
    "POST /v1/tools/decision-makers": noref(provider),
    "POST /v1/tools/company-intel": noref(provider),
    "GET /v1/tools/domain-health": noref("DNS lookup of an arbitrary domain; no object reference"),
    "POST /v1/tools/batch-enrich": E("body leadIds[], listId", X("A's leads", "/v1/tools/batch-enrich", { leadIds: [a.lead3, a.lead4] }, true), X("A's list", "/v1/tools/batch-enrich", { listId: a.list, onlyMissingEmail: false })),
    "POST /v1/tools/verify-batch": noref(provider),
    "GET /v1/tools/saved-searches": list("/v1/tools/saved-searches"),
    "POST /v1/tools/saved-searches": E(
      "body listId, clientId, query.icpId, query.clientId",
      X("A's list", "/v1/tools/saved-searches", { name: "x", query: { query: "q" }, listId: a.list }),
      X("A's client", "/v1/tools/saved-searches", { name: "x", query: { query: "q" }, clientId: a.client }),
      X("query.icpId of A", "/v1/tools/saved-searches", { name: "x", query: { query: "q", icpId: a.icp } }),
      X("query.clientId of A", "/v1/tools/saved-searches", { name: "x", query: { query: "q", clientId: a.client } }),
    ),
    "DELETE /v1/tools/saved-searches/:id": E("path :id", X("delete A's saved search", `/v1/tools/saved-searches/${a.savedSearch}`)),
    "POST /v1/tools/saved-searches/:id/run": E("path :id", X("run A's saved search", `/v1/tools/saved-searches/${a.savedSearch}/run`, {})),
    "GET /v1/tools/tasks": E("none", X("pending", "/v1/tools/tasks", undefined, true), X("all", "/v1/tools/tasks?status=all&limit=500", undefined, true)),
    "POST /v1/tools/tasks": E("body leadId", X("task on A's lead", "/v1/tools/tasks", { leadId: a.lead, title: "call" })),
    "POST /v1/tools/tasks/:id/complete": E("path :id", X("complete A's task (advances A's contact)", `/v1/tools/tasks/${a.task}/complete`, { outcome: "done", note: "pwned" })),
    "GET /v1/tools/team": list("/v1/tools/team"),
    "POST /v1/tools/team/invite": noref("invites into the caller's own org; role gate covered by security.auth.test.ts"),
    "DELETE /v1/tools/team/invites/:id": E("path :id", X("revoke A's invite", `/v1/tools/team/invites/${a.invite}`)),
    "POST /v1/tools/team/invites/:id/resend": E("path :id", X("re-send A's invite (returns the link)", `/v1/tools/team/invites/${a.invite}/resend`, {})),
    "DELETE /v1/tools/invites/:id": E("path :id", X("revoke A's invite", `/v1/tools/invites/${a.invite}`)),
    "POST /v1/tools/invites/:id/resend": E("path :id", X("re-send A's invite (returns the link)", `/v1/tools/invites/${a.invite}/resend`, {})),
    "DELETE /v1/tools/team/:userId": E("path :userId", X("remove A's member", `/v1/tools/team/${a.member}`), X("remove A's owner", `/v1/tools/team/${a.owner}`)),
    "GET /v1/tools/autopilots": list("/v1/tools/autopilots"),
    "POST /v1/tools/autopilots": E(
      "body icpId, listId, campaignId, query.clientId",
      X("A's ICP", "/v1/tools/autopilots", { name: "x", query: { query: "q" }, icpId: a.icp, active: false }),
      X("A's list", "/v1/tools/autopilots", { name: "x", query: { query: "q" }, listId: a.list, active: false }),
      X("A's campaign", "/v1/tools/autopilots", { name: "x", query: { query: "q" }, campaignId: a.campaign, autoEnroll: true, active: false }),
      X("query.clientId of A", "/v1/tools/autopilots", { name: "x", query: { query: "q", clientId: a.client }, active: false }),
    ),
    "PATCH /v1/tools/autopilots/:id": E(
      "path :id, body icpId, listId, campaignId, query.clientId",
      X("edit A's autopilot", `/v1/tools/autopilots/${a.autopilot}`, { active: true, name: "pwned" }),
      X("B autopilot -> A's list", `/v1/tools/autopilots/${b.autopilot}`, { listId: a.list }),
      X("B autopilot -> A's campaign", `/v1/tools/autopilots/${b.autopilot}`, { campaignId: a.campaign, autoEnroll: true }),
      X("B autopilot -> A's ICP", `/v1/tools/autopilots/${b.autopilot}`, { icpId: a.icp }),
      X("B autopilot -> query.clientId of A", `/v1/tools/autopilots/${b.autopilot}`, { query: { query: "q", clientId: a.client } }),
    ),
    "DELETE /v1/tools/autopilots/:id": E("path :id", X("delete A's autopilot", `/v1/tools/autopilots/${a.autopilot}`)),
    "POST /v1/tools/autopilots/:id/run": E("path :id", X("run A's autopilot", `/v1/tools/autopilots/${a.autopilot}/run`, {})),
    "POST /v1/tools/leads/:id/status": E("path :id, body ownerUserId", X("A's lead", `/v1/tools/leads/${a.lead}/status`, { status: "lost" }), X("B lead, owner = A's user", `/v1/tools/leads/${b.lead}/status`, { status: "qualified", ownerUserId: a.owner })),

    // ── usage / analytics / events / webhooks / integrations / billing ──
    "GET /v1/usage": list("/v1/usage"),
    "GET /v1/analytics/overview": list("/v1/analytics/overview"),
    "GET /v1/analytics/funnel": list("/v1/analytics/funnel?days=365"),
    "GET /v1/analytics/sources": list("/v1/analytics/sources?days=365"),
    "GET /v1/analytics/attribution": list("/v1/analytics/attribution?days=365"),
    "GET /v1/analytics/icp-learning": list("/v1/analytics/icp-learning"),
    "GET /v1/analytics/sending-health": list("/v1/analytics/sending-health"),
    "GET /v1/events": E("query type", X("all", "/v1/events?limit=200", undefined, true), X("lead.created", "/v1/events?type=lead.created&limit=200", undefined, true)),
    "GET /v1/webhooks": list("/v1/webhooks"),
    "POST /v1/webhooks": noref("creates a webhook for the caller's org (SSRF surface: security.ssrf.test.ts); role gate covered by security.auth.test.ts"),
    "DELETE /v1/webhooks/:id": E("path :id", X("delete A's webhook", `/v1/webhooks/${a.webhook}`)),
    "POST /v1/webhooks/:id/test": E("path :id", X("fire A's webhook", `/v1/webhooks/${a.webhook}/test`, {})),
    "POST /v1/webhooks/:id/rotate-secret": E("path :id", X("rotate A's webhook secret", `/v1/webhooks/${a.webhook}/rotate-secret`, {})),
    "GET /v1/integrations": list("/v1/integrations"),
    "PUT /v1/integrations/:provider": noref("provider is a name, not an object id; upserts the caller's own (org, provider) row"),
    "DELETE /v1/integrations/:provider": E("path :provider (shared namespace)", X("provider only A has connected", `/v1/integrations/${a.integrationProvider}`)),
    "POST /v1/integrations/:provider/sync": E("path :provider, body leadIds[]", X("A's provider", `/v1/integrations/${a.integrationProvider}/sync`, { leadIds: [a.lead] }), X("B's provider + A's leads", `/v1/integrations/${b.integrationProvider}/sync`, { leadIds: [a.lead, a.lead2] }, true)),
    "POST /v1/billing/checkout": noref("Stripe checkout for the caller's own org; Stripe is not configured here"),
  };
}

function markersOf(t: Tenant): string[] {
  return [t.tag, ...uuidsOf(t)];
}

interface Res {
  status: number;
  text: string;
  body: any;
  headers: Headers;
}

interface Row {
  route: string;
  cls: string;
  cred: string;
  name: string;
  request: string;
  status: number;
  verdict: "PASS" | "FLAG";
  why?: string;
  leak?: string[];
  snippet?: string;
}

/** Strings the attacker itself sent that embed the victim's tag (an email, a domain): an echo of those is not a disclosure. */
const sentTokens = new Set<string>();
/** Everything the attacker has sent so far in the sweep, for routes that echo its own history. */
let sentEverything = "";
function tokensIn(tag: string, sent: string): string[] {
  let s = sent.toLowerCase();
  try {
    s = decodeURIComponent(s);
  } catch {}
  const re = new RegExp(`[a-z0-9_.@+\\-]*${tag}[a-z0-9_.@+\\-]*`, "g");
  return [...new Set(s.match(re) ?? [])].filter((t) => t.length > tag.length).sort((x, y) => y.length - x.length);
}

function judge(res: Res, c: Case, victim: Tenant, sent: string): { verdict: "PASS" | "FLAG"; why?: string; leak?: string[] } {
  let hay = res.text.toLowerCase();
  // Accumulated over the whole sweep: a lead B created earlier with A's email address comes
  // back in B's own lists later. A real leak of an A row still trips the detector, because
  // every A row carries the bare tag in several other columns (name, title, tags, custom).
  for (const t of tokensIn(victim.tag, sent)) sentTokens.add(t);
  for (const t of [...sentTokens].sort((x, y) => y.length - x.length)) hay = hay.split(t).join("");
  // Marker = the victim's tag (present in every one of its rows) or any of its UUIDs that the
  // attacker did not itself put in the request (an echo of your own input is not a disclosure).
  // The audit log records the filters of the caller's own exports, so a search the caller
  // made FOR the victim's marker (`?q=<tag>`) comes back as `"q":"<tag>"`. That exact echo
  // is removed; the marker anywhere else in the trail is still a disclosure.
  if (c.echoesOwnHistory) hay = hay.split(`"q":"${victim.tag}"`).join("");
  // For a route that returns the caller's own request history (the audit log), an id the
  // caller sent in ANY earlier request is an echo too.
  const echoed = (m: string) => m !== victim.tag && (sent.includes(m) || (!!c.echoesOwnHistory && sentEverything.includes(m)));
  const leak = markersOf(victim).filter((m) => hay.includes(m.toLowerCase()) && !echoed(m));
  if (leak.length) return { verdict: "FLAG", why: "victim data in response", leak };
  if (c.also?.includes(res.status)) return { verdict: "PASS" };
  if (res.status >= 500) return { verdict: "FLAG", why: `server error ${res.status}` };
  if (res.status === 429) return { verdict: "FLAG", why: "rate limited - inconclusive" };
  if (res.status >= 200 && res.status < 300 && !c.ok2xx) return { verdict: "FLAG", why: `2xx on a cross-tenant reference` };
  if (res.status >= 300 && res.status < 400) return { verdict: "FLAG", why: `redirect ${res.status}` };
  return { verdict: "PASS" };
}


// ── the suite ────────────────────────────────────────────────────────────────────────

suite("tenancy matrix: every route, two tenants", () => {
  let A: Tenant;
  let B: Tenant;
  let P: Record<string, Entry>;
  let routes: { method: string; path: string }[] = [];
  let before: Record<string, { n: number; h: string }>;
  const rows: Row[] = [];
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const realWarn = console.warn;

  beforeAll(async () => {
    // A private schema, when this database lets us make one. Created on a throwaway
    // connection BEFORE the app's pool exists, because the pool's search_path is fixed by
    // the URL it is first opened with.
    try {
      const { default: postgres } = await import("postgres");
      const admin = postgres(TEST_DB!, { max: 1, onnotice: () => {} });
      await admin.unsafe(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
      await admin.end({ timeout: 2 });
      process.env.DATABASE_URL = `${TEST_DB}${TEST_DB!.includes("?") ? "&" : "?"}search_path=${SCHEMA}`;
    } catch {
      process.env.DATABASE_URL = TEST_DB; // shared schema: still isolated by unique orgs
    }
    // Nothing leaves the machine. Anything the app tries to fetch is recorded and refused.
    vi.stubGlobal("fetch", (async (input: unknown) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : (input as { url: string }).url;
      egress.push(u.slice(0, 120));
      throw new Error("tenancy matrix: outbound fetch is blocked in this test");
    }) as typeof fetch);
    console.log = () => {}; // the dev mailer and job logs
    console.warn = () => {};

    S = await import("@prospex/db");
    await S.runMigrations(process.env.DATABASE_URL);
    const g = S.getDb();
    db = g.db;
    rawSql = g.sql;
    const { createApp } = await import("./app.js");
    app = createApp();

    A = await makeTenant("alpha");
    B = await makeTenant("bravo");
    // A job with no org (the schedulers): must never be readable through the job-status route.
    const [sched] = await db.insert(S.jobs).values({ type: "campaign.tick", payload: { recurring: true, probe: A.tag }, status: "done", result: { marker: A.tag } }).returning();
    A.ids.__schedulerJob = sched.id;

    P = plan(A, B);
    const seen = new Set<string>();
    for (const r of app.routes as { method: string; path: string }[]) {
      if (r.method === "ALL") continue;
      const k = `${r.method} ${r.path}`;
      if (!seen.has(k)) seen.add(k), routes.push(r);
    }
  }, 180_000);

  afterAll(async () => {
    vi.stubGlobal("fetch", realFetch);
    console.log = realLog;
    console.warn = realWarn;
  });

  it("has a plan entry for every registered route (a new route must be added to plan())", () => {
    const registered = new Set(routes.map((r) => `${r.method} ${r.path}`));
    const unplanned = [...registered].filter((k) => !P[k]);
    const stale = Object.keys(P).filter((k) => !registered.has(k));
    // Unplanned: a route exists that nobody has described here. Decide how it must treat
    // another tenant's ids and add it to plan(). Stale: an entry for a route that is gone.
    expect({ unplanned, stale }).toEqual({ unplanned: [], stale: [] });
    // Every authenticated route with an object reference actually has a case to run.
    const empty = Object.entries(P).filter(([, e]) => e.cls !== "public" && e.cls !== "internal" && !e.cases && !e.skip).map(([k]) => k);
    expect(empty).toEqual([]);
  });

  it("the detector flags A's own responses (so a clean sweep means something)", async () => {
    const missed: string[] = [];
    for (const path of ["/v1/leads", "/v1/leads/export.csv", `/v1/leads/${A.ids.lead}`, `/v1/search/${A.ids.search}`, `/v1/search/jobs/${A.ids.searchJob}`, `/v1/campaigns/${A.ids.campaign}/contacts`, `/v1/clients/${A.ids.client}`, "/v1/events"]) {
      const res = await req("GET", path, A.jwt);
      const j = judge(res, { name: "control", path, ok2xx: true }, A, "");
      if (res.status !== 200 || j.verdict !== "FLAG") missed.push(`${path}: status ${res.status}, detector said ${j.verdict}`);
    }
    expect(missed).toEqual([]);
    before = await snapshot(rawSql, A.orgId);
  }, 60_000);

  it("refuses every non-public route without valid credentials", async () => {
    const fill = (path: string) => path.replace(/:provider/g, "hubspot").replace(/:bucket/g, "noEmail").replace(/:domain/g, A.ids.visitorDomain).replace(/:[A-Za-z]+/g, A.ids.lead);
    const bad: string[] = [];
    for (const r of routes) {
      const k = `${r.method} ${r.path}`;
      const e = P[k];
      if (!e || e.cls === "public") continue;
      const c = e.cases?.[0];
      const path = c?.path ?? fill(r.path);
      for (const [cred, headers] of [
        ["none", {}],
        ["garbage bearer", { authorization: "Bearer not.a.jwt" }],
        ["unknown api key", { "x-api-key": "px_live_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }],
      ] as [string, Record<string, string>][]) {
        const res = await req(r.method, path, null, r.method === "GET" || r.method === "DELETE" ? undefined : c?.body ?? {}, headers);
        const j = judge(res, { name: cred, path, ok2xx: false }, A, "");
        const expected = e.cls === "internal" ? [403, 503] : [401];
        if (j.verdict !== "PASS" || !expected.includes(res.status)) bad.push(`${k} [${cred}] -> ${res.status}${j.why ? ` (${j.why})` : ""}`);
      }
    }
    expect(bad).toEqual([]);
  }, 240_000);

  for (const [cred, tokenOf] of [
    ["owner session", (t: Tenant) => t.jwt],
    ["API key", (t: Tenant) => t.apiKey],
    ["member session", (t: Tenant) => t.memberJwt],
  ] as [string, (t: Tenant) => string][]) {
    it(`as tenant B (${cred}), no route reads or changes tenant A's data`, async () => {
      const flags: string[] = [];
      for (const r of routes) {
        const k = `${r.method} ${r.path}`;
        const e = P[k];
        if (!e?.cases) continue;
        for (const c of e.cases) {
          const res = await req(r.method, c.path, tokenOf(B), c.body, c.headers);
          const sent = `${c.path} ${JSON.stringify(c.body ?? "")}`;
          sentEverything += ` ${sent}`;
          const j = judge(res, c, A, sent);
          rows.push({ route: k, cls: e.cls, cred, name: c.name, request: `${r.method} ${c.path}`, status: res.status, verdict: j.verdict, why: j.why, leak: j.leak });
          if (j.verdict === "FLAG") flags.push(`${k} "${c.name}" -> ${res.status}: ${j.why}${j.leak?.length ? ` [${j.leak.slice(0, 3).join(", ")}]` : ""} ${res.text.slice(0, 160)}`);
        }
      }
      expect(flags).toEqual([]);
    }, 240_000);
  }

  it("leaves tenant A's rows byte-identical, and nothing outside A references A", async () => {
    const after = await snapshot(rawSql, A.orgId);
    expect(diffSnapshots(before, after)).toEqual([]);
    const foreign = (await foreignReferences(rawSql, A, [...sentTokens])).filter((h) => !h.includes(A.ids.__schedulerJob)); // the org-less job is seeded by this file
    expect(foreign).toEqual([]);
  }, 60_000);

  it("wrote the refusals to B's audit log, and none of it to A's", async () => {
    const mine = await db.select().from(S.auditLog).where(S.eq(S.auditLog.orgId, B.orgId));
    const denied = mine.filter((r: any) => r.result === "denied");
    // Naming another workspace's row by id, and a member reaching for an owner-only action.
    expect(denied.some((r: any) => r.action === "reference.denied")).toBe(true);
    expect(denied.some((r: any) => r.data?.reason === "role")).toBe(true);
    // Nothing the sweep did may appear in the victim's own trail after its snapshot.
    const theirs = await db.select().from(S.auditLog).where(S.eq(S.auditLog.orgId, A.orgId));
    expect(theirs.filter((r: any) => r.result === "denied")).toEqual([]);
  });

  it("made no outbound request that left the machine", () => {
    // Every attempt was refused by the stub; this records that the sweep itself never
    // depended on one succeeding.
    expect(rows.length).toBeGreaterThan(400);
    expect(egress.every((u) => typeof u === "string")).toBe(true);
  });
});
