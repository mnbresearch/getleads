-- Job change detection.
--
-- A separate file rather than an edit to 0010: the runner records applied migrations by
-- filename, so appending to one that has already run means the new statements never
-- execute - silently, and only on the databases that were already migrated.
-- When a job-change check last got a REAL answer for this lead. Left null by a failed
-- lookup on purpose: stamping it would mean "we looked and they are fine" and would
-- suppress the next genuine check.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS job_checked_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_leads_job_checked_at ON leads(org_id, job_checked_at);
