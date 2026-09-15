-- GetLeads v2: website visitors, intent signals, monitors, saved searches, tasks, team, autopilot, multichannel + A/B

-- Company firmographics + signals
ALTER TABLE companies ADD COLUMN IF NOT EXISTS headcount integer;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS revenue_usd bigint;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS funding_total_usd bigint;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS last_funding_round text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS last_funding_at timestamptz;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS open_roles integer;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS hiring jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS signals_count integer NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS last_signal_at timestamptz;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS intent_score real NOT NULL DEFAULT 0;

-- Lead engagement + intent
ALTER TABLE leads ADD COLUMN IF NOT EXISTS engagement_score real NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_engaged_at timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS whatsapp text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'new'; -- new|contacted|engaged|replied|qualified|customer|lost

-- Multichannel + A/B steps
ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'email'; -- email|linkedin_connect|linkedin_message|whatsapp|call|task
ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS variants jsonb NOT NULL DEFAULT '[]'::jsonb; -- [{subjectTemplate, bodyTemplate}] extra A/B variants
ALTER TABLE messages ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'email';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS variant integer NOT NULL DEFAULT 0;
ALTER TABLE campaign_contacts ADD COLUMN IF NOT EXISTS variant integer NOT NULL DEFAULT 0;

-- Team invites
CREATE TABLE IF NOT EXISTS invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL DEFAULT 'member',
  token text NOT NULL UNIQUE,
  invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Website visitor identification
CREATE TABLE IF NOT EXISTS pixels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  allowed_domains text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pixel_id uuid NOT NULL REFERENCES pixels(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  ip_hash text NOT NULL,
  company_domain text,
  company_name text,
  org_name text,
  is_isp boolean NOT NULL DEFAULT false,
  country text,
  city text,
  page text,
  referrer text,
  user_agent text,
  duration_ms integer NOT NULL DEFAULT 0,
  visited_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS visits_org_time_idx ON visits(org_id, visited_at DESC);
CREATE INDEX IF NOT EXISTS visits_org_domain_idx ON visits(org_id, company_domain);

CREATE TABLE IF NOT EXISTS visitor_companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain text NOT NULL,
  name text,
  company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  visits integer NOT NULL DEFAULT 0,
  sessions integer NOT NULL DEFAULT 0,
  pages jsonb NOT NULL DEFAULT '{}'::jsonb,
  intent_score real NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'new', -- new|reviewed|contacted|ignored
  leads_found integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS visitor_companies_uniq ON visitor_companies(org_id, domain);

-- Intent signals (funding, acquisition, hiring, news, tech, leadership change)
CREATE TABLE IF NOT EXISTS signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE, -- NULL = global/shared
  type text NOT NULL,
  company_name text,
  company_domain text,
  title text NOT NULL,
  summary text,
  url text NOT NULL,
  source text,
  amount_usd bigint,
  round text,
  confidence real NOT NULL DEFAULT 0.5,
  occurred_at timestamptz,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS signals_uniq ON signals(type, url);
CREATE INDEX IF NOT EXISTS signals_org_time_idx ON signals(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS signals_domain_idx ON signals(company_domain);

CREATE TABLE IF NOT EXISTS signal_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  types text[] NOT NULL DEFAULT '{funding,hiring}',
  keywords text[] NOT NULL DEFAULT '{}',
  industries text[] NOT NULL DEFAULT '{}',
  locations text[] NOT NULL DEFAULT '{}',
  icp_id uuid REFERENCES icps(id) ON DELETE SET NULL,
  target_titles text[] NOT NULL DEFAULT '{}',
  auto_create_leads boolean NOT NULL DEFAULT false,
  campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS signal_matches (
  signal_id uuid NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL REFERENCES signal_subscriptions(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'new',
  leads_created integer NOT NULL DEFAULT 0,
  matched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (signal_id, subscription_id)
);

-- Monitors: LinkedIn posts, keyword news, competitor mentions, job boards
CREATE TABLE IF NOT EXISTS monitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type text NOT NULL, -- linkedin_post|keyword|competitor|jobs|company_news
  name text NOT NULL,
  target text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  interval_minutes integer NOT NULL DEFAULT 360,
  last_run_at timestamptz,
  last_result jsonb,
  results_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS monitor_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  monitor_id uuid NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL, -- person|article|job|mention
  title text NOT NULL,
  url text,
  snippet text,
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  found_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS monitor_results_uniq ON monitor_results(monitor_id, url);

-- Saved searches with alerts
CREATE TABLE IF NOT EXISTS saved_searches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  query jsonb NOT NULL,
  alert boolean NOT NULL DEFAULT false,
  alert_email text,
  list_id uuid REFERENCES lists(id) ON DELETE SET NULL,
  last_run_at timestamptz,
  last_new_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Manual / multichannel tasks
CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES leads(id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES campaign_contacts(id) ON DELETE CASCADE,
  step_id uuid REFERENCES sequence_steps(id) ON DELETE SET NULL,
  assignee_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  type text NOT NULL, -- linkedin_connect|linkedin_message|call|whatsapp|task
  title text NOT NULL,
  body text,
  due_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending', -- pending|done|skipped
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_org_status_idx ON tasks(org_id, status, due_at);

-- Autopilot: autonomous daily prospecting agent
CREATE TABLE IF NOT EXISTS autopilots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  query jsonb NOT NULL,
  icp_id uuid REFERENCES icps(id) ON DELETE SET NULL,
  list_id uuid REFERENCES lists(id) ON DELETE SET NULL,
  campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  daily_leads integer NOT NULL DEFAULT 10,
  min_score integer NOT NULL DEFAULT 60,
  require_valid_email boolean NOT NULL DEFAULT true,
  auto_enroll boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  run_hour_utc integer NOT NULL DEFAULT 3,
  last_run_at timestamptz,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
