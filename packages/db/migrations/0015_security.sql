-- Security pass (external audit follow-up). Additive columns and tables, plus a one-off
-- repair of references that cross a workspace boundary.

-- Sessions can be revoked: a token carries the version it was issued at, and a password
-- change, reset or "sign out everywhere" bumps it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0;
-- The Google account an identity is bound to, so sign-in matches on the subject, not only
-- on an email address somebody else may have registered first.
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub text;
CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_idx ON users (google_sub) WHERE google_sub IS NOT NULL;

-- Per-account brute-force protection. The per-IP limiter alone is beaten by rotating IPs.
CREATE TABLE IF NOT EXISTS login_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject text NOT NULL,            -- lowercased email, or 'admin'
  ip text,
  succeeded boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_attempts_subject_idx ON login_attempts (subject, created_at);

-- One-time codes that hand a Google sign-in back to the web app, replacing a session token
-- in the URL fragment. Only hashes are stored.
CREATE TABLE IF NOT EXISTS oauth_exchange_codes (
  code_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verifier_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Security audit log: who did what, from where, and whether it was allowed.
-- org_id is nullable because some entries have no workspace (a failed login for an unknown
-- address, a platform-admin action is recorded against its target workspace).
CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  actor_type text NOT NULL DEFAULT 'user',   -- user | api_key | admin | system | anonymous
  actor_user_id uuid,
  action text NOT NULL,
  target_type text,
  target_id text,
  result text NOT NULL DEFAULT 'ok',         -- ok | denied | failed
  ip text,
  request_id text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_org_idx ON audit_log (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log (action, created_at DESC);

-- Webhook signing: new and rotated hooks sign with a real HMAC (v2) and keep their secret
-- encrypted. Existing hooks stay on v1 until rotated, so customers' verifiers keep working.
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS signature_version integer NOT NULL DEFAULT 1;
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS secret_encrypted text;
ALTER TABLE webhooks ALTER COLUMN secret DROP NOT NULL;

-- Repair: references that point into another workspace. Nothing can create these any more,
-- but rows written before the ownership checks existed may still carry them, and several
-- lookups follow the reference without re-checking the owner. Optional references are
-- cleared; membership rows that join two workspaces are removed.
UPDATE leads l SET icp_id = NULL FROM icps x WHERE l.icp_id = x.id AND x.org_id <> l.org_id;
UPDATE leads l SET client_id = NULL, client_assigned_at = NULL FROM clients x WHERE l.client_id = x.id AND x.org_id <> l.org_id;
UPDATE leads l SET company_id = NULL FROM companies x WHERE l.company_id = x.id AND x.org_id <> l.org_id;
UPDATE leads l SET owner_user_id = NULL FROM users x WHERE l.owner_user_id = x.id AND x.org_id <> l.org_id;
UPDATE campaigns c SET icp_id = NULL FROM icps x WHERE c.icp_id = x.id AND x.org_id <> c.org_id;
UPDATE campaigns c SET list_id = NULL FROM lists x WHERE c.list_id = x.id AND x.org_id <> c.org_id;
UPDATE campaigns c SET email_account_id = NULL FROM email_accounts x WHERE c.email_account_id = x.id AND x.org_id <> c.org_id;
UPDATE campaigns c SET client_id = NULL FROM clients x WHERE c.client_id = x.id AND x.org_id <> c.org_id;
UPDATE clients c SET icp_id = NULL FROM icps x WHERE c.icp_id = x.id AND x.org_id <> c.org_id;
UPDATE icps i SET client_id = NULL FROM clients x WHERE i.client_id = x.id AND x.org_id <> i.org_id;
UPDATE lists l SET client_id = NULL FROM clients x WHERE l.client_id = x.id AND x.org_id <> l.org_id;
UPDATE searches s SET client_id = NULL FROM clients x WHERE s.client_id = x.id AND x.org_id <> s.org_id;
UPDATE saved_searches s SET list_id = NULL FROM lists x WHERE s.list_id = x.id AND x.org_id <> s.org_id;
UPDATE autopilots a SET icp_id = NULL FROM icps x WHERE a.icp_id = x.id AND x.org_id <> a.org_id;
UPDATE autopilots a SET list_id = NULL FROM lists x WHERE a.list_id = x.id AND x.org_id <> a.org_id;
UPDATE autopilots a SET campaign_id = NULL, auto_enroll = false FROM campaigns x WHERE a.campaign_id = x.id AND x.org_id <> a.org_id;
UPDATE signal_subscriptions s SET icp_id = NULL FROM icps x WHERE s.icp_id = x.id AND x.org_id <> s.org_id;
UPDATE signal_subscriptions s SET campaign_id = NULL FROM campaigns x WHERE s.campaign_id = x.id AND x.org_id <> s.org_id;
UPDATE messages m SET lead_id = NULL FROM leads x WHERE m.lead_id = x.id AND x.org_id <> m.org_id;
UPDATE messages m SET campaign_id = NULL FROM campaigns x WHERE m.campaign_id = x.id AND x.org_id <> m.org_id;
DELETE FROM list_leads ll USING lists li, leads le WHERE ll.list_id = li.id AND ll.lead_id = le.id AND li.org_id <> le.org_id;
DELETE FROM campaign_contacts cc USING campaigns c, leads le WHERE cc.campaign_id = c.id AND cc.lead_id = le.id AND c.org_id <> le.org_id;
DELETE FROM client_lead_deliveries d USING clients c, leads le WHERE d.client_id = c.id AND d.lead_id = le.id AND c.org_id <> le.org_id;
DELETE FROM tasks t USING leads le WHERE t.lead_id = le.id AND le.org_id <> t.org_id;
