-- Client workspaces.
--
-- An agency running pipeline for many companies needs every lead to belong somewhere. Until
-- now a workspace was one bucket: leads sourced for five different clients sat in one list,
-- and the only way to tell them apart was a tag someone remembered to add.
--
-- A client is a sub-account inside the workspace, not a separate workspace. That choice is
-- deliberate: it keeps one login, one sending setup and one quota for the agency, lets the
-- agency see all of its clients in one view, and - the reason that matters most - lets a
-- lead sourced for one client that does not fit it be routed to another client that it
-- does fit, instead of being thrown away. Separate workspaces make that impossible.
--
-- Everything here is additive. Every new column is nullable, so every existing lead,
-- campaign, ICP, list and search keeps working exactly as before and simply belongs to no
-- client ("the pool") until someone assigns it.

CREATE TABLE IF NOT EXISTS clients (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name               text NOT NULL,
  domain             text,
  industry           text,
  -- active | paused | archived. Archived clients keep their leads but drop out of routing.
  status             text NOT NULL DEFAULT 'active',
  color              text,
  -- The ICP used to decide whether a pooled lead fits this client.
  icp_id             uuid REFERENCES icps(id) ON DELETE SET NULL,
  -- What the agency has promised to deliver, per calendar month. Null means no target.
  monthly_lead_target integer,
  notes              text,
  -- Read-only report link for the client. Null means sharing is off; rotating it revokes
  -- every link sent so far.
  share_token        text UNIQUE,
  -- Whether the shared report shows delivery against the monthly target. Off by default:
  -- the target is the agency's commitment, and whether a client sees "behind" is the
  -- agency's call to make, not a side effect of turning sharing on.
  report_show_target boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_clients_org ON clients(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_org_name ON clients(org_id, lower(name));

-- One owner per lead. A person sourced for two clients of the same agency would otherwise be
-- emailed twice from the same sending infrastructure, which is both a deliverability risk
-- and the kind of thing that ends an agency relationship. The pool is client_id IS NULL.
ALTER TABLE leads     ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES clients(id) ON DELETE SET NULL;
ALTER TABLE leads     ADD COLUMN IF NOT EXISTS client_assigned_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_leads_org_client ON leads(org_id, client_id);

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES clients(id) ON DELETE SET NULL;
ALTER TABLE icps      ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES clients(id) ON DELETE SET NULL;
ALTER TABLE lists     ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES clients(id) ON DELETE SET NULL;
ALTER TABLE searches  ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES clients(id) ON DELETE SET NULL;
