-- Tool/integration usage registry - powers the admin "Tools & limits" dashboard so the admin
-- can see every 3rd-party API Scout calls, its free-tier limit, and current usage, and gets
-- alerted (by email) before a free tier runs out.

CREATE TABLE IF NOT EXISTS tool_registry (
  provider text PRIMARY KEY,
  label text NOT NULL,
  category text NOT NULL,
  key_env_var text,
  has_free_tier boolean NOT NULL DEFAULT true,
  free_tier_note text,
  usage_limit integer,
  period text NOT NULL DEFAULT 'month',
  alert_threshold_pct integer NOT NULL DEFAULT 80,
  last_alert_period text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tool_usage (
  provider text NOT NULL REFERENCES tool_registry(provider) ON DELETE CASCADE,
  period text NOT NULL,
  count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, period)
);

-- Seed every external tool Scout's code already calls, with the free-tier limits documented
-- in the codebase comments (packages/core/src/**). Idempotent - safe to re-run.
INSERT INTO tool_registry (provider, label, category, key_env_var, has_free_tier, free_tier_note, usage_limit, period, alert_threshold_pct, notes) VALUES
  ('apollo', 'Apollo.io', 'People & company data', 'APOLLO_API_KEY', true, 'Free plan: limited people/org search credits per month', NULL, 'month', 80, 'Set your monthly credit cap here once you check apollo.io/settings/plans, so Scout warns you before you run out.'),
  ('hunter', 'Hunter.io', 'Email finding & verification', 'HUNTER_API_KEY', true, '25 requests/month (domain search + email finder + verifier share one pool)', 25, 'month', 80, NULL),
  ('pdl', 'People Data Labs', 'Person enrichment', 'PDL_API_KEY', true, '100 person enrichments/month', 100, 'month', 80, NULL),
  ('abstract_email', 'Abstract Email Validation', 'Email verification', 'ABSTRACT_EMAIL_API_KEY', true, '100 validations/month (typical free tier - confirm on abstractapi.com)', 100, 'month', 80, NULL),
  ('google_cse', 'Google Programmable Search', 'Web search', 'GOOGLE_CSE_API_KEY', true, '100 queries/day', 100, 'day', 80, NULL),
  ('serpapi', 'SerpAPI', 'Web search', 'SERPAPI_KEY', true, '100 searches/month', 100, 'month', 80, NULL),
  ('brave', 'Brave Search API', 'Web search', 'BRAVE_SEARCH_API_KEY', false, 'No free tier since Feb 2026 - billed $5/1,000 queries from the first call', NULL, 'month', 80, 'Paid from the first query. Set a monthly call budget here if you want an alert before the bill grows.'),
  ('groq', 'Groq (AI)', 'AI / LLM', 'GROQ_API_KEY', true, 'Generous free tier, varies by model - check console.groq.com', NULL, 'day', 80, NULL),
  ('gemini', 'Google Gemini (AI)', 'AI / LLM', 'GEMINI_API_KEY', true, 'Free tier with daily rate limits - check ai.google.dev for current numbers', NULL, 'day', 80, NULL),
  ('anthropic', 'Anthropic Claude (AI)', 'AI / LLM', 'ANTHROPIC_API_KEY', false, 'No free tier - pay per token', NULL, 'month', 80, 'Fallback AI provider only; set a monthly call budget if you want an alert.'),
  ('ipapi_is', 'ipapi.is', 'Website visitor identification', NULL, true, '1,000 lookups/day, keyless', 1000, 'day', 80, NULL),
  ('ip_api', 'ip-api.com', 'Website visitor identification', NULL, true, '45 requests/minute, non-commercial use only, keyless', NULL, 'day', 80, 'Rate limit is per-minute, not per-day - a day count here is only a rough usage signal.'),
  ('ipinfo', 'ipinfo.io', 'Website visitor identification', 'IPINFO_TOKEN', true, '50,000 lookups/month with a free token', 50000, 'month', 80, NULL),
  ('whatsapp_cloud', 'WhatsApp Cloud API (Meta)', 'Messaging', 'WHATSAPP_ACCESS_TOKEN', true, '1,000 service conversations/month', 1000, 'month', 80, NULL),
  ('resend', 'Resend', 'Transactional email', 'RESEND_API_KEY', true, '3,000 emails/month, 100/day', 3000, 'month', 80, 'Also capped at 100 emails/day - watch daily volume around the cap even if the monthly count looks fine.'),
  ('duckduckgo', 'DuckDuckGo (scrape)', 'Web search', NULL, true, 'Free & keyless, no published limit - may get blocked if hammered', NULL, 'day', 80, 'Not usage-tracked; fallback web-search provider only.'),
  ('bing_html', 'Bing (HTML scrape)', 'Web search', NULL, true, 'Free & keyless, no published limit - may get blocked if hammered', NULL, 'day', 80, 'Not usage-tracked; last-resort web-search provider.'),
  ('news_rss', 'Google/Bing News RSS', 'Intent signals', NULL, true, 'Free & keyless, no published limit', NULL, 'day', 80, 'Not usage-tracked.'),
  ('render_hosting', 'Render (API hosting)', 'Infrastructure', NULL, true, 'Free web service sleeps on inactivity; paid plans add always-on + more RAM/CPU', NULL, 'month', 80, 'Not call-metered - check render.com dashboard for plan/usage limits directly.'),
  ('vercel_hosting', 'Vercel (web hosting)', 'Infrastructure', NULL, true, 'Free "Hobby" plan: 100GB bandwidth/month and build-minute caps', NULL, 'month', 80, 'Not call-metered - check vercel.com dashboard for plan/usage limits directly.'),
  ('postgres_host', 'Postgres database', 'Infrastructure', 'DATABASE_URL', true, 'Free tiers (Neon/Supabase/Railway) typically cap storage + compute hours/month', NULL, 'month', 80, 'Not call-metered - check your DB host''s dashboard for storage/compute usage directly.')
ON CONFLICT (provider) DO NOTHING;
