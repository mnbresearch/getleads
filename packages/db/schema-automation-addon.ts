import { pgTable, text, uuid, timestamp, index, jsonb, date, numeric, integer } from "drizzle-orm/pg-core";
import { organizations } from "./schema.js";

// Scraped LinkedIn profiles
export const scrapedLeads = pgTable("scraped_leads", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  title: text("title"),
  company: text("company"),
  email: text("email"),
  linkedinUrl: text("linkedin_url"),
  location: text("location"),
  enrichedData: jsonb("enriched_data"),
  scrapeDate: timestamp("scrape_date", { withTimezone: true }),
  source: text("source").default("claude_linkedin"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => ({
  orgIdIdx: index("idx_scraped_leads_org_id").on(table.orgId),
  emailIdx: index("idx_scraped_leads_email").on(table.email),
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
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
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
  matchScore: numeric("match_score", { precision: 3, scale: 2 }),
  matchReason: text("match_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
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
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
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
  sentAt: timestamp("sent_at", { withTimezone: true }),
  status: text("status").default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
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
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
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
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
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
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
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
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => ({
  orgIdIdx: index("idx_agent_runs_org_id").on(table.orgId),
  typeIdx: index("idx_agent_runs_agent_type").on(table.agentType),
  statusIdx: index("idx_agent_runs_status").on(table.status),
  createdAtIdx: index("idx_agent_runs_created_at").on(table.createdAt),
}));
