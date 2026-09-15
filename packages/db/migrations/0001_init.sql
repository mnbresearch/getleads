-- GetLeads initial schema. Postgres 14+. Idempotent.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  plan text NOT NULL DEFAULT 'free',
  plan_limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  stripe_customer_id text,
  stripe_subscription_id text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  password_hash text NOT NULL,
  name text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT 'owner',
  email_verified_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users(email);

CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  prefix text NOT NULL,
  key_hash text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{*}',
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash_idx ON api_keys(key_hash);

CREATE TABLE IF NOT EXISTS companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain text NOT NULL,
  name text,
  industry text,
  size text,
  location text,
  country text,
  description text,
  website text,
  linkedin_url text,
  founded_year integer,
  tech_stack text[] NOT NULL DEFAULT '{}',
  email_pattern text,
  mx_valid boolean,
  catch_all boolean,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  enriched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS companies_org_domain_idx ON companies(org_id, domain);

CREATE TABLE IF NOT EXISTS icps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  criteria jsonb NOT NULL DEFAULT '{}'::jsonb,
  seed_domains text[] NOT NULL DEFAULT '{}',
  ai_profile jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
  icp_id uuid REFERENCES icps(id) ON DELETE SET NULL,
  first_name text,
  last_name text,
  full_name text,
  title text,
  seniority text,
  department text,
  email text,
  email_status text NOT NULL DEFAULT 'unknown',
  email_confidence real NOT NULL DEFAULT 0,
  linkedin_url text,
  phone text,
  location text,
  country text,
  source text NOT NULL DEFAULT 'manual',
  score real NOT NULL DEFAULT 0,
  score_reasons text[] NOT NULL DEFAULT '{}',
  tags text[] NOT NULL DEFAULT '{}',
  custom jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  verified_at timestamptz,
  enriched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS leads_org_email_idx ON leads(org_id, email);
CREATE INDEX IF NOT EXISTS leads_org_linkedin_idx ON leads(org_id, linkedin_url);
CREATE INDEX IF NOT EXISTS leads_company_idx ON leads(company_id);
CREATE INDEX IF NOT EXISTS leads_org_score_idx ON leads(org_id, score);
CREATE INDEX IF NOT EXISTS leads_org_created_idx ON leads(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS list_leads (
  list_id uuid NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS list_leads_pk ON list_leads(list_id, lead_id);

CREATE TABLE IF NOT EXISTS searches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  query jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  result_count integer NOT NULL DEFAULT 0,
  job_id uuid,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS email_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL,
  from_name text NOT NULL,
  from_email text NOT NULL,
  reply_to text,
  config_encrypted text,
  daily_limit integer NOT NULL DEFAULT 50,
  sent_today integer NOT NULL DEFAULT 0,
  sent_today_date text,
  signature text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  icp_id uuid REFERENCES icps(id) ON DELETE SET NULL,
  list_id uuid REFERENCES lists(id) ON DELETE SET NULL,
  email_account_id uuid REFERENCES email_accounts(id) ON DELETE SET NULL,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sequence_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  step_no integer NOT NULL,
  delay_days integer NOT NULL DEFAULT 0,
  subject_template text NOT NULL,
  body_template text NOT NULL,
  ai_personalize boolean NOT NULL DEFAULT true,
  ai_instructions text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS campaign_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued',
  current_step integer NOT NULL DEFAULT 0,
  next_send_at timestamptz,
  last_message_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS campaign_contacts_uniq ON campaign_contacts(campaign_id, lead_id);
CREATE INDEX IF NOT EXISTS campaign_contacts_due_idx ON campaign_contacts(status, next_send_at);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  step_id uuid REFERENCES sequence_steps(id) ON DELETE SET NULL,
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  direction text NOT NULL DEFAULT 'outbound',
  to_email text NOT NULL,
  subject text NOT NULL,
  body_text text NOT NULL,
  body_html text,
  status text NOT NULL DEFAULT 'queued',
  provider_message_id text,
  tracking_token text,
  error text,
  sent_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  replied_at timestamptz,
  bounced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_tracking_idx ON messages(tracking_token);
CREATE INDEX IF NOT EXISTS messages_lead_idx ON messages(lead_id);
CREATE INDEX IF NOT EXISTS messages_org_created_idx ON messages(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  reason text NOT NULL DEFAULT 'unsubscribe',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS suppressions_uniq ON suppressions(org_id, email);

CREATE TABLE IF NOT EXISTS events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type text NOT NULL,
  entity_type text,
  entity_id uuid,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_org_created_idx ON events(org_id, created_at);

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued',
  priority integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  run_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  progress integer NOT NULL DEFAULT 0,
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_poll_idx ON jobs(status, run_at, priority);

CREATE TABLE IF NOT EXISTS usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period text NOT NULL,
  metric text NOT NULL,
  count integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS usage_uniq ON usage(org_id, period, metric);

CREATE TABLE IF NOT EXISTS webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url text NOT NULL,
  events text[] NOT NULL DEFAULT '{*}',
  secret text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  failures integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL,
  config_encrypted text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active',
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS integrations_uniq ON integrations(org_id, provider);
