-- Migration 0026: Buying Committees (Multithreading), Digital Sales Rooms / Mutual Action Plans, Autonomous GTM Campaigns

CREATE TABLE IF NOT EXISTS "buying_committees" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "deal_id" uuid REFERENCES "deals"("id") ON DELETE cascade,
  "company_domain" text NOT NULL,
  "company_name" text NOT NULL,
  "health_status" text DEFAULT 'single_threaded' NOT NULL,
  "coverage_score" integer DEFAULT 25 NOT NULL,
  "stakeholders" jsonb DEFAULT '[]'::jsonb,
  "coverage_gaps" jsonb DEFAULT '[]'::jsonb,
  "recommended_action" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "buying_committees_org_deal_idx" ON "buying_committees" ("org_id", "deal_id");

CREATE TABLE IF NOT EXISTS "digital_sales_rooms" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "deal_id" uuid REFERENCES "deals"("id") ON DELETE set null,
  "title" text NOT NULL,
  "share_token" text NOT NULL UNIQUE,
  "target_company" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "champion_name" text,
  "champion_email" text,
  "target_go_live_date" timestamp with time zone,
  "milestones" jsonb DEFAULT '[]'::jsonb,
  "artifacts" jsonb DEFAULT '[]'::jsonb,
  "views_count" integer DEFAULT 0 NOT NULL,
  "last_viewed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "digital_sales_rooms_org_token_idx" ON "digital_sales_rooms" ("org_id", "share_token");

CREATE TABLE IF NOT EXISTS "autonomous_gtm_campaigns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "objective" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "budget_tokens_or_usd" integer DEFAULT 500,
  "strategy_playbook" text,
  "target_account_count" integer DEFAULT 0 NOT NULL,
  "accounts_penetrated" integer DEFAULT 0 NOT NULL,
  "meetings_booked" integer DEFAULT 0 NOT NULL,
  "pipeline_generated_usd" integer DEFAULT 0 NOT NULL,
  "orchestrated_channels" jsonb DEFAULT '["waterfall_enrichment", "email", "phone_dialer", "buying_committee_multithread"]'::jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "autonomous_gtm_campaigns_org_idx" ON "autonomous_gtm_campaigns" ("org_id");
