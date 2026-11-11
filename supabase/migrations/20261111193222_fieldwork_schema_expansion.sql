/*
# Fieldwork Research Intelligence - Full Schema Expansion

## Overview
Expands the Workhorse schema into the full Fieldwork research intelligence platform.
Adds sources with structured metadata, evidence records, activity logs, research projects,
research presets, and document records. Adds columns to existing conversations table.

## New Tables
- research_projects: long-running research projects containing conversations
- sources: structured metadata for every retrieved document
- evidence: claims and evidence extracted from sources
- activity_logs: agent activity trail for the right panel
- research_presets: predefined research mode configurations (seeded)

## Modified Tables
- conversations: adds project_id and preset columns

## Security
- RLS enabled on all new tables, TO anon, authenticated, full CRUD
*/

-- Research projects table (created first since conversations references it)
CREATE TABLE IF NOT EXISTS research_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text DEFAULT '',
  objectives jsonb DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE research_projects ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON research_projects TO anon, authenticated;

DROP POLICY IF EXISTS "anon_select_projects" ON research_projects;
CREATE POLICY "anon_select_projects" ON research_projects FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_projects" ON research_projects;
CREATE POLICY "anon_insert_projects" ON research_projects FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_projects" ON research_projects;
CREATE POLICY "anon_update_projects" ON research_projects FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_projects" ON research_projects;
CREATE POLICY "anon_delete_projects" ON research_projects FOR DELETE TO anon, authenticated USING (true);

-- Add columns to conversations (now that research_projects exists)
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES research_projects(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS preset text;

-- Sources table
CREATE TABLE IF NOT EXISTS sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  title text NOT NULL DEFAULT '',
  url text NOT NULL DEFAULT '',
  publisher text DEFAULT '',
  author text DEFAULT '',
  publication_date text DEFAULT '',
  source_type text DEFAULT 'web',
  provider text NOT NULL DEFAULT 'unknown',
  original_query text DEFAULT '',
  relevance_score float DEFAULT 0,
  citation_id text DEFAULT '',
  extraction_status text DEFAULT 'pending' CHECK (extraction_status IN ('pending', 'extracted', 'failed', 'analyzed')),
  metadata jsonb DEFAULT '{}'::jsonb,
  snippet text DEFAULT '',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE sources ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON sources TO anon, authenticated;

DROP POLICY IF EXISTS "anon_select_sources" ON sources;
CREATE POLICY "anon_select_sources" ON sources FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_sources" ON sources;
CREATE POLICY "anon_insert_sources" ON sources FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_sources" ON sources;
CREATE POLICY "anon_update_sources" ON sources FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_sources" ON sources;
CREATE POLICY "anon_delete_sources" ON sources FOR DELETE TO anon, authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_sources_conversation_id ON sources(conversation_id);
CREATE INDEX IF NOT EXISTS idx_sources_message_id ON sources(message_id);

-- Evidence table
CREATE TABLE IF NOT EXISTS evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  source_id uuid REFERENCES sources(id) ON DELETE SET NULL,
  claim text NOT NULL,
  evidence_type text NOT NULL DEFAULT 'direct' CHECK (evidence_type IN ('direct', 'indirect', 'supporting', 'contradictory', 'unverified', 'missing')),
  confidence text NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high', 'medium', 'low')),
  corroborated_by jsonb DEFAULT '[]'::jsonb,
  contradicted_by jsonb DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'unresolved')),
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE evidence ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON evidence TO anon, authenticated;

DROP POLICY IF EXISTS "anon_select_evidence" ON evidence;
CREATE POLICY "anon_select_evidence" ON evidence FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_evidence" ON evidence;
CREATE POLICY "anon_insert_evidence" ON evidence FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_evidence" ON evidence;
CREATE POLICY "anon_update_evidence" ON evidence FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_evidence" ON evidence;
CREATE POLICY "anon_delete_evidence" ON evidence FOR DELETE TO anon, authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_evidence_conversation_id ON evidence(conversation_id);
CREATE INDEX IF NOT EXISTS idx_evidence_source_id ON evidence(source_id);

-- Activity logs table
CREATE TABLE IF NOT EXISTS activity_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  activity_type text NOT NULL CHECK (activity_type IN ('search', 'analyze', 'synthesize', 'plan', 'followup', 'compile', 'rank', 'deduplicate')),
  description text NOT NULL DEFAULT '',
  details jsonb DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('running', 'completed', 'failed')),
  created_at timestamptz DEFAULT now()
);

ALTER TABLE activity_logs ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON activity_logs TO anon, authenticated;

DROP POLICY IF EXISTS "anon_select_activity" ON activity_logs;
CREATE POLICY "anon_select_activity" ON activity_logs FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_activity" ON activity_logs;
CREATE POLICY "anon_insert_activity" ON activity_logs FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_activity" ON activity_logs;
CREATE POLICY "anon_update_activity" ON activity_logs FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_activity" ON activity_logs;
CREATE POLICY "anon_delete_activity" ON activity_logs FOR DELETE TO anon, authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_activity_conversation_id ON activity_logs(conversation_id);

-- Research presets table
CREATE TABLE IF NOT EXISTS research_presets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  category text NOT NULL,
  description text NOT NULL DEFAULT '',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_legacy boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE research_presets ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON research_presets TO anon, authenticated;

DROP POLICY IF EXISTS "anon_select_presets" ON research_presets;
CREATE POLICY "anon_select_presets" ON research_presets FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_presets" ON research_presets;
CREATE POLICY "anon_insert_presets" ON research_presets FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_presets" ON research_presets;
CREATE POLICY "anon_update_presets" ON research_presets FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_presets" ON research_presets;
CREATE POLICY "anon_delete_presets" ON research_presets FOR DELETE TO anon, authenticated USING (true);

-- Seed default research presets
INSERT INTO research_presets (name, category, description, config) VALUES
  ('general', 'general', 'Balanced general-purpose research with broad discovery', '{"engines": ["duckduckgo", "wikipedia", "arxiv", "github"], "max_iterations": 2, "max_results": 5, "evidence_required": false, "use_dorks": false}'::jsonb),
  ('deep', 'general', 'Deep investigation with extended search and evidence analysis', '{"engines": ["duckduckgo", "wikipedia", "arxiv", "github", "brave"], "max_iterations": 5, "max_results": 8, "evidence_required": true, "use_dorks": true}'::jsonb),
  ('historical', 'general', 'Historical and archival research with primary source emphasis', '{"engines": ["duckduckgo", "wikipedia", "arxiv"], "max_iterations": 4, "max_results": 6, "evidence_required": true, "use_dorks": true}'::jsonb),
  ('academic', 'general', 'Academic literature search with scholarly sources', '{"engines": ["arxiv", "wikipedia", "duckduckgo"], "max_iterations": 3, "max_results": 8, "evidence_required": true, "use_dorks": false}'::jsonb),
  ('technical', 'general', 'Technical research and software discovery', '{"engines": ["github", "duckduckgo", "wikipedia"], "max_iterations": 3, "max_results": 6, "evidence_required": false, "use_dorks": true}'::jsonb),
  ('fact-check', 'verification', 'Fact-checking and source verification', '{"engines": ["duckduckgo", "wikipedia", "brave"], "max_iterations": 4, "max_results": 5, "evidence_required": true, "use_dorks": true, "contradiction_hunt": true}'::jsonb),
  ('source-tracing', 'verification', 'Trace claims to original sources', '{"engines": ["duckduckgo", "wikipedia", "arxiv"], "max_iterations": 5, "max_results": 6, "evidence_required": true, "use_dorks": true}'::jsonb),
  ('timeline', 'verification', 'Reconstruct timelines from multiple sources', '{"engines": ["duckduckgo", "wikipedia", "arxiv"], "max_iterations": 4, "max_results": 6, "evidence_required": true, "use_dorks": false}'::jsonb),
  ('evidence-dossier', 'verification', 'Build a structured evidence dossier', '{"engines": ["duckduckgo", "wikipedia", "arxiv", "github", "brave"], "max_iterations": 6, "max_results": 8, "evidence_required": true, "use_dorks": true}'::jsonb),
  ('explain', 'analytical', 'Explain a system or concept in depth', '{"engines": ["duckduckgo", "wikipedia", "arxiv", "github"], "max_iterations": 3, "max_results": 6, "evidence_required": false, "use_dorks": false}'::jsonb),
  ('map-relationships', 'analytical', 'Map relationships between entities', '{"engines": ["duckduckgo", "wikipedia", "arxiv"], "max_iterations": 4, "max_results": 6, "evidence_required": true, "use_dorks": false}'::jsonb),
  ('research-gaps', 'analytical', 'Identify gaps in existing research', '{"engines": ["arxiv", "wikipedia", "duckduckgo"], "max_iterations": 5, "max_results": 7, "evidence_required": true, "use_dorks": true}'::jsonb),
  ('dark', 'legacy', 'Legacy dark configuration preserved from original Fieldwork', '{"engines": ["duckduckgo", "brave"], "max_iterations": 3, "max_results": 5, "use_dorks": true, "is_legacy": true}'::jsonb),
  ('deep-legacy', 'legacy', 'Legacy deep search configuration preserved from original Fieldwork', '{"engines": ["duckduckgo", "wikipedia", "arxiv", "github", "brave"], "max_iterations": 6, "max_results": 10, "use_dorks": true, "is_legacy": true}'::jsonb),
  ('shodan-web', 'legacy', 'Legacy Shodan Web configuration preserved from original Fieldwork', '{"engines": ["duckduckgo", "brave"], "max_iterations": 3, "max_results": 5, "use_dorks": true, "is_legacy": true, "shodan_enabled": true}'::jsonb)
ON CONFLICT (name) DO NOTHING;
