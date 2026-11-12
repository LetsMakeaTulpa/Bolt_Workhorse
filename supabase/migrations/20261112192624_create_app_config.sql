/*
# Create app_config table for storing the Featherless API key

## Overview
Creates a single-row configuration table that stores the Featherless.ai API key
and other app-wide settings. Edge functions read the key from this table so
users can set it from the app UI without manual secret configuration.

## New Table
- app_config: single-row key-value config store
  - id (int, always 1)
  - featherless_api_key (text, the API key)
  - default_model (text, the default model ID)
  - created_at, updated_at

## Security
- RLS enabled, TO anon, authenticated, full CRUD (single-tenant no-auth app)
*/

CREATE TABLE IF NOT EXISTS app_config (
  id int PRIMARY KEY DEFAULT 1,
  featherless_api_key text DEFAULT '',
  default_model text DEFAULT 'Qwen/Qwen2.5-7B-Instruct',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT single_row CHECK (id = 1)
);

ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON app_config TO anon, authenticated;

DROP POLICY IF EXISTS "anon_select_config" ON app_config;
CREATE POLICY "anon_select_config" ON app_config FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_config" ON app_config;
CREATE POLICY "anon_insert_config" ON app_config FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_config" ON app_config;
CREATE POLICY "anon_update_config" ON app_config FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_config" ON app_config;
CREATE POLICY "anon_delete_config" ON app_config FOR DELETE TO anon, authenticated USING (true);

-- Insert the default row with the provided API key
INSERT INTO app_config (id, featherless_api_key, default_model)
VALUES (1, 'rc_3b23e31edc21eecb510413debce5129d2dcf14d2efaaf79a1edb0e56bbedd42d', 'Qwen/Qwen2.5-7B-Instruct')
ON CONFLICT (id) DO UPDATE SET featherless_api_key = EXCLUDED.featherless_api_key;
