-- Resilience and privacy. Additive: new indexes and one new table only, so the previous
-- release keeps working against this schema.

-- The worker's claim query orders by (scheduler first, priority, run_at) among queued rows.
-- The existing (status, run_at, priority) index cannot serve that order, so a deep backlog
-- meant a sort of every queued row on every poll.
CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs (
  (CASE WHEN payload->>'recurring' = 'true' THEN 1 ELSE 0 END) DESC, priority DESC, run_at ASC
) WHERE status = 'queued';

-- Per-workspace limits on waiting work are checked on every enqueue.
CREATE INDEX IF NOT EXISTS jobs_org_open_idx ON jobs (org_id, type) WHERE status IN ('queued', 'running');

-- Addresses that must never be mailed by any workspace on this platform (a person asked the
-- platform itself to stop, a legal request, a complaint). Stored lower-cased and canonical.
CREATE TABLE IF NOT EXISTS global_suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  reason text NOT NULL DEFAULT 'request',
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
