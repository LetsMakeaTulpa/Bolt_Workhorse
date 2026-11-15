/*
# Real per-user auth: owner columns and user-scoped RLS

## Why

Every table was readable and writable by `anon` with `USING (true)` policies. The public
anon key ships in the browser bundle, so anyone who loaded the page could read and edit all
research in the project. This adds Supabase Auth as the identity source and scopes every
private table to its owner.

## What changes

1. `user_id uuid REFERENCES auth.users(id)` on every table that holds research data, with
   `DEFAULT auth.uid()` so the client never has to send it (PostgREST applies the default
   inside the request's JWT context).
2. Existing child rows are backfilled from their parent conversation.
3. All `anon_*` policies are dropped. `anon` loses every privilege on private tables, so an
   unauthenticated request gets a permission error rather than an empty result.
4. `authenticated` gets CRUD, but only through policies of the form
   `user_id = auth.uid()` — reads, writes, updates and deletes are all scoped to the caller.
5. `research_presets` and `search_settings` stay shared reference data: readable by signed-in
   users, not writable by them, invisible to `anon`.

## Existing data

Rows created before this migration have no owner, so they become invisible rather than
public. To hand them to your account after signing in once:

    -- as the service role, in the SQL editor
    UPDATE public.conversations SET user_id = '<your-auth-user-uuid>' WHERE user_id IS NULL;
    UPDATE public.messages m SET user_id = c.user_id FROM public.conversations c
      WHERE m.conversation_id = c.id AND m.user_id IS NULL;
    UPDATE public.sources s SET user_id = c.user_id FROM public.conversations c
      WHERE s.conversation_id = c.id AND s.user_id IS NULL;
    UPDATE public.findings f SET user_id = c.user_id FROM public.conversations c
      WHERE f.conversation_id = c.id AND f.user_id IS NULL;
    UPDATE public.activity_logs a SET user_id = c.user_id FROM public.conversations c
      WHERE a.conversation_id = c.id AND a.user_id IS NULL;
    UPDATE public.evidence e SET user_id = c.user_id FROM public.conversations c
      WHERE e.conversation_id = c.id AND e.user_id IS NULL;

## Still true after this

`app_config` remains service-role only (the Featherless key), and `app_config_public` stays
readable because it carries no secrets. Search and inference still run through edge functions
that use the service role, so per-user data never reaches them through the browser.
*/

BEGIN;

-- 1. owner columns, defaulting to the caller so inserts need no client change
ALTER TABLE public.conversations     ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.messages         ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.sources          ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.findings         ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.evidence         ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.activity_logs    ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.research_projects ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.conversations     ALTER COLUMN user_id SET DEFAULT auth.uid();
ALTER TABLE public.messages         ALTER COLUMN user_id SET DEFAULT auth.uid();
ALTER TABLE public.sources          ALTER COLUMN user_id SET DEFAULT auth.uid();
ALTER TABLE public.findings         ALTER COLUMN user_id SET DEFAULT auth.uid();
ALTER TABLE public.evidence         ALTER COLUMN user_id SET DEFAULT auth.uid();
ALTER TABLE public.activity_logs    ALTER COLUMN user_id SET DEFAULT auth.uid();
ALTER TABLE public.research_projects ALTER COLUMN user_id SET DEFAULT auth.uid();

-- 2. backfill children from the conversation that owns them
UPDATE public.messages m SET user_id = c.user_id
  FROM public.conversations c WHERE m.conversation_id = c.id AND m.user_id IS NULL;
UPDATE public.sources s SET user_id = c.user_id
  FROM public.conversations c WHERE s.conversation_id = c.id AND s.user_id IS NULL;
UPDATE public.findings f SET user_id = c.user_id
  FROM public.conversations c WHERE f.conversation_id = c.id AND f.user_id IS NULL;
UPDATE public.activity_logs a SET user_id = c.user_id
  FROM public.conversations c WHERE a.conversation_id = c.id AND a.user_id IS NULL;
UPDATE public.evidence e SET user_id = c.user_id
  FROM public.conversations c WHERE e.conversation_id = c.id AND e.user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_user     ON public.conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_user          ON public.messages(user_id);
CREATE INDEX IF NOT EXISTS idx_sources_user           ON public.sources(user_id);
CREATE INDEX IF NOT EXISTS idx_findings_user          ON public.findings(user_id);
CREATE INDEX IF NOT EXISTS idx_evidence_user          ON public.evidence(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_user     ON public.activity_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_research_projects_user ON public.research_projects(user_id);

-- 3. anon loses the private tables entirely
REVOKE ALL ON TABLE
  public.conversations, public.messages, public.sources, public.findings,
  public.evidence, public.activity_logs, public.research_projects
FROM PUBLIC, anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.conversations, public.messages, public.sources, public.findings,
  public.evidence, public.activity_logs, public.research_projects
TO authenticated;

-- 4. conversations
DROP POLICY IF EXISTS "anon_select_conversations" ON public.conversations;
DROP POLICY IF EXISTS "anon_insert_conversations" ON public.conversations;
DROP POLICY IF EXISTS "anon_update_conversations" ON public.conversations;
DROP POLICY IF EXISTS "anon_delete_conversations" ON public.conversations;
DROP POLICY IF EXISTS "own_conversations" ON public.conversations;
CREATE POLICY "own_conversations" ON public.conversations FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- 5. messages
DROP POLICY IF EXISTS "anon_select_messages" ON public.messages;
DROP POLICY IF EXISTS "anon_insert_messages" ON public.messages;
DROP POLICY IF EXISTS "anon_update_messages" ON public.messages;
DROP POLICY IF EXISTS "anon_delete_messages" ON public.messages;
DROP POLICY IF EXISTS "own_messages" ON public.messages;
CREATE POLICY "own_messages" ON public.messages FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- 6. sources
DROP POLICY IF EXISTS "anon_select_sources" ON public.sources;
DROP POLICY IF EXISTS "anon_insert_sources" ON public.sources;
DROP POLICY IF EXISTS "anon_update_sources" ON public.sources;
DROP POLICY IF EXISTS "anon_delete_sources" ON public.sources;
DROP POLICY IF EXISTS "own_sources" ON public.sources;
CREATE POLICY "own_sources" ON public.sources FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- 7. findings
DROP POLICY IF EXISTS "anon_select_findings" ON public.findings;
DROP POLICY IF EXISTS "anon_insert_findings" ON public.findings;
DROP POLICY IF EXISTS "anon_update_findings" ON public.findings;
DROP POLICY IF EXISTS "anon_delete_findings" ON public.findings;
DROP POLICY IF EXISTS "own_findings" ON public.findings;
CREATE POLICY "own_findings" ON public.findings FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- 8. evidence
DROP POLICY IF EXISTS "anon_select_evidence" ON public.evidence;
DROP POLICY IF EXISTS "anon_insert_evidence" ON public.evidence;
DROP POLICY IF EXISTS "anon_update_evidence" ON public.evidence;
DROP POLICY IF EXISTS "anon_delete_evidence" ON public.evidence;
DROP POLICY IF EXISTS "own_evidence" ON public.evidence;
CREATE POLICY "own_evidence" ON public.evidence FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- 9. activity logs
DROP POLICY IF EXISTS "anon_select_activity" ON public.activity_logs;
DROP POLICY IF EXISTS "anon_insert_activity" ON public.activity_logs;
DROP POLICY IF EXISTS "anon_update_activity" ON public.activity_logs;
DROP POLICY IF EXISTS "anon_delete_activity" ON public.activity_logs;
DROP POLICY IF EXISTS "own_activity" ON public.activity_logs;
CREATE POLICY "own_activity" ON public.activity_logs FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- 10. research projects
DROP POLICY IF EXISTS "anon_select_projects" ON public.research_projects;
DROP POLICY IF EXISTS "anon_insert_projects" ON public.research_projects;
DROP POLICY IF EXISTS "anon_update_projects" ON public.research_projects;
DROP POLICY IF EXISTS "anon_delete_projects" ON public.research_projects;
DROP POLICY IF EXISTS "own_projects" ON public.research_projects;
CREATE POLICY "own_projects" ON public.research_projects FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- 11. shared reference data: readable when signed in, never client-writable
REVOKE ALL ON TABLE public.research_presets FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.research_presets TO authenticated;
DROP POLICY IF EXISTS "anon_select_presets" ON public.research_presets;
DROP POLICY IF EXISTS "anon_insert_presets" ON public.research_presets;
DROP POLICY IF EXISTS "anon_update_presets" ON public.research_presets;
DROP POLICY IF EXISTS "anon_delete_presets" ON public.research_presets;
DROP POLICY IF EXISTS "shared_presets_read" ON public.research_presets;
CREATE POLICY "shared_presets_read" ON public.research_presets FOR SELECT TO authenticated USING (true);

REVOKE ALL ON TABLE public.search_settings FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.search_settings TO authenticated;
DROP POLICY IF EXISTS "anon_select_search_settings" ON public.search_settings;
DROP POLICY IF EXISTS "anon_insert_search_settings" ON public.search_settings;
DROP POLICY IF EXISTS "anon_update_search_settings" ON public.search_settings;
DROP POLICY IF EXISTS "anon_delete_search_settings" ON public.search_settings;
DROP POLICY IF EXISTS "shared_settings_read" ON public.search_settings;
CREATE POLICY "shared_settings_read" ON public.search_settings FOR SELECT TO authenticated USING (true);

-- 12. server-side code keeps working
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.conversations, public.messages, public.sources, public.findings,
  public.evidence, public.activity_logs, public.research_projects,
  public.research_presets, public.search_settings, public.app_config
TO service_role;

COMMIT;
