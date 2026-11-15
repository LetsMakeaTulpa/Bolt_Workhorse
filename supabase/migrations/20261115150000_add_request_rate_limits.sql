/*
# Per-caller rate limits for the llm-proxy

## Why

Every inference request spends the project owner's Featherless credits. The anon key is public
by design (it ships in the browser bundle), so anyone can call the proxy — the only thing
standing between that and a drained balance was nothing at all.

## What this adds

`request_rate_limits` is a counter table: one row per (bucket, fixed window start). The proxy
calls `consume_rate_limit` once per window before forwarding, and refuses the request when the
counter is over budget. The insert-or-increment is a single atomic upsert, so two concurrent
requests cannot both read "one left".

Buckets are SHA-256 hashes built in the function: `user:<hash>` for a verified session and
`anonymous:<ip-hash>` otherwise. No raw IP address or user id is stored here.

The table has RLS enabled with no policies plus revoked privileges for `anon` and
`authenticated`: only the service role (the proxy) can read or write it, and only the service
role may execute the function.

Limits live in `supabase/functions/llm-proxy/rateLimit.ts` so they can be changed and tested
without touching SQL.
*/

BEGIN;

CREATE TABLE IF NOT EXISTS public.request_rate_limits (
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

CREATE INDEX IF NOT EXISTS idx_request_rate_limits_window
  ON public.request_rate_limits(window_start);

ALTER TABLE public.request_rate_limits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.request_rate_limits FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.request_rate_limits TO service_role;

/*
Counts one hit in the bucket's current window and reports whether it is still within budget.
Windows are wall-clock aligned (floor(epoch / size)), so they roll over predictably.
*/
CREATE OR REPLACE FUNCTION public.consume_rate_limit(
  p_bucket text,
  p_window_seconds integer,
  p_limit integer
)
RETURNS TABLE (allowed boolean, used integer, remaining integer, reset_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start timestamptz := to_timestamp(
    floor(extract(epoch FROM clock_timestamp()) / p_window_seconds) * p_window_seconds
  );
  v_hits integer;
BEGIN
  IF p_limit IS NULL OR p_limit <= 0 THEN
    RETURN QUERY SELECT false, 0, 0, v_start + make_interval(secs => p_window_seconds);
    RETURN;
  END IF;

  INSERT INTO public.request_rate_limits AS r (bucket, window_start, hits)
  VALUES (p_bucket, v_start, 1)
  ON CONFLICT (bucket, window_start) DO UPDATE SET hits = r.hits + 1
  RETURNING r.hits INTO v_hits;

  -- keep the table tiny without needing a cron job
  DELETE FROM public.request_rate_limits WHERE window_start < v_start - interval '2 days';

  RETURN QUERY
    SELECT v_hits <= p_limit,
           v_hits,
           greatest(p_limit - v_hits, 0),
           v_start + make_interval(secs => p_window_seconds);
END;
$$;

REVOKE ALL ON FUNCTION public.consume_rate_limit(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_rate_limit(text, integer, integer) TO service_role;

COMMENT ON TABLE public.request_rate_limits IS
  'Fixed-window counters for the llm-proxy; service role only, keyed by hashed caller identity.';

COMMIT;
