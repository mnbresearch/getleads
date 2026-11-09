-- Migration 0027: Enable Row Level Security (RLS) across all 72 tables for tenant data protection
-- Enforces default-deny posture on all tables so unauthenticated / external database connections
-- cannot read, write, or enumerate tenant data directly.

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'organizations',
    'users',
    'api_keys',
    'companies',
    'icps',
    'clients',
    'client_lead_deliveries',
    'leads',
    'lists',
    'list_leads',
    'searches',
    'email_accounts',
    'campaigns',
    'sequence_steps',
    'campaign_contacts',
    'messages',
    'suppressions',
    'events',
    'jobs',
    'usage',
    'webhooks',
    'integrations',
    'upgrade_requests',
    'invites',
    'pixels',
    'visits',
    'visitor_companies',
    'signals',
    'signal_subscriptions',
    'signal_matches',
    'monitors',
    'monitor_results',
    'saved_searches',
    'tasks',
    'autopilots',
    'visibility_prompts',
    'visibility_runs',
    'tool_registry',
    'tool_usage',
    'scraped_leads',
    'universities',
    'student_university_matches',
    'regulatory_changes',
    'compliance_alerts',
    'competitors',
    'competitor_tracking',
    'market_analysis',
    'agent_runs',
    'password_reset_tokens',
    'login_attempts',
    'oauth_exchange_codes',
    'audit_log',
    'user_recovery_codes',
    'email_verification_tokens',
    'workspace_deletion_requests',
    'global_suppressions',
    'plays',
    'play_runs',
    'play_candidates',
    'product_events',
    'checkout_sessions',
    'email_opt_outs',
    'deals',
    'call_logs',
    'coaching_sessions',
    'salesfloor_blitzes',
    'waterfall_configs',
    'digital_workers',
    'signal_surges',
    'buying_committees',
    'digital_sales_rooms',
    'autonomous_gtm_campaigns'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = t) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END $$;
