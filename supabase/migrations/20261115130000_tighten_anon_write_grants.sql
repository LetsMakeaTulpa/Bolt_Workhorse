/*
# Tighten anon write access to what the client actually uses

## Problem

Every table was created with `GRANT SELECT, INSERT, UPDATE, DELETE ... TO anon` and
`USING (true)` policies. The app is single-tenant and has no auth, so `anon` *is* the user
and needs to write — but it was also granted verbs nothing in the client calls, and three
tables (`research_presets`, `evidence`, `search_settings`) were never written by the client
at all. Any holder of the public anon key could therefore rewrite the seeded presets, forge
evidence records or change search settings.

Verified before this migration with `experiments/rls-probe.sh`: every table accepted an anon
INSERT/PATCH/DELETE attempt (rejected only by a CHECK/UNIQUE constraint, proving the grant
and the permissive policy were reachable).

## What this migration does

| table               | anon keeps              | revoked                  |
|---------------------|-------------------------|--------------------------|
| conversations       | SELECT INSERT UPDATE DELETE | —                    |
| messages            | SELECT INSERT           | UPDATE DELETE            |
| findings            | SELECT INSERT UPDATE DELETE | —                    |
| sources             | SELECT INSERT           | UPDATE DELETE            |
| activity_logs       | SELECT INSERT           | UPDATE DELETE            |
| research_presets    | SELECT                  | INSERT UPDATE DELETE     |
| research_projects   | SELECT                  | INSERT UPDATE DELETE     |
| evidence            | SELECT                  | INSERT UPDATE DELETE     |
| search_settings     | SELECT                  | INSERT UPDATE DELETE     |

`app_config` is already service-role only (20261115120000). The revoked verbs also had their
matching policies dropped so the intent is explicit rather than "grant quietly absent".

`service_role` gets full access to every table so server-side scripts and edge functions are
never the ones blocked.

## Note on scope

This does not add authentication. Conversations, messages and findings remain world-readable
and world-writable by design (no-auth single-tenant app). Adding real per-user auth is the
only way to change that.
*/

BEGIN;

-- conversations: the client creates, lists, renames and deletes them
REVOKE ALL ON TABLE public.conversations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.conversations TO anon, authenticated;

-- messages: written once when sent; never edited or deleted by the client (conversations cascade)
REVOKE ALL ON TABLE public.messages FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.messages TO anon, authenticated;
DROP POLICY IF EXISTS "anon_update_messages" ON public.messages;
DROP POLICY IF EXISTS "anon_delete_messages" ON public.messages;

-- findings: saved, re-statused and discarded from the evidence panel
REVOKE ALL ON TABLE public.findings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.findings TO anon, authenticated;

-- sources: inserted from a search run, read by the sources panel; never edited
REVOKE ALL ON TABLE public.sources FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.sources TO anon, authenticated;
DROP POLICY IF EXISTS "anon_update_sources" ON public.sources;
DROP POLICY IF EXISTS "anon_delete_sources" ON public.sources;

-- activity logs: an append-only trail
REVOKE ALL ON TABLE public.activity_logs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.activity_logs TO anon, authenticated;
DROP POLICY IF EXISTS "anon_update_activity" ON public.activity_logs;
DROP POLICY IF EXISTS "anon_delete_activity" ON public.activity_logs;

-- presets: seeded configuration, read-only for the client
REVOKE ALL ON TABLE public.research_presets FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.research_presets TO anon, authenticated;
DROP POLICY IF EXISTS "anon_insert_presets" ON public.research_presets;
DROP POLICY IF EXISTS "anon_update_presets" ON public.research_presets;
DROP POLICY IF EXISTS "anon_delete_presets" ON public.research_presets;

-- projects: not written by the client (yet); keep it readable, not forgeable
REVOKE ALL ON TABLE public.research_projects FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.research_projects TO anon, authenticated;
DROP POLICY IF EXISTS "anon_insert_projects" ON public.research_projects;
DROP POLICY IF EXISTS "anon_update_projects" ON public.research_projects;
DROP POLICY IF EXISTS "anon_delete_projects" ON public.research_projects;

-- evidence: claims are derived server-side, never client-authored
REVOKE ALL ON TABLE public.evidence FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.evidence TO anon, authenticated;
DROP POLICY IF EXISTS "anon_insert_evidence" ON public.evidence;
DROP POLICY IF EXISTS "anon_update_evidence" ON public.evidence;
DROP POLICY IF EXISTS "anon_delete_evidence" ON public.evidence;

-- search settings: app-wide config, not a client-writable preference store
REVOKE ALL ON TABLE public.search_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.search_settings TO anon, authenticated;
DROP POLICY IF EXISTS "anon_insert_search_settings" ON public.search_settings;
DROP POLICY IF EXISTS "anon_update_search_settings" ON public.search_settings;
DROP POLICY IF EXISTS "anon_delete_search_settings" ON public.search_settings;

-- server-side code is never the thing that gets blocked
GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.conversations,
  public.messages,
  public.findings,
  public.sources,
  public.activity_logs,
  public.research_presets,
  public.research_projects,
  public.evidence,
  public.search_settings,
  public.app_config
TO service_role;

COMMIT;
