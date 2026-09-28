-- Phase 1 Automation Tables
-- LinkedIn scraper, University data, Regulatory changes, Market intelligence

-- Scraped LinkedIn profiles
CREATE TABLE IF NOT EXISTS scraped_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  title TEXT,
  company TEXT,
  email TEXT,
  linkedin_url TEXT,
  location TEXT,
  enriched_data JSONB,
  scrape_date TIMESTAMP WITH TIME ZONE,
  source TEXT DEFAULT 'claude_linkedin',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_scraped_leads_org_id ON scraped_leads(org_id);
CREATE INDEX idx_scraped_leads_email ON scraped_leads(email);
CREATE INDEX idx_scraped_leads_company ON scraped_leads(company);
CREATE INDEX idx_scraped_leads_created_at ON scraped_leads(created_at DESC);

-- University reference data (from AbroBot)
CREATE TABLE IF NOT EXISTS universities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  country TEXT,
  programs TEXT[],
  fees JSONB,
  scholarships JSONB,
  intake_dates TEXT[],
  application_deadline DATE,
  website TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_universities_org_id ON universities(org_id);
CREATE INDEX idx_universities_country ON universities(country);

-- Student-University matching results
CREATE TABLE IF NOT EXISTS student_university_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  student_id UUID,
  university_id UUID REFERENCES universities(id) ON DELETE CASCADE,
  match_score NUMERIC(3,2),
  match_reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_student_university_matches_org_id ON student_university_matches(org_id);
CREATE INDEX idx_student_university_matches_student_id ON student_university_matches(student_id);

-- Regulatory & tax changes (GST, CARO, IND-AS, TDS, FEMA, etc.)
CREATE TABLE IF NOT EXISTS regulatory_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  regulation_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  effective_date DATE,
  impact_area TEXT,
  source_url TEXT,
  full_text JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_regulatory_changes_org_id ON regulatory_changes(org_id);
CREATE INDEX idx_regulatory_changes_regulation_type ON regulatory_changes(regulation_type);
CREATE INDEX idx_regulatory_changes_effective_date ON regulatory_changes(effective_date DESC);

-- Compliance alerts (delivery tracking)
CREATE TABLE IF NOT EXISTS compliance_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  regulatory_change_id UUID REFERENCES regulatory_changes(id) ON DELETE CASCADE,
  alert_type TEXT,
  sent_to TEXT[],
  sent_at TIMESTAMP WITH TIME ZONE,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_compliance_alerts_org_id ON compliance_alerts(org_id);
CREATE INDEX idx_compliance_alerts_status ON compliance_alerts(status);

-- Competitor monitoring targets
CREATE TABLE IF NOT EXISTS competitors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  website TEXT,
  linkedin_url TEXT,
  industry TEXT,
  target_market TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_competitors_org_id ON competitors(org_id);
CREATE INDEX idx_competitors_name ON competitors(name);

-- Daily competitor activity snapshots
CREATE TABLE IF NOT EXISTS competitor_tracking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  competitor_id UUID REFERENCES competitors(id) ON DELETE CASCADE,
  snapshot_date DATE,
  activity_data JSONB,
  metrics JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_competitor_tracking_org_id ON competitor_tracking(org_id);
CREATE INDEX idx_competitor_tracking_competitor_id ON competitor_tracking(competitor_id);
CREATE INDEX idx_competitor_tracking_snapshot_date ON competitor_tracking(snapshot_date DESC);

-- Aggregated market intelligence
CREATE TABLE IF NOT EXISTS market_analysis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  analysis_type TEXT,
  title TEXT NOT NULL,
  findings JSONB,
  recommendations TEXT[],
  data_sources TEXT[],
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_market_analysis_org_id ON market_analysis(org_id);
CREATE INDEX idx_market_analysis_analysis_type ON market_analysis(analysis_type);

-- Agent execution logs
CREATE TABLE IF NOT EXISTS agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_type TEXT NOT NULL,
  status TEXT DEFAULT 'running',
  message_count INTEGER,
  tokens_used INTEGER,
  rows_created INTEGER,
  error TEXT,
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_agent_runs_org_id ON agent_runs(org_id);
CREATE INDEX idx_agent_runs_agent_type ON agent_runs(agent_type);
CREATE INDEX idx_agent_runs_status ON agent_runs(status);
CREATE INDEX idx_agent_runs_created_at ON agent_runs(created_at DESC);
