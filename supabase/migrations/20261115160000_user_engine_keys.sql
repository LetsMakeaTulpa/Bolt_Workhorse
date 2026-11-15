/*
# Per-user search provider keys

## Why

Search providers (Exa, Tavily, Firecrawl, Google CSE, Shodan, urlscan, SearXNG) need secrets the
edge function can read. Until now the only way to supply them was `supabase secrets set`, which
means a terminal, a project access token and a redeploy per key. Signing in and pasting a key
should be enough: the key belongs to the person paying for that provider's quota.

## What changes

1. `user_engine_keys` holds one row per (user, secret name). The name is restricted to an env-var
   shaped identifier so it can be matched against what the function reads.
2. RLS is owner-only for `authenticated`: a signed-in user can read, write and delete their own
   rows and nobody else's. `anon` gets no privileges at all.
3. `service_role` may read the table, because `web-search` resolves the caller's JWT, looks up
   their keys and passes them to the engine for that request only.

## Precedence

Per-user keys win over the function environment. A key set with `supabase secrets set` keeps
working for everyone who has not supplied their own — useful for a shared deployment where the
owner funds one provider, and one person brings their own Tavily quota.

## Notes

Values are readable by the row's owner (they typed them) and by the service role. They are never
returned to the browser by the function, and never logged: the function reports which *name* is
missing, never a value.

Applying this migration is required before the in-app key form can store anything. The function
must be redeployed after it to read the table.
*/

BEGIN;

CREATE TABLE IF NOT EXISTS public.user_engine_keys (
  user_id    uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (name ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  value      text NOT NULL CHECK (char_length(value) BETWEEN 8 AND 4096),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, name)
);

ALTER TABLE public.user_engine_keys ENABLE ROW LEVEL SECURITY;

-- no anonymous access at all: a key belongs to an account
REVOKE ALL ON public.user_engine_keys FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_engine_keys TO authenticated;
GRANT SELECT ON public.user_engine_keys TO service_role;

DROP POLICY IF EXISTS "user_engine_keys_select_own" ON public.user_engine_keys;
DROP POLICY IF EXISTS "user_engine_keys_insert_own" ON public.user_engine_keys;
DROP POLICY IF EXISTS "user_engine_keys_update_own" ON public.user_engine_keys;
DROP POLICY IF EXISTS "user_engine_keys_delete_own" ON public.user_engine_keys;

CREATE POLICY "user_engine_keys_select_own" ON public.user_engine_keys
  FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY "user_engine_keys_insert_own" ON public.user_engine_keys
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

CREATE POLICY "user_engine_keys_update_own" ON public.user_engine_keys
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY "user_engine_keys_delete_own" ON public.user_engine_keys
  FOR DELETE TO authenticated USING (user_id = auth.uid());

COMMIT;
