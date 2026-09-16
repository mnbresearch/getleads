-- Admin dashboard + manual "request to upgrade" lead capture (no Stripe integration).

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'; -- active|deactivated|revoked

CREATE TABLE IF NOT EXISTS upgrade_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  name text NOT NULL,
  email text NOT NULL,
  mobile text NOT NULL,
  country text NOT NULL,
  plan_id text NOT NULL,
  message text,
  status text NOT NULL DEFAULT 'new',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS upgrade_requests_created_idx ON upgrade_requests (created_at);
