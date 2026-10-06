-- Plays.
--
-- A play is a saved recipe that finds the people who need the customer's product right now,
-- from one specific source of intent: companies named in a competitor's case studies,
-- companies with an open posting for a named role, companies that just raised money, people
-- asking in public for a solution, companies visiting the customer's own site, known
-- contacts who changed jobs, or an uploaded list of people who engaged with a post.
--
-- Until now every discovery path wrote straight into `leads`. A play does not. What it finds
-- lands in `play_candidates`, each with a one-sentence reason and the page that shows it,
-- and waits for a person to approve or skip it. Only an approved candidate becomes a lead
-- (and only then can it be enrolled in a campaign). The link from candidate to lead is what
-- lets each play be judged by what happened afterwards: contacted, replied, replied
-- positively.
--
-- Everything here is additive: three new tables, no change to any existing one.

-- The foreign keys below briefly lock the tables they point at. If something else is holding
-- one of those for long, give up quickly (the deploy is retried) rather than queue every
-- writer of the live application behind this statement.
SET LOCAL lock_timeout = '15s';

CREATE TABLE IF NOT EXISTS plays (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             text NOT NULL,
  -- competitor_customers | hiring_role | funding | public_asks | website_visitors | job_changes | engagers_upload
  type             text NOT NULL,
  -- active | paused. A paused play is never run by the schedule.
  status           text NOT NULL DEFAULT 'active',
  -- The inputs of this play's type (competitors, roles, keywords, ...). Bounded by the API.
  config           jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Who to look for at a company the play surfaces.
  target_titles    text[] NOT NULL DEFAULT '{}',
  icp_id           uuid REFERENCES icps(id) ON DELETE SET NULL,
  client_id        uuid REFERENCES clients(id) ON DELETE SET NULL,
  -- Where approved people go.
  list_id          uuid REFERENCES lists(id) ON DELETE SET NULL,
  campaign_id      uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  -- Off by default: nobody becomes a lead without a person saying so. When on, candidates
  -- at or above min_score are approved as they are found.
  auto_approve     boolean NOT NULL DEFAULT false,
  min_score        integer NOT NULL DEFAULT 0,
  -- Null means "only when someone presses Run".
  run_every_hours  integer,
  last_run_at      timestamptz,
  next_run_at      timestamptz,
  last_result      jsonb,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS plays_org_idx ON plays (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS plays_due_idx ON plays (next_run_at) WHERE status = 'active' AND run_every_hours IS NOT NULL;

CREATE TABLE IF NOT EXISTS play_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  play_id      uuid NOT NULL REFERENCES plays(id) ON DELETE CASCADE,
  -- running | done | failed | blocked (nothing could be searched: say why in `note`)
  status       text NOT NULL DEFAULT 'running',
  -- manual | schedule | upload
  trigger      text NOT NULL DEFAULT 'manual',
  found        integer NOT NULL DEFAULT 0,
  added        integer NOT NULL DEFAULT 0,
  duplicates   integer NOT NULL DEFAULT 0,
  -- A sentence for the person reading the result: what was searched and why it found what it found.
  note         text,
  error        text,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX IF NOT EXISTS play_runs_play_idx ON play_runs (play_id, started_at DESC);
CREATE INDEX IF NOT EXISTS play_runs_org_idx ON play_runs (org_id);

CREATE TABLE IF NOT EXISTS play_candidates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  play_id          uuid NOT NULL REFERENCES plays(id) ON DELETE CASCADE,
  run_id           uuid REFERENCES play_runs(id) ON DELETE SET NULL,
  -- person | company | post (a public conversation worth answering; has no contact details)
  kind             text NOT NULL DEFAULT 'person',
  -- pending | approved | skipped
  status           text NOT NULL DEFAULT 'pending',
  skip_reason      text,
  full_name        text,
  first_name       text,
  last_name        text,
  title            text,
  linkedin_url     text,
  email            text,
  email_status     text,
  location         text,
  company_name     text,
  company_domain   text,
  -- The one sentence shown to the reviewer, and the page that shows it is true.
  relevant_because text NOT NULL,
  evidence_url     text,
  evidence_title   text,
  evidence_quote   text,
  signal_type      text NOT NULL,
  signal_at        timestamptz,
  confidence       real NOT NULL DEFAULT 0.5,
  score            real,
  score_reasons    text[] NOT NULL DEFAULT '{}',
  -- The same person or company found twice by one play is one candidate.
  dedupe_key       text NOT NULL,
  -- Set when the candidate is approved (or when the person was already a lead).
  lead_id          uuid REFERENCES leads(id) ON DELETE SET NULL,
  already_lead     boolean NOT NULL DEFAULT false,
  decided_by       uuid,
  decided_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS play_candidates_dedupe_uniq ON play_candidates (play_id, dedupe_key);
CREATE INDEX IF NOT EXISTS play_candidates_queue_idx ON play_candidates (org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS play_candidates_play_idx ON play_candidates (play_id, status);
CREATE INDEX IF NOT EXISTS play_candidates_lead_idx ON play_candidates (lead_id) WHERE lead_id IS NOT NULL;
