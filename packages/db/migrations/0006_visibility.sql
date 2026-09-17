-- AI visibility (AEO/GEO): track how AI engines answer the questions your buyers ask.
--
-- Two tables. Prompts are the questions worth winning; runs are individual sampled answers.
-- Every run is stored raw alongside its analysis, because the whole product depends on
-- repeated sampling and you cannot re-derive a metric from a summary you threw away.

CREATE TABLE IF NOT EXISTS visibility_prompts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  text text NOT NULL,
  topic text,
  -- Which engines to sample. Empty means "every engine configured for the org".
  engines text[] NOT NULL DEFAULT '{}',
  -- Samples per engine per cycle. One answer is a sample, not a measurement.
  samples_per_run integer NOT NULL DEFAULT 3,
  active boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS visibility_prompts_org_idx ON visibility_prompts (org_id, active);

CREATE TABLE IF NOT EXISTS visibility_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  prompt_id uuid NOT NULL REFERENCES visibility_prompts(id) ON DELETE CASCADE,
  engine text NOT NULL,
  model text,
  answer text NOT NULL DEFAULT '',
  analysis jsonb NOT NULL DEFAULT '{}',
  -- Denormalized from analysis so aggregate queries stay cheap.
  mentioned boolean NOT NULL DEFAULT false,
  cited boolean NOT NULL DEFAULT false,
  position integer,
  brands text[] NOT NULL DEFAULT '{}',
  -- False for refusals and empty answers. These are excluded from metrics rather than
  -- counted as absence, which would invent a visibility drop that never happened.
  usable boolean NOT NULL DEFAULT true,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS visibility_runs_org_idx ON visibility_runs (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS visibility_runs_prompt_idx ON visibility_runs (prompt_id, created_at DESC);
