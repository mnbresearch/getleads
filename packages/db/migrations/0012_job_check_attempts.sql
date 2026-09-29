-- When a job-change check was last ATTEMPTED, whatever came of it.
--
-- `job_checked_at` (0011) is stamped only when the employer could actually be compared on
-- both sides, which is the right rule: a lookup that answered nothing must not read as
-- "checked, unchanged" and suppress the next real check for a month.
--
-- But it left the other half undone. A lead whose provider never answers - no coverage, no
-- credentials, no company on file to compare against - was selected again on EVERY run, at
-- provider cost each time, and any change detected without a comparable employer inserted a
-- fresh signal row and emitted lead.job_changed again, forever. Honest, and unusable.
--
-- So attempts are stamped separately and gate a short retry backoff. A lead we could not
-- confirm is still never recorded as unchanged; it is simply not retried tomorrow.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS job_check_attempted_at timestamptz;

-- Both scan predicates filter on org_id and one of the two timestamps. The scan then sorts
-- the survivors by score, which this index does not serve - the filter is what needs help,
-- since without it every run reads every lead in the org.
CREATE INDEX IF NOT EXISTS idx_leads_job_check_attempted_at ON leads(org_id, job_check_attempted_at);

-- Rotation cursor for the scheduler, on the org rather than derived from its leads.
--
-- The tick used to order orgs by `(SELECT max(job_checked_at) FROM leads WHERE ...) NULLS
-- FIRST`. Two things were wrong with that. It was a correlated aggregate over leads for
-- every active org on every tick, with no index behind it. And it starved permanently: an
-- org with no leads, no provider coverage, or nothing comparable never gets a
-- `job_checked_at`, so its max stays NULL, so it stays at the head of NULLS FIRST forever
-- and the orgs behind it are never reached at all. Stamping the org itself after each
-- attempt makes the rotation a rotation.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS job_check_tick_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_orgs_job_check_tick_at ON organizations(job_check_tick_at NULLS FIRST) WHERE status = 'active';
