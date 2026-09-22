-- Serper as a search provider.
--
-- Google closed the Custom Search JSON API to new customers on 22 Sep 2026 (existing users are
-- cut off 1 Jan 2027), which removed the only genuinely free provider in the search chain.
-- Serper gives 2,500 free queries on signup and then charges about $0.30 per 1,000, roughly
-- thirty times cheaper than SerpAPI, so it becomes the primary paid provider.
INSERT INTO tool_registry (provider, label, category, key_env_var, has_free_tier, free_tier_note, usage_limit, period, notes)
VALUES ('serper', 'Serper', 'Web search', 'SERPER_API_KEY', true,
        '2,500 free queries on signup (one-off, not monthly), then about $0.30 per 1,000',
        2500, 'month',
        'Primary web search since Google Custom Search closed to new customers. The free credits are a one-time grant, so this limit is a running total rather than a monthly reset - treat the alert as "the free credits are nearly gone".')
ON CONFLICT (provider) DO NOTHING;

-- Record why Google CSE is no longer usable, so nobody spends another evening on it.
UPDATE tool_registry
SET notes = 'CLOSED TO NEW CUSTOMERS by Google as of Sep 2026; existing projects lose access 1 Jan 2027. A 403 "This project does not have the access to Custom Search JSON API" here is policy, not configuration - no key, project or enablement change fixes it. See Serper instead.',
    free_tier_note = '100 queries/day, but only for projects that already had access before Google closed the API'
WHERE provider = 'google_cse';

-- A provider can now be retired: still configured, but permanently unusable through no fault
-- of the key. Without this, Google CSE sits in the admin's red "keys not working" banner
-- forever telling an operator to fix something that cannot be fixed, which is the fastest way
-- to train someone to ignore the banner that matters.
ALTER TABLE tool_registry ADD COLUMN IF NOT EXISTS retired BOOLEAN NOT NULL DEFAULT false;
UPDATE tool_registry SET retired = true WHERE provider = 'google_cse';
