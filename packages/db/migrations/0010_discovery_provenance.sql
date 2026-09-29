-- Turn scraped_leads from a parallel copy of the lead into the provenance record for it.
--
-- The table was created to hold leads produced by an agent that generated fictional people.
-- Those rows sat beside real leads, indistinguishable to everything downstream. The agent
-- now writes real leads into `leads` and records here only WHERE each one came from.
--
-- Additive and idempotent: existing rows keep their data and get NULL for the new columns,
-- which is what "we do not know which run produced this" honestly looks like.

ALTER TABLE scraped_leads ADD COLUMN IF NOT EXISTS lead_id uuid REFERENCES leads(id) ON DELETE CASCADE;
ALTER TABLE scraped_leads ADD COLUMN IF NOT EXISTS agent_run_id uuid;

CREATE INDEX IF NOT EXISTS idx_scraped_leads_lead_id ON scraped_leads(lead_id);
CREATE INDEX IF NOT EXISTS idx_scraped_leads_agent_run_id ON scraped_leads(agent_run_id);

-- One provenance row per lead per run. A run that rediscovers the same person records it
-- once; that it rediscovered them is itself the measurement, and it belongs in one row.
CREATE UNIQUE INDEX IF NOT EXISTS scraped_leads_lead_run_uniq ON scraped_leads(lead_id, agent_run_id);

-- Rows written by the fabricating agent are marked, not deleted. They are unusable as
-- leads - the people do not exist - but silently removing a customer's data is not this
-- migration's call to make. The source is restamped so they can be found and dropped
-- deliberately, and so no dashboard counts them as real discovery.
UPDATE scraped_leads
SET source = 'fabricated:unusable'
WHERE source = 'claude_linkedin';
