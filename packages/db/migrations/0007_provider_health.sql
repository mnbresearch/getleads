-- Provider health: whether a configured key is actually working.
--
-- Until now "configured" meant only that an env var was non-empty, so a wrong, expired or
-- plan-limited key showed as healthy while returning nothing. These columns record what the
-- provider last actually said, so the admin view can distinguish a rejected key from a
-- working one that simply found no rows.
ALTER TABLE tool_registry ADD COLUMN IF NOT EXISTS last_outcome TEXT;
ALTER TABLE tool_registry ADD COLUMN IF NOT EXISTS last_status INTEGER;
ALTER TABLE tool_registry ADD COLUMN IF NOT EXISTS last_detail TEXT;
ALTER TABLE tool_registry ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
-- Last time the provider accepted a call. Kept separate from last_seen_at so a provider that
-- has started failing still shows when it last worked.
ALTER TABLE tool_registry ADD COLUMN IF NOT EXISTS last_ok_at TIMESTAMPTZ;

-- Apollo gates people search and people match independently, so a single Apollo row would
-- report "working" while the enrichment half is 403ing. Tracked as its own provider.
INSERT INTO tool_registry (provider, label, category, key_env_var, has_free_tier, free_tier_note, usage_limit, period, notes)
VALUES ('apollo-enrich', 'Apollo (people match)', 'People & company data', 'APOLLO_API_KEY', false,
        NULL, NULL, 'month',
        'Person-level enrichment. Gated separately from Apollo search and excluded from lower plans.')
ON CONFLICT (provider) DO NOTHING;
