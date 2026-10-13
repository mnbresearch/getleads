-- API key lifecycle, product analytics and checkout follow-up.
--
-- 1. API keys can now expire and be rotated. `expires_at` is when a key stops working (NULL:
--    never, which is every key created before this release). Rotation issues a new key and
--    gives the old one an `expires_at` a few minutes or hours ahead (or revokes it at once),
--    so a deployment can switch keys without a gap. `rotated_from_id` links the new key to
--    the one it replaced; `created_by` names the person who made it.
--
-- 2. `product_events`: the platform's own funnel (sign-ups, sign-ins, activation, pricing
--    and checkout), for the admin dashboard. Server-side events carry the workspace and user
--    ids and never an email, password, token or card detail. Page views from the public site
--    carry no identifier at all - no IP, no cookie, no per-visitor id - so they are counted,
--    not followed; they are only recorded when the browser does not send Do Not Track or
--    Global Privacy Control. Kept for 395 days (lib/privacyRetention.ts).
--
-- 3. `checkout_sessions`: every online checkout that was started, so one that was never
--    finished can be noticed and, if the operator turns it on, followed up once by email.
--    `email_opt_outs` records a person's "don't send me these" per kind of email.
--
-- Everything here is additive: three nullable columns and three new tables. The previous
-- release ignores all of it (it does not know about expiry, so an expired key works again
-- after a rollback - see DEPLOY.md B14).

SET LOCAL lock_timeout = '15s';

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rotated_from_id uuid REFERENCES api_keys(id) ON DELETE SET NULL;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS api_keys_rotated_from_idx ON api_keys (rotated_from_id) WHERE rotated_from_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS api_keys_created_by_idx ON api_keys (created_by) WHERE created_by IS NOT NULL;

CREATE TABLE IF NOT EXISTS product_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- e.g. page_view, signup, login_succeeded, login_failed, email_verified, activated,
  -- pricing_viewed, checkout_started, checkout_completed, checkout_abandoned,
  -- subscription_cancelled, api_key_created
  name        text NOT NULL,
  org_id      uuid REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  -- page views only: the path (no query string) and the referring site's host
  path        text,
  -- small, fixed shapes per event (plan, source, utm_*); never personal data
  props       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS product_events_name_time_idx ON product_events (name, created_at);
CREATE INDEX IF NOT EXISTS product_events_time_idx ON product_events (created_at);
CREATE INDEX IF NOT EXISTS product_events_org_idx ON product_events (org_id, created_at) WHERE org_id IS NOT NULL;
-- Deleting a user sets user_id to NULL here; without an index that scans the whole table.
CREATE INDEX IF NOT EXISTS product_events_user_idx ON product_events (user_id) WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS checkout_sessions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id              uuid REFERENCES users(id) ON DELETE SET NULL,
  plan                 text NOT NULL,
  provider             text NOT NULL DEFAULT 'stripe',
  provider_session_id  text UNIQUE,
  -- open | completed | expired
  status               text NOT NULL DEFAULT 'open',
  created_at           timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz,
  -- sent | skipped:<reason> | failed | dry_run
  followup_status      text,
  followup_at          timestamptz
);
CREATE INDEX IF NOT EXISTS checkout_sessions_org_idx ON checkout_sessions (org_id, created_at);
-- What the hourly follow-up reads: open or expired sessions not yet decided.
CREATE INDEX IF NOT EXISTS checkout_sessions_due_idx ON checkout_sessions (created_at) WHERE followup_status IS NULL;
CREATE INDEX IF NOT EXISTS checkout_sessions_user_idx ON checkout_sessions (user_id) WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS email_opt_outs (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- e.g. checkout_followup
  kind        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind)
);
