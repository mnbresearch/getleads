-- Account security features: two-factor sign-in, email verification, hashed link tokens,
-- workspace deletion requests. Additive: nullable columns and new tables only, so the
-- previous release keeps working against this schema.

-- Two-factor sign-in (TOTP). The secret is stored encrypted; last_step stops a code being replayed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret_encrypted text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step bigint;

CREATE TABLE IF NOT EXISTS user_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_recovery_codes_user_idx ON user_recovery_codes (user_id);

-- Email verification links. Only the hash of the token is stored.
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_verification_tokens_user_idx ON email_verification_tokens (user_id);

-- Invite links: looked up by hash. New invites store no plaintext token; existing rows keep
-- theirs (so the previous release can still read them) and gain the hash.
ALTER TABLE invites ADD COLUMN IF NOT EXISTS token_hash text;
ALTER TABLE invites ALTER COLUMN token DROP NOT NULL;
UPDATE invites SET token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex') WHERE token IS NOT NULL AND token_hash IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS invites_token_hash_idx ON invites (token_hash) WHERE token_hash IS NOT NULL;

-- Client report links: looked up by hash; the token itself is kept encrypted so the app can
-- still show the link to the people allowed to see it. Existing rows keep the plaintext
-- column until the app re-encrypts them on its next start.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS share_token_hash text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS share_token_encrypted text;
UPDATE clients SET share_token_hash = encode(sha256(convert_to(share_token, 'UTF8')), 'hex') WHERE share_token IS NOT NULL AND share_token_hash IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS clients_share_token_hash_idx ON clients (share_token_hash) WHERE share_token_hash IS NOT NULL;

-- A workspace owner can ask for the workspace and all its data to be deleted. There is a
-- grace period during which the request can be cancelled.
CREATE TABLE IF NOT EXISTS workspace_deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requested_by uuid,
  requested_at timestamptz NOT NULL DEFAULT now(),
  scheduled_for timestamptz NOT NULL,
  cancelled_at timestamptz,
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS workspace_deletion_requests_due_idx ON workspace_deletion_requests (scheduled_for) WHERE cancelled_at IS NULL AND completed_at IS NULL;
