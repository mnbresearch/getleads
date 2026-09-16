-- AI features: account intelligence briefs, reply triage + auto-draft, conversational ICP assistant.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS ai_brief jsonb;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS ai_brief_at timestamptz;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS intent text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS draft_reply jsonb;

ALTER TABLE icps ADD COLUMN IF NOT EXISTS chat_history jsonb NOT NULL DEFAULT '[]';
