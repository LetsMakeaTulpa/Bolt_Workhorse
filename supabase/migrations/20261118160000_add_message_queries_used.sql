-- The queries the search actually sent for this answer's question.
--
-- The compiler rewrites the question before any engine sees it, and the transcript could not say
-- what it was rewritten into: the words that produced the sources were only ever shown in the
-- Sources panel for the latest run, and vanished once another search replaced it. Recording them
-- with the answer lets "what did the model read" start with what was asked.
--
-- jsonb array of query strings, in the order they were sent. An empty array means this turn ran no
-- search — a retry answered from sources already retrieved, or search switched off — which is not
-- the same as a row written before this column existed.

alter table public.messages
  add column if not exists queries_used jsonb not null default '[]'::jsonb;

comment on column public.messages.queries_used is
  'Queries the search sent, in order, after the compiler rewrote the question; empty when no search ran.';
