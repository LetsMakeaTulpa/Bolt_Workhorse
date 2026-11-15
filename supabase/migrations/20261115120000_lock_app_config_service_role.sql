/*
# Lock app_config down to service_role and expose a keyless public view

## Problem

`app_config` holds the Featherless API key, but the original migration granted full
CRUD to `anon` with `USING (true)` policies. Because the anon key ships in the browser
bundle, anyone who loaded the app could read the API key with a single REST call and
could also overwrite it.

## What this migration does

1. Revokes every privilege on `app_config` from `PUBLIC`, `anon` and `authenticated`.
2. Drops the four permissive `anon_*` policies.
3. Grants full access to `service_role` only, with an explicit policy documenting that
   the edge functions (`llm-proxy`, `web-search`) are the only readers of the key.
4. Creates `app_config_public`, a view that exposes the non-secret settings the browser
   legitimately needs — `default_model`, whether a key exists as a boolean, and
   `updated_at` — and nothing that could leak the key itself.

## Client impact

The in-app API key field in Settings called `app_config` directly with the anon key. That
path is closed by design: set the key with the service role (SQL editor, `supabase secrets`,
or a service-role script). The UI now reads `app_config_public` and reports only whether a
key is configured.
*/

BEGIN;

-- 1. nothing reaches the table itself without the service role
REVOKE ALL ON TABLE public.app_config FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.app_config TO service_role;

-- 2. remove the permissive browser policies
DROP POLICY IF EXISTS "anon_select_config" ON public.app_config;
DROP POLICY IF EXISTS "anon_insert_config" ON public.app_config;
DROP POLICY IF EXISTS "anon_update_config" ON public.app_config;
DROP POLICY IF EXISTS "anon_delete_config" ON public.app_config;

-- 3. document service_role as the intended reader (it bypasses RLS, the policy is explicit intent)
DROP POLICY IF EXISTS "service_role_all_config" ON public.app_config;
CREATE POLICY "service_role_all_config" ON public.app_config
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- 4. keyless public view: column whitelist, no key, no key fragments
DROP VIEW IF EXISTS public.app_config_public;
CREATE VIEW public.app_config_public
WITH (security_invoker = false, security_barrier = true) AS
SELECT
  id,
  default_model,
  (featherless_api_key IS NOT NULL AND featherless_api_key <> '') AS has_api_key,
  updated_at
FROM public.app_config
WHERE id = 1;

COMMENT ON VIEW public.app_config_public IS
  'Non-secret app settings for browser clients. The Featherless key stays in app_config, readable only by service_role.';

REVOKE ALL ON TABLE public.app_config_public FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.app_config_public TO anon, authenticated;

COMMIT;
