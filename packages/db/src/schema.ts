import {
  pgTable,
  text,
  timestamp,
  integer,
  bigint,
  boolean,
  jsonb,
  uuid,
  real,
  // `date` for calendar-day columns (deadlines, effective dates). It was used by tables
  // added later without being imported, which broke `tsc -p packages/db` - and with it the
  // Render build command, which runs that build.
  date,
  uniqueIndex,
  index,
  primaryKey,
  // Needed to annotate the one circular reference (icps.client_id -> clients, clients.icp_id
  // -> icps), which TypeScript cannot otherwise infer.
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  plan: text("plan").notNull().default("free"),
  planLimits: jsonb("plan_limits").$type<PlanLimits>().notNull().default({} as PlanLimits),
  /** active | deactivated | revoked - set by the admin dashboard. Deactivated/revoked orgs are blocked at auth time. */
  status: text("status").notNull().default("active"),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  /** Rotation cursor for the daily job-change scan. Stamped per attempt, not per success. */
  jobCheckTickAt: ts("job_check_tick_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    name: text("name").notNull().default(""),
    role: text("role").notNull().default("owner"),
    emailVerifiedAt: ts("email_verified_at"),
    lastLoginAt: ts("last_login_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => ({ emailIdx: uniqueIndex("users_email_idx").on(t.email) }),
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    scopes: text("scopes").array().notNull().default(["*"]),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => ({ hashIdx: uniqueIndex("api_keys_hash_idx").on(t.keyHash) }),
);

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    name: text("name"),
    industry: text("industry"),
    size: text("size"),
    location: text("location"),
    country: text("country"),
    description: text("description"),
    website: text("website"),
    linkedinUrl: text("linkedin_url"),
    foundedYear: integer("founded_year"),
    techStack: text("tech_stack").array().notNull().default([]),
    emailPattern: text("email_pattern"),
    mxValid: boolean("mx_valid"),
    catchAll: boolean("catch_all"),
    headcount: integer("headcount"),
    revenueUsd: bigint("revenue_usd", { mode: "number" }),
    fundingTotalUsd: bigint("funding_total_usd", { mode: "number" }),
    lastFundingRound: text("last_funding_round"),
    lastFundingAt: ts("last_funding_at"),
    openRoles: integer("open_roles"),
    hiring: jsonb("hiring").$type<Record<string, unknown>>().notNull().default({}),
    signalsCount: integer("signals_count").notNull().default(0),
    lastSignalAt: ts("last_signal_at"),
    intentScore: real("intent_score").notNull().default(0),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default({}),
    // AI-generated "why reach out now" account brief - cached so a rep opening the same
    // company repeatedly doesn't re-spend an AI call each time. Regenerated on request.
    aiBrief: jsonb("ai_brief").$type<{ summary: string; whyNow: string; angles: string[] }>(),
    aiBriefAt: ts("ai_brief_at"),
    enrichedAt: ts("enriched_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => ({ domainIdx: uniqueIndex("companies_org_domain_idx").on(t.orgId, t.domain) }),
);

export const icps = pgTable("icps", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  criteria: jsonb("criteria").$type<IcpCriteria>().notNull().default({} as IcpCriteria),
  seedDomains: text("seed_domains").array().notNull().default([]),
  aiProfile: jsonb("ai_profile").$type<Record<string, unknown>>(),
  // Conversational ICP assistant transcript (see POST /v1/icps/:id/chat). Kept short by the
  // route (last ~20 turns) so it never becomes a meaningful storage or prompt-size concern.
  chatHistory: jsonb("chat_history").$type<{ role: "user" | "assistant"; content: string }[]>().notNull().default([]),
  /** The client this ICP describes, when the workspace runs pipeline for several. */
  clientId: uuid("client_id").references((): AnyPgColumn => clients.id, { onDelete: "set null" }),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/**
 * A client of the workspace - for an agency, one of the companies it generates pipeline for.
 *
 * A sub-account rather than a separate workspace, so an agency keeps one login, one sending
 * setup and one quota, sees every client in one view, and can route a lead that does not fit
 * one client to another that it does fit instead of discarding it. See migration 0013.
 */
export const clients = pgTable("clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  domain: text("domain"),
  industry: text("industry"),
  /** active | paused | archived */
  status: text("status").notNull().default("active"),
  color: text("color"),
  icpId: uuid("icp_id").references(() => icps.id, { onDelete: "set null" }),
  monthlyLeadTarget: integer("monthly_lead_target"),
  notes: text("notes"),
  /** Read-only report link. Null = sharing off. */
  shareToken: text("share_token").unique(),
  /** Show delivery against target in the shared report. Opt-in. */
  reportShowTarget: boolean("report_show_target").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** First delivery of a lead to a client. Never rewritten; see migration 0013. */
export const clientLeadDeliveries = pgTable(
  "client_lead_deliveries",
  {
    clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id").notNull().references((): AnyPgColumn => leads.id, { onDelete: "cascade" }),
    deliveredAt: ts("delivered_at").notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.clientId, t.leadId] }) }),
);

export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    icpId: uuid("icp_id").references(() => icps.id, { onDelete: "set null" }),
    firstName: text("first_name"),
    lastName: text("last_name"),
    fullName: text("full_name"),
    title: text("title"),
    seniority: text("seniority"),
    department: text("department"),
    email: text("email"),
    emailStatus: text("email_status").notNull().default("unknown"),
    emailConfidence: real("email_confidence").notNull().default(0),
    linkedinUrl: text("linkedin_url"),
    phone: text("phone"),
    location: text("location"),
    country: text("country"),
    source: text("source").notNull().default("manual"),
    score: real("score").notNull().default(0),
    scoreReasons: text("score_reasons").array().notNull().default([]),
    tags: text("tags").array().notNull().default([]),
    custom: jsonb("custom").$type<Record<string, unknown>>().notNull().default({}),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default({}),
    engagementScore: real("engagement_score").notNull().default(0),
    lastEngagedAt: ts("last_engaged_at"),
    whatsapp: text("whatsapp"),
    ownerUserId: uuid("owner_user_id"),
    status: text("status").notNull().default("new"),
    verifiedAt: ts("verified_at"),
    /**
     * When a job-change check last got a real answer for this person.
     *
     * Stamped only when a provider actually responded. A lookup that failed leaves this
     * alone on purpose: writing it would mean "we looked and they are fine", and would
     * suppress the next real check for a month on the strength of a timeout.
     */
    jobCheckedAt: ts("job_checked_at"),
    /** When a check was last attempted, answered or not. Drives retry backoff. */
    jobCheckAttemptedAt: ts("job_check_attempted_at"),
    /**
     * The one client this lead belongs to, or null for the unassigned pool.
     *
     * One owner, deliberately: a person claimed by two clients of the same agency would be
     * emailed twice from the same sending setup.
     */
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    clientAssignedAt: ts("client_assigned_at"),
    enrichedAt: ts("enriched_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    emailIdx: uniqueIndex("leads_org_email_idx").on(t.orgId, t.email),
    linkedinIdx: index("leads_org_linkedin_idx").on(t.orgId, t.linkedinUrl),
    companyIdx: index("leads_company_idx").on(t.companyId),
    scoreIdx: index("leads_org_score_idx").on(t.orgId, t.score),
  }),
);

export const lists = pgTable("lists", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const listLeads = pgTable(
  "list_leads",
  {
    listId: uuid("list_id").notNull().references(() => lists.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
    addedAt: ts("added_at").notNull().defaultNow(),
  },
  (t) => ({ pk: uniqueIndex("list_leads_pk").on(t.listId, t.leadId) }),
);

export const searches = pgTable("searches", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  query: jsonb("query").$type<Record<string, unknown>>().notNull(),
  status: text("status").notNull().default("queued"),
  resultCount: integer("result_count").notNull().default(0),
  jobId: uuid("job_id"),
  error: text("error"),
  /** Leads this search creates are assigned to this client, unless another client owns them. */
  clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
  /** What the client claim did: delivered, and left with another client. */
  clientClaim: jsonb("client_claim").$type<Record<string, unknown>>(),
  createdAt: ts("created_at").notNull().defaultNow(),
  completedAt: ts("completed_at"),
});

export const emailAccounts = pgTable("email_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(), // resend | smtp | system
  fromName: text("from_name").notNull(),
  fromEmail: text("from_email").notNull(),
  replyTo: text("reply_to"),
  configEncrypted: text("config_encrypted"),
  dailyLimit: integer("daily_limit").notNull().default(50),
  sentToday: integer("sent_today").notNull().default(0),
  sentTodayDate: text("sent_today_date"),
  signature: text("signature"),
  status: text("status").notNull().default("active"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const campaigns = pgTable("campaigns", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: text("status").notNull().default("draft"), // draft|active|paused|completed
  icpId: uuid("icp_id").references(() => icps.id, { onDelete: "set null" }),
  listId: uuid("list_id").references(() => lists.id, { onDelete: "set null" }),
  emailAccountId: uuid("email_account_id").references(() => emailAccounts.id, { onDelete: "set null" }),
  clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
  settings: jsonb("settings").$type<CampaignSettings>().notNull().default({} as CampaignSettings),
  stats: jsonb("stats").$type<Record<string, number>>().notNull().default({}),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const sequenceSteps = pgTable("sequence_steps", {
  id: uuid("id").primaryKey().defaultRandom(),
  campaignId: uuid("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  stepNo: integer("step_no").notNull(),
  delayDays: integer("delay_days").notNull().default(0),
  subjectTemplate: text("subject_template").notNull(),
  bodyTemplate: text("body_template").notNull(),
  aiPersonalize: boolean("ai_personalize").notNull().default(true),
  aiInstructions: text("ai_instructions"),
  channel: text("channel").notNull().default("email"),
  variants: jsonb("variants").$type<{ subjectTemplate: string; bodyTemplate: string }[]>().notNull().default([]),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const campaignContacts = pgTable(
  "campaign_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("queued"), // queued|active|replied|bounced|unsubscribed|completed|failed
    currentStep: integer("current_step").notNull().default(0),
    variant: integer("variant").notNull().default(0),
    nextSendAt: ts("next_send_at"),
    lastMessageId: uuid("last_message_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex("campaign_contacts_uniq").on(t.campaignId, t.leadId),
    dueIdx: index("campaign_contacts_due_idx").on(t.status, t.nextSendAt),
  }),
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    stepId: uuid("step_id").references(() => sequenceSteps.id, { onDelete: "set null" }),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    direction: text("direction").notNull().default("outbound"),
    channel: text("channel").notNull().default("email"),
    variant: integer("variant").notNull().default(0),
    toEmail: text("to_email").notNull(),
    subject: text("subject").notNull(),
    bodyText: text("body_text").notNull(),
    bodyHtml: text("body_html"),
    status: text("status").notNull().default("queued"),
    providerMessageId: text("provider_message_id"),
    trackingToken: text("tracking_token"),
    error: text("error"),
    sentAt: ts("sent_at"),
    openedAt: ts("opened_at"),
    clickedAt: ts("clicked_at"),
    repliedAt: ts("replied_at"),
    bouncedAt: ts("bounced_at"),
    // AI reply-triage: set on inbound messages only. `intent` mirrors classifyReply()'s
    // output (interested|not_interested|out_of_office|unsubscribe|referral|question|other);
    // `draftReply` is an AI-suggested follow-up (subject/body) for positive-signal intents,
    // reviewed and sent by the rep via POST /v1/campaigns/messages/:id/send-reply.
    intent: text("intent"),
    draftReply: jsonb("draft_reply").$type<{ subject: string; body: string }>(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => ({
    trackIdx: uniqueIndex("messages_tracking_idx").on(t.trackingToken),
    leadIdx: index("messages_lead_idx").on(t.leadId),
  }),
);

export const suppressions = pgTable(
  "suppressions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    reason: text("reason").notNull().default("unsubscribe"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => ({ uniq: uniqueIndex("suppressions_uniq").on(t.orgId, t.email) }),
);

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => ({ idx: index("events_org_created_idx").on(t.orgId, t.createdAt) }),
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("queued"), // queued|running|done|failed
    priority: integer("priority").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAt: ts("run_at").notNull().defaultNow(),
    lockedAt: ts("locked_at"),
    lockedBy: text("locked_by"),
    progress: integer("progress").notNull().default(0),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: text("error"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => ({ pollIdx: index("jobs_poll_idx").on(t.status, t.runAt, t.priority) }),
);

export const usage = pgTable(
  "usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    period: text("period").notNull(), // YYYY-MM
    metric: text("metric").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => ({ uniq: uniqueIndex("usage_uniq").on(t.orgId, t.period, t.metric) }),
);

export const webhooks = pgTable("webhooks", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  events: text("events").array().notNull().default(["*"]),
  secret: text("secret").notNull(),
  active: boolean("active").notNull().default(true),
  failures: integer("failures").notNull().default(0),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const integrations = pgTable(
  "integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(), // hubspot | pipedrive | salesforce | cortex | sheets | custom
    configEncrypted: text("config_encrypted"),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("active"),
    lastSyncAt: ts("last_sync_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => ({ uniq: uniqueIndex("integrations_uniq").on(t.orgId, t.provider) }),
);



// ── admin / manual-billing tables ──

/** Captured from the public "upgrade me" form on the pricing page - a sales lead for the
 * admin dashboard, not a Stripe checkout. The admin follows up by email/phone and upgrades
 * the org manually once payment is settled outside the app. */
export const upgradeRequests = pgTable(
  "upgrade_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    email: text("email").notNull(),
    mobile: text("mobile").notNull(),
    country: text("country").notNull(),
    planId: text("plan_id").notNull(),
    message: text("message"),
    status: text("status").notNull().default("new"), // new|contacted|converted|dismissed
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => ({ createdIdx: index("upgrade_requests_created_idx").on(t.createdAt) }),
);

// ── v2 tables ──

export const invites = pgTable("invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role").notNull().default("member"),
  token: text("token").notNull().unique(),
  invitedBy: uuid("invited_by"),
  acceptedAt: ts("accepted_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const pixels = pgTable("pixels", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  allowedDomains: text("allowed_domains").array().notNull().default([]),
  active: boolean("active").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const visits = pgTable(
  "visits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    pixelId: uuid("pixel_id").notNull().references(() => pixels.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    ipHash: text("ip_hash").notNull(),
    companyDomain: text("company_domain"),
    companyName: text("company_name"),
    orgName: text("org_name"),
    isIsp: boolean("is_isp").notNull().default(false),
    country: text("country"),
    city: text("city"),
    page: text("page"),
    referrer: text("referrer"),
    userAgent: text("user_agent"),
    durationMs: integer("duration_ms").notNull().default(0),
    visitedAt: ts("visited_at").notNull().defaultNow(),
  },
  (t) => ({ timeIdx: index("visits_org_time_idx").on(t.orgId, t.visitedAt), domIdx: index("visits_org_domain_idx").on(t.orgId, t.companyDomain) }),
);

export const visitorCompanies = pgTable(
  "visitor_companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    name: text("name"),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    visits: integer("visits").notNull().default(0),
    sessions: integer("sessions").notNull().default(0),
    pages: jsonb("pages").$type<Record<string, number>>().notNull().default({}),
    intentScore: real("intent_score").notNull().default(0),
    status: text("status").notNull().default("new"),
    leadsFound: integer("leads_found").notNull().default(0),
  },
  (t) => ({ uniq: uniqueIndex("visitor_companies_uniq").on(t.orgId, t.domain) }),
);

export const signals = pgTable(
  "signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    companyName: text("company_name"),
    companyDomain: text("company_domain"),
    title: text("title").notNull(),
    summary: text("summary"),
    url: text("url").notNull(),
    source: text("source"),
    amountUsd: bigint("amount_usd", { mode: "number" }),
    round: text("round"),
    confidence: real("confidence").notNull().default(0.5),
    occurredAt: ts("occurred_at"),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => ({ uniq: uniqueIndex("signals_uniq").on(t.type, t.url), orgIdx: index("signals_org_time_idx").on(t.orgId, t.createdAt), domIdx: index("signals_domain_idx").on(t.companyDomain) }),
);

export const signalSubscriptions = pgTable("signal_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  types: text("types").array().notNull().default(["funding", "hiring"]),
  keywords: text("keywords").array().notNull().default([]),
  industries: text("industries").array().notNull().default([]),
  locations: text("locations").array().notNull().default([]),
  icpId: uuid("icp_id").references(() => icps.id, { onDelete: "set null" }),
  targetTitles: text("target_titles").array().notNull().default([]),
  autoCreateLeads: boolean("auto_create_leads").notNull().default(false),
  campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
  active: boolean("active").notNull().default(true),
  lastRunAt: ts("last_run_at"),
  stats: jsonb("stats").$type<Record<string, number>>().notNull().default({}),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const signalMatches = pgTable(
  "signal_matches",
  {
    signalId: uuid("signal_id").notNull().references(() => signals.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id").notNull().references(() => signalSubscriptions.id, { onDelete: "cascade" }),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("new"),
    leadsCreated: integer("leads_created").notNull().default(0),
    matchedAt: ts("matched_at").notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.signalId, t.subscriptionId] }) }),
);

export const monitors = pgTable("monitors", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  name: text("name").notNull(),
  target: text("target").notNull(),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  active: boolean("active").notNull().default(true),
  intervalMinutes: integer("interval_minutes").notNull().default(360),
  lastRunAt: ts("last_run_at"),
  lastResult: jsonb("last_result").$type<Record<string, unknown>>(),
  resultsCount: integer("results_count").notNull().default(0),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const monitorResults = pgTable(
  "monitor_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    monitorId: uuid("monitor_id").notNull().references(() => monitors.id, { onDelete: "cascade" }),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    url: text("url"),
    snippet: text("snippet"),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    foundAt: ts("found_at").notNull().defaultNow(),
  },
  (t) => ({ uniq: uniqueIndex("monitor_results_uniq").on(t.monitorId, t.url) }),
);

export const savedSearches = pgTable("saved_searches", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  query: jsonb("query").$type<Record<string, unknown>>().notNull(),
  alert: boolean("alert").notNull().default(false),
  alertEmail: text("alert_email"),
  listId: uuid("list_id").references(() => lists.id, { onDelete: "set null" }),
  lastRunAt: ts("last_run_at"),
  lastNewCount: integer("last_new_count").notNull().default(0),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => campaignContacts.id, { onDelete: "cascade" }),
    stepId: uuid("step_id").references(() => sequenceSteps.id, { onDelete: "set null" }),
    assigneeUserId: uuid("assignee_user_id"),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    dueAt: ts("due_at").notNull().defaultNow(),
    status: text("status").notNull().default("pending"),
    completedAt: ts("completed_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => ({ idx: index("tasks_org_status_idx").on(t.orgId, t.status, t.dueAt) }),
);

export const autopilots = pgTable("autopilots", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  query: jsonb("query").$type<Record<string, unknown>>().notNull(),
  icpId: uuid("icp_id").references(() => icps.id, { onDelete: "set null" }),
  listId: uuid("list_id").references(() => lists.id, { onDelete: "set null" }),
  campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
  dailyLeads: integer("daily_leads").notNull().default(10),
  minScore: integer("min_score").notNull().default(60),
  requireValidEmail: boolean("require_valid_email").notNull().default(true),
  autoEnroll: boolean("auto_enroll").notNull().default(false),
  active: boolean("active").notNull().default(true),
  runHourUtc: integer("run_hour_utc").notNull().default(3),
  lastRunAt: ts("last_run_at"),
  stats: jsonb("stats").$type<Record<string, number>>().notNull().default({}),
  createdAt: ts("created_at").notNull().defaultNow(),
});

// ── Shared JSON types ──

export interface PlanLimits {
  /** Total leads/month from ANY source (free web-discovery + site-crawl, or paid-provider). */
  leadsPerMonth: number;
  /**
   * Sub-quota of leadsPerMonth allowed to be sourced from a paid data provider
   * (Apollo/Hunter/PDL). Unlike the other *PerMonth limits, <= 0 here means ZERO
   * provider access (not unlimited) - free/pilot orgs are meant to be capped at zero
   * so every lead they get costs us nothing but a search query. See docs/PRICING.md.
   */
  premiumLeadsPerMonth: number;
  searchesPerMonth: number;
  verificationsPerMonth: number;
  aiMessagesPerMonth: number;
  emailsPerMonth: number;
  campaigns: number;
  seats: number;
  apiAccess: boolean;
  integrations: boolean;
}

export interface IcpCriteria {
  industries?: string[];
  titles?: string[];
  seniorities?: string[];
  departments?: string[];
  companySizes?: string[];
  locations?: string[];
  countries?: string[];
  keywords?: string[];
  excludeKeywords?: string[];
  techStack?: string[];
}

export interface CampaignSettings {
  dailyLimit?: number;
  timezone?: string;
  sendWindow?: { start: string; end: string; days: number[] };
  stopOnReply?: boolean;
  trackOpens?: boolean;
  trackClicks?: boolean;
  unsubscribeFooter?: boolean;
}

export type Organization = typeof organizations.$inferSelect;
export type User = typeof users.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Company = typeof companies.$inferSelect;
export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;
export type Icp = typeof icps.$inferSelect;
export type Client = typeof clients.$inferSelect;
export type List = typeof lists.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type SequenceStep = typeof sequenceSteps.$inferSelect;
export type CampaignContact = typeof campaignContacts.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type EmailAccount = typeof emailAccounts.$inferSelect;
export type Webhook = typeof webhooks.$inferSelect;
export type Integration = typeof integrations.$inferSelect;
export type Pixel = typeof pixels.$inferSelect;
export type Visit = typeof visits.$inferSelect;
export type VisitorCompany = typeof visitorCompanies.$inferSelect;
export type Signal = typeof signals.$inferSelect;
export type SignalSubscription = typeof signalSubscriptions.$inferSelect;
export type Monitor = typeof monitors.$inferSelect;
export type SavedSearch = typeof savedSearches.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type Autopilot = typeof autopilots.$inferSelect;
export type Invite = typeof invites.$inferSelect;
export type UpgradeRequest = typeof upgradeRequests.$inferSelect;

// ── Tool/integration registry: every 3rd-party API Scout calls, its free-tier limit, and
// current usage - powers the admin "Tools & limits" tab so the admin gets warned before a
// free tier runs out and knows exactly which tool to upgrade. ──
export const visibilityPrompts = pgTable(
  "visibility_prompts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    topic: text("topic"),
    engines: text("engines").array().notNull().default([]),
    samplesPerRun: integer("samples_per_run").notNull().default(3),
    active: boolean("active").notNull().default(true),
    lastRunAt: ts("last_run_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => ({ orgIdx: index("visibility_prompts_org_idx").on(t.orgId, t.active) }),
);

export const visibilityRuns = pgTable(
  "visibility_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    promptId: uuid("prompt_id").notNull().references(() => visibilityPrompts.id, { onDelete: "cascade" }),
    engine: text("engine").notNull(),
    model: text("model"),
    answer: text("answer").notNull().default(""),
    analysis: jsonb("analysis").$type<Record<string, unknown>>().notNull().default({}),
    mentioned: boolean("mentioned").notNull().default(false),
    cited: boolean("cited").notNull().default(false),
    position: integer("position"),
    brands: text("brands").array().notNull().default([]),
    usable: boolean("usable").notNull().default(true),
    error: text("error"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("visibility_runs_org_idx").on(t.orgId, t.createdAt),
    promptIdx: index("visibility_runs_prompt_idx").on(t.promptId, t.createdAt),
  }),
);

export const toolRegistry = pgTable("tool_registry", {
  provider: text("provider").primaryKey(), // e.g. "hunter", "apollo", "serpapi"
  label: text("label").notNull(), // e.g. "Hunter.io"
  category: text("category").notNull(), // e.g. "People & company data"
  keyEnvVar: text("key_env_var"), // env var that holds the API key; null = keyless
  hasFreeTier: boolean("has_free_tier").notNull().default(true),
  freeTierNote: text("free_tier_note"), // human description of the free tier, e.g. "25 requests/month"
  usageLimit: integer("usage_limit"), // count that triggers the alert; null = not tracked/no cap set
  period: text("period").notNull().default("month"), // "day" | "month" - the window `usageLimit` resets on
  alertThresholdPct: integer("alert_threshold_pct").notNull().default(80),
  lastAlertPeriod: text("last_alert_period"), // period key we last emailed an alert for (avoids repeat spam)
  notes: text("notes"),
  // What the provider last actually said. "configured" only ever meant the env var was set,
  // which is not the same as the key working - see migration 0007.
  lastOutcome: text("last_outcome"),
  lastStatus: integer("last_status"),
  lastDetail: text("last_detail"),
  lastSeenAt: ts("last_seen_at"),
  lastOkAt: ts("last_ok_at"),
  // Permanently unusable through no fault of the key (Google closed Custom Search to new
  // customers in Sep 2026). Kept separate from a failing key so the admin stops asking for
  // a fix that does not exist. See migration 0008.
  retired: boolean("retired").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const toolUsage = pgTable(
  "tool_usage",
  {
    provider: text("provider")
      .notNull()
      .references(() => toolRegistry.provider, { onDelete: "cascade" }),
    period: text("period").notNull(), // "2026-09" for month-scoped, "2026-09-16" for day-scoped
    count: integer("count").notNull().default(0),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.provider, t.period] }) }),
);

export type ToolRegistryEntry = typeof toolRegistry.$inferSelect;
export type ToolUsage = typeof toolUsage.$inferSelect;


// =====================
// Phase 1 Automation Tables
// =====================

// Scraped LinkedIn profiles
/**
 * Where a discovered lead came from.
 *
 * Originally a second, parallel copy of the lead - which is how a table of invented people
 * came to sit alongside the real one, indistinguishable to everything downstream. It is now
 * the PROVENANCE record: one row per (lead, run) saying which agent run surfaced this
 * person, what it was looking for, and what was observed about them at the time.
 *
 * That makes per-source performance answerable (which query and which provider actually
 * produce leads that reply), and it means a lead of doubtful origin can always be traced
 * back. The lead itself lives in `leads`, once, where the rest of the product can see it.
 */
export const scrapedLeads = pgTable("scraped_leads", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  /** The real lead this is provenance for. Null only on rows predating the change. */
  leadId: uuid("lead_id").references(() => leads.id, { onDelete: "cascade" }),
  /** The run that surfaced it, so a bad run's output can be found and judged together. */
  agentRunId: uuid("agent_run_id"),
  name: text("name").notNull(),
  title: text("title"),
  company: text("company"),
  email: text("email"),
  linkedinUrl: text("linkedin_url"),
  location: text("location"),
  enrichedData: jsonb("enriched_data"),
  scrapeDate: ts("scrape_date"),
  source: text("source").default("claude_linkedin"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (table) => ({
  orgIdIdx: index("idx_scraped_leads_org_id").on(table.orgId),
  emailIdx: index("idx_scraped_leads_email").on(table.email),
  leadIdx: index("idx_scraped_leads_lead_id").on(table.leadId),
  runIdx: index("idx_scraped_leads_agent_run_id").on(table.agentRunId),
  // One provenance row per lead per run: a run re-finding the same person records it once.
  uniqPerRun: uniqueIndex("scraped_leads_lead_run_uniq").on(table.leadId, table.agentRunId),
  companyIdx: index("idx_scraped_leads_company").on(table.company),
  createdAtIdx: index("idx_scraped_leads_created_at").on(table.createdAt),
}));

// University reference data
export const universities = pgTable("universities", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  country: text("country"),
  programs: text("programs").array(),
  fees: jsonb("fees"),
  scholarships: jsonb("scholarships"),
  intakeDates: text("intake_dates").array(),
  applicationDeadline: date("application_deadline"),
  website: text("website"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (table) => ({
  orgIdIdx: index("idx_universities_org_id").on(table.orgId),
  countryIdx: index("idx_universities_country").on(table.country),
}));

// Student-University matches
export const studentUniversityMatches = pgTable("student_university_matches", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  studentId: uuid("student_id"),
  universityId: uuid("university_id").references(() => universities.id, { onDelete: "cascade" }),
  matchScore: text("match_score"),
  matchReason: text("match_reason"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (table) => ({
  orgIdIdx: index("idx_student_university_matches_org_id").on(table.orgId),
  studentIdIdx: index("idx_student_university_matches_student_id").on(table.studentId),
}));

// Regulatory changes
export const regulatoryChanges = pgTable("regulatory_changes", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  regulationType: text("regulation_type").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  effectiveDate: date("effective_date"),
  impactArea: text("impact_area"),
  sourceUrl: text("source_url"),
  fullText: jsonb("full_text"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (table) => ({
  orgIdIdx: index("idx_regulatory_changes_org_id").on(table.orgId),
  typeIdx: index("idx_regulatory_changes_regulation_type").on(table.regulationType),
  dateIdx: index("idx_regulatory_changes_effective_date").on(table.effectiveDate),
}));

// Compliance alerts
export const complianceAlerts = pgTable("compliance_alerts", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  regulatoryChangeId: uuid("regulatory_change_id").references(() => regulatoryChanges.id, { onDelete: "cascade" }),
  alertType: text("alert_type"),
  sentTo: text("sent_to").array(),
  sentAt: ts("sent_at"),
  status: text("status").default("pending"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (table) => ({
  orgIdIdx: index("idx_compliance_alerts_org_id").on(table.orgId),
  statusIdx: index("idx_compliance_alerts_status").on(table.status),
}));

// Competitors
export const competitors = pgTable("competitors", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  website: text("website"),
  linkedinUrl: text("linkedin_url"),
  industry: text("industry"),
  targetMarket: text("target_market"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (table) => ({
  orgIdIdx: index("idx_competitors_org_id").on(table.orgId),
  nameIdx: index("idx_competitors_name").on(table.name),
}));

// Competitor tracking
export const competitorTracking = pgTable("competitor_tracking", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  competitorId: uuid("competitor_id").references(() => competitors.id, { onDelete: "cascade" }),
  snapshotDate: date("snapshot_date"),
  activityData: jsonb("activity_data"),
  metrics: jsonb("metrics"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (table) => ({
  orgIdIdx: index("idx_competitor_tracking_org_id").on(table.orgId),
  competitorIdIdx: index("idx_competitor_tracking_competitor_id").on(table.competitorId),
  dateIdx: index("idx_competitor_tracking_snapshot_date").on(table.snapshotDate),
}));

// Market analysis
export const marketAnalysis = pgTable("market_analysis", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  analysisType: text("analysis_type"),
  title: text("title").notNull(),
  findings: jsonb("findings"),
  recommendations: text("recommendations").array(),
  dataSources: text("data_sources").array(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (table) => ({
  orgIdIdx: index("idx_market_analysis_org_id").on(table.orgId),
  typeIdx: index("idx_market_analysis_analysis_type").on(table.analysisType),
}));

// Agent runs
export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  agentType: text("agent_type").notNull(),
  status: text("status").default("running"),
  messageCount: integer("message_count"),
  tokensUsed: integer("tokens_used"),
  rowsCreated: integer("rows_created"),
  error: text("error"),
  startedAt: ts("started_at").notNull().defaultNow(),
  completedAt: ts("completed_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (table) => ({
  orgIdIdx: index("idx_agent_runs_org_id").on(table.orgId),
  typeIdx: index("idx_agent_runs_agent_type").on(table.agentType),
  statusIdx: index("idx_agent_runs_status").on(table.status),
  createdAtIdx: index("idx_agent_runs_created_at").on(table.createdAt),
}));

// Type exports
export type ScrapedLead = typeof scrapedLeads.$inferSelect;
export type University = typeof universities.$inferSelect;
export type StudentUniversityMatch = typeof studentUniversityMatches.$inferSelect;
export type RegulatoryChange = typeof regulatoryChanges.$inferSelect;
export type ComplianceAlert = typeof complianceAlerts.$inferSelect;
export type Competitor = typeof competitors.$inferSelect;
export type CompetitorTracking = typeof competitorTracking.$inferSelect;
export type MarketAnalysis = typeof marketAnalysis.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
