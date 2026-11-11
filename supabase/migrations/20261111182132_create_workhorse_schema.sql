/*
# Workhorse AI Search Assistant - Database Schema

## Overview
Creates the core database tables for an AI chat platform with web search capabilities.
The app combines Kimi-style search-augmented chat with Venice.ai-style multi-model selection.
No authentication is used - this is a single-tenant app where all data is shared/public.

## New Tables

### conversations
- Stores chat conversation sessions
- `id` (uuid, primary key)
- `title` (text, conversation title)
- `model` (text, the Featherless model ID used)
- `created_at` (timestamptz)
- `updated_at` (timestamptz)

### messages
- Stores individual messages within conversations
- `id` (uuid, primary key)
- `conversation_id` (uuid, FK to conversations)
- `role` (text: 'user', 'assistant', 'system')
- `content` (text, message content)
- `model` (text, model used for this message)
- `search_enabled` (boolean, whether web search was active)
- `search_results` (jsonb, search results associated with the message)
- `created_at` (timestamptz)

### findings
- Saved web search findings that users can keep, share, retry, or discard
- `id` (uuid, primary key)
- `conversation_id` (uuid, FK to conversations, nullable)
- `message_id` (uuid, FK to messages, nullable)
- `query` (text, the search query)
- `title` (text, finding title)
- `url` (text, source URL)
- `snippet` (text, search result snippet)
- `source_engine` (text, which search engine produced this result)
- `status` (text: 'saved', 'shared', 'discarded', default 'saved')
- `metadata` (jsonb, additional data)
- `created_at` (timestamptz)

### search_settings
- Stores search configuration preferences
- `id` (uuid, primary key)
- `use_dorks` (boolean, whether to auto-apply Google dorks)
- `engines_enabled` (jsonb, array of enabled search engines)
- `max_results_per_engine` (integer, default 5)
- `auto_search` (boolean, whether to auto-trigger search)
- `created_at` (timestamptz)
- `updated_at` (timestamptz)

## Security
- RLS enabled on all tables
- All tables use TO anon, authenticated with USING (true) since this is a single-tenant no-auth app
- Full CRUD granted to anon + authenticated roles
*/

-- Conversations table
CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL DEFAULT 'New Conversation',
  model text NOT NULL DEFAULT 'Qwen/Qwen2.5-7B-Instruct',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON conversations TO anon, authenticated;

DROP POLICY IF EXISTS "anon_select_conversations" ON conversations;
CREATE POLICY "anon_select_conversations" ON conversations FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_conversations" ON conversations;
CREATE POLICY "anon_insert_conversations" ON conversations FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_conversations" ON conversations;
CREATE POLICY "anon_update_conversations" ON conversations FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_conversations" ON conversations;
CREATE POLICY "anon_delete_conversations" ON conversations FOR DELETE
  TO anon, authenticated USING (true);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content text NOT NULL DEFAULT '',
  model text,
  search_enabled boolean DEFAULT false,
  search_results jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON messages TO anon, authenticated;

DROP POLICY IF EXISTS "anon_select_messages" ON messages;
CREATE POLICY "anon_select_messages" ON messages FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_messages" ON messages;
CREATE POLICY "anon_insert_messages" ON messages FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_messages" ON messages;
CREATE POLICY "anon_update_messages" ON messages FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_messages" ON messages;
CREATE POLICY "anon_delete_messages" ON messages FOR DELETE
  TO anon, authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

-- Findings table
CREATE TABLE IF NOT EXISTS findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  query text NOT NULL,
  title text NOT NULL DEFAULT '',
  url text NOT NULL DEFAULT '',
  snippet text NOT NULL DEFAULT '',
  source_engine text NOT NULL DEFAULT 'auto',
  status text NOT NULL DEFAULT 'saved' CHECK (status IN ('saved', 'shared', 'discarded')),
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE findings ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON findings TO anon, authenticated;

DROP POLICY IF EXISTS "anon_select_findings" ON findings;
CREATE POLICY "anon_select_findings" ON findings FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_findings" ON findings;
CREATE POLICY "anon_insert_findings" ON findings FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_findings" ON findings;
CREATE POLICY "anon_update_findings" ON findings FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_findings" ON findings;
CREATE POLICY "anon_delete_findings" ON findings FOR DELETE
  TO anon, authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_findings_conversation_id ON findings(conversation_id);
CREATE INDEX IF NOT EXISTS idx_findings_status ON findings(status);
CREATE INDEX IF NOT EXISTS idx_findings_created_at ON findings(created_at);

-- Search settings table (single row for app-wide settings)
CREATE TABLE IF NOT EXISTS search_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  use_dorks boolean DEFAULT false,
  engines_enabled jsonb DEFAULT '["duckduckgo","wikipedia","arxiv","github","brave"]'::jsonb,
  max_results_per_engine integer DEFAULT 5,
  auto_search boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE search_settings ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON search_settings TO anon, authenticated;

DROP POLICY IF EXISTS "anon_select_search_settings" ON search_settings;
CREATE POLICY "anon_select_search_settings" ON search_settings FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_search_settings" ON search_settings;
CREATE POLICY "anon_insert_search_settings" ON search_settings FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_search_settings" ON search_settings;
CREATE POLICY "anon_update_search_settings" ON search_settings FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_search_settings" ON search_settings;
CREATE POLICY "anon_delete_search_settings" ON search_settings FOR DELETE
  TO anon, authenticated USING (true);
