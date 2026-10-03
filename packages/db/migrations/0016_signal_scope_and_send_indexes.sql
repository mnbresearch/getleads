-- Signals: one unique index over (type, url) covered both the shared news pool (org_id NULL)
-- and each workspace's private signals. A private row therefore blocked the public row for
-- the same URL for every other workspace, and a public row blocked a workspace's own.
-- Split into one index per scope.
DROP INDEX IF EXISTS signals_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS signals_uniq_global ON signals (type, url) WHERE org_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS signals_uniq_org ON signals (org_id, type, url) WHERE org_id IS NOT NULL;

-- Send-path lookups added by the security pass (duplicate-recipient guard, per-workspace
-- sending ceiling, shared-sender health) read messages by these keys on every send.
CREATE INDEX IF NOT EXISTS messages_org_created_idx ON messages (org_id, created_at);
CREATE INDEX IF NOT EXISTS messages_campaign_step_to_idx ON messages (campaign_id, step_id, to_email);
