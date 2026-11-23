-- The per-lane result lists behind every search run.
--
-- Fusion keeps the fused list, the panel keeps the top sources, and the trail keeps per-engine
-- counts. What no table kept was the ranked list each engine actually returned. That is the only
-- record from which two runs can be compared: a page that three engines independently returned and
-- three engines returning the same page look identical once fused, and an engine's weight cannot be
-- scored against the queries it was tuned on without knowing what it offered before ranking.
--
-- `lanes` is one object per lane, in the order the run introduced them:
--   { lane, engine, query, urls }
-- `lane` is the fusion lane key — an engine id, or `engine·q2` for the second query of a dork batch —
-- because that is the unit fusion scores. `urls` is the ordered, canonical list that lane returned:
-- canonical so a run compares to another despite tracking parameters, ordered because that order is
-- the engine's ranking, which is exactly what a replay has to reproduce.
--
-- `lanes_hash` is a stable fingerprint of those lists (lane names and ordered urls, sorted by lane):
-- two runs with the same fingerprint saw the same result surface, whatever order the lanes answered
-- in. It is an index for finding comparable runs, not evidence on its own — the lists are.
--
-- A run is stored whether or not it produced a source: an engine that returned nothing is a fact
-- about the run, and the agreement matrix needs the zeros.

create table if not exists public.search_runs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.conversations(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade default auth.uid(),
  query text not null,
  kind text not null default 'search' check (kind in ('search', 'dork')),
  engines text[] not null default '{}',
  queries_used jsonb not null default '[]'::jsonb,
  lanes jsonb not null default '[]'::jsonb,
  lanes_hash text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_search_runs_conversation on public.search_runs(conversation_id, created_at desc);
create index if not exists idx_search_runs_hash on public.search_runs(lanes_hash);

alter table public.search_runs enable row level security;

revoke all on table public.search_runs from public, anon, authenticated;
grant select, insert on table public.search_runs to authenticated;
grant select, insert, update, delete on table public.search_runs to service_role;

drop policy if exists "own_search_runs" on public.search_runs;
create policy "own_search_runs" on public.search_runs for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

comment on table public.search_runs is
  'Per-lane result lists and a stable fingerprint for each search run, for replay and comparison.';
comment on column public.search_runs.lanes is
  'One { lane, engine, query, urls } per fusion lane, urls in the order the engine ranked them.';
comment on column public.search_runs.lanes_hash is
  'Stable fingerprint of the lane lists, independent of the order lanes answered in.';
