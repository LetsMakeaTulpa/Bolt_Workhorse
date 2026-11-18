-- What each of the model's own extra searches added.
--
-- The transcript strip lists the queries the model ran for itself, but it only knew their names.
-- A search that brought in five pages the answer did not have and a search that returned the same
-- three again were indistinguishable, which is the difference between a budget well spent and a
-- budget wasted on a query the first pass had already answered.
--
-- jsonb array of { query, found, added }. `added` counts the results this answer did not already
-- hold, so 0 is a redundant search rather than a failed one. An empty array means the turn recorded
-- no extra searches — the same thing a row written before this column means.

alter table public.messages
  add column if not exists tool_search_yields jsonb not null default '[]'::jsonb;

comment on column public.messages.tool_search_yields is
  'Per extra search: { query, found, added }, where added counts results the answer did not already have.';
