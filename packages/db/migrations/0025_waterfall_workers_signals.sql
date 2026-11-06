-- Migration 0025: Waterfall enrichment, Digital Workers (Alice/Jordan), and Signal Convergence Surges

CREATE TABLE IF NOT EXISTS "waterfall_configs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "name" text DEFAULT 'Default Waterfall' NOT NULL,
  "provider_order" jsonb DEFAULT '["hunter", "reoon", "millionverifier", "smtp_direct"]'::jsonb,
  "find_mobile_phones" boolean DEFAULT true NOT NULL,
  "stop_on_first_verified" boolean DEFAULT true NOT NULL,
  "require_mx_check" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "waterfall_configs_org_idx" ON "waterfall_configs" ("org_id");

CREATE TABLE IF NOT EXISTS "digital_workers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "role" text NOT NULL,
  "channel" text DEFAULT 'multichannel' NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "daily_capacity" integer DEFAULT 100 NOT NULL,
  "actions_executed_today" integer DEFAULT 0 NOT NULL,
  "autonomous_mode" boolean DEFAULT false NOT NULL,
  "config" jsonb DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "digital_workers_org_idx" ON "digital_workers" ("org_id");

CREATE TABLE IF NOT EXISTS "signal_surges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "company_name" text NOT NULL,
  "company_domain" text NOT NULL,
  "composite_intent_score" integer DEFAULT 50 NOT NULL,
  "surge_level" text DEFAULT 'moderate' NOT NULL,
  "detected_signals" jsonb DEFAULT '[]'::jsonb,
  "primary_topic" text,
  "decision_makers_identified" integer DEFAULT 0 NOT NULL,
  "auto_enrolled_play_id" uuid REFERENCES "plays"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "signal_surges_org_domain_idx" ON "signal_surges" ("org_id", "company_domain");
