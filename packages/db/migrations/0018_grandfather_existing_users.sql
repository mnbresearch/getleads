-- Release migration: grandfather existing accounts, admin sign-out, tool registry rows.
-- Every statement is idempotent (IF NOT EXISTS / ON CONFLICT / a WHERE that matches nothing
-- the second time), so re-running it changes nothing.

-- 1. Accounts that exist at the time of this deploy are treated as owning their address.
--
-- "Sign in with Google" takes over ("claims") a password account whose address was never
-- proved: the old password is turned off, every session is signed out and, for a workspace
-- with one user, its API keys are revoked. That rule exists for an account somebody else
-- registered with your address. But nothing ever set email_verified_at before this release
-- (only a completed password reset does), so EVERY existing password account would have been
-- claimed on its first Google sign-in after the deploy - customers who have used the product
-- for months losing their password and their API keys for clicking a button.
--
-- The operator knows this customer base: these accounts were created by the people who use
-- them. They are marked verified as of the day they were created, so Google sign-in LINKS
-- them (nothing lost). The takeover rule applies to accounts created from now on: password
-- signup still leaves email_verified_at empty until the address is proved (a password reset,
-- or a Google sign-in).
--
-- Safe to re-run: after the first run no row created before it has a NULL here. This file is
-- recorded in _migrations and is never applied twice, so an account created AFTER the deploy
-- is not touched by it.
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;

-- 2. Admin sign-out. The admin dashboard session is a 12-hour signed token, and "Sign out"
-- only forgot it in the browser: a copy of the token kept working until it expired. Tokens
-- now carry an id (jti); POST /v1/admin/logout records the id here and the token is refused
-- from then on. Rows are only needed until the token would have expired anyway, and are
-- pruned after that.
CREATE TABLE IF NOT EXISTS admin_revoked_tokens (
  jti text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_revoked_tokens_expires_idx ON admin_revoked_tokens (expires_at);

-- 3. Tool registry: the two email-verification providers that were being called, metered and
-- key-tested without a row, so "Tools & limits" never showed them and their test results
-- were thrown away (health is only recorded for providers in the registry).
INSERT INTO tool_registry (provider, label, category, key_env_var, has_free_tier, free_tier_note, usage_limit, period, alert_threshold_pct, notes) VALUES
  ('reoon', 'Reoon Email Verifier', 'Email verification', 'REOON_API_KEY', true, 'Free plan: a small daily verification allowance - check reoon.com for the current number', NULL, 'day', 80, 'Set the daily allowance of your Reoon plan here to get an alert before it runs out. Credits left are shown under "Credits left".'),
  ('millionverifier', 'MillionVerifier', 'Email verification', 'MILLIONVERIFIER_API_KEY', false, 'No recurring free tier - prepaid credits', NULL, 'month', 80, 'Prepaid credits. Set a monthly call budget here if you want an alert; credits left are shown under "Credits left".')
ON CONFLICT (provider) DO NOTHING;
