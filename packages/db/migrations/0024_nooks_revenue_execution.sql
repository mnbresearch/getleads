-- Migration 0024: Nooks-inspired Revenue Execution & Sales Platform entities
-- Adds deals (CRM), call_logs (Dialer), coaching_sessions (AI Roleplay), and salesfloor_blitzes (Virtual Salesfloor)

CREATE TABLE IF NOT EXISTS deals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  stage TEXT NOT NULL DEFAULT 'qualified',
  value INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  probability INTEGER NOT NULL DEFAULT 20,
  expected_close_date TIMESTAMPTZ,
  risk_level TEXT NOT NULL DEFAULT 'low',
  risk_summary TEXT,
  ai_next_best_action TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS deals_org_idx ON deals(org_id);
CREATE INDEX IF NOT EXISTS deals_stage_idx ON deals(org_id, stage);

CREATE TABLE IF NOT EXISTS call_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
  phone_number TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'outbound',
  status TEXT NOT NULL DEFAULT 'completed',
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  disposition TEXT,
  recording_url TEXT,
  transcript TEXT,
  summary TEXT,
  sentiment TEXT,
  talk_to_listen_ratio INTEGER DEFAULT 50,
  key_objections JSONB DEFAULT '[]'::jsonb,
  next_steps TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS call_logs_org_idx ON call_logs(org_id);
CREATE INDEX IF NOT EXISTS call_logs_lead_idx ON call_logs(org_id, lead_id);

CREATE TABLE IF NOT EXISTS coaching_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  persona_name TEXT NOT NULL,
  persona_description TEXT NOT NULL,
  scenario TEXT NOT NULL,
  transcript_history JSONB DEFAULT '[]'::jsonb,
  score INTEGER,
  strengths JSONB DEFAULT '[]'::jsonb,
  improvements JSONB DEFAULT '[]'::jsonb,
  feedback TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS coaching_sessions_org_user_idx ON coaching_sessions(org_id, user_id);

CREATE TABLE IF NOT EXISTS salesfloor_blitzes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  target_calls INTEGER NOT NULL DEFAULT 50,
  target_meetings INTEGER NOT NULL DEFAULT 5,
  completed_calls INTEGER NOT NULL DEFAULT 0,
  booked_meetings INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS salesfloor_blitzes_org_idx ON salesfloor_blitzes(org_id);
