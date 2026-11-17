-- The searches the model ran on its own, in the order it asked for them.
--
-- Which sources were read in full can be told from search_results (they carry the page text), but a
-- query the model invented is linked to nothing: after a reload the second search of a turn is
-- invisible, and "why does this answer cite a paper the question never mentioned" has no answer on
-- screen. Keeping the queries makes the machine part of the transcript: what was read, what was
-- searched, and a query the reader can run again themselves.
--
-- jsonb array of strings, oldest first. An empty array is "none recorded" — never null — so a row
-- written before this column means the same thing as a turn where the model searched once.

alter table public.messages
  add column if not exists tool_searches jsonb not null default '[]'::jsonb;

comment on column public.messages.tool_searches is
  'Extra search_web queries the model ran during this turn, oldest first (jsonb array of strings).';
