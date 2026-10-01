-- Hardening pass. Additive only: new table and nullable/defaulted columns, so it is safe
-- to apply to a live database and safe for code that has not been updated yet.

-- Password reset. Only a hash of the token is stored; the token itself lives in the email.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx ON password_reset_tokens (user_id);

-- A send that keeps failing must stop eventually, and say why.
ALTER TABLE campaign_contacts ADD COLUMN IF NOT EXISTS send_failures integer NOT NULL DEFAULT 0;
ALTER TABLE campaign_contacts ADD COLUMN IF NOT EXISTS last_error text;

-- Which verifier answered for the lead's current email (e.g. "reoon:safe", "smtp", "hunter").
ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_verified_by text;

-- Invites expire and can be revoked.
ALTER TABLE invites ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE invites ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
