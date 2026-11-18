-- The gaps behind an answer that had no sources.
--
-- A search that collects nothing still ends in an answer, and the answer is labelled unverified. The
-- reason it has no sources — which engine failed, which lane came back empty, which lane the
-- relevance gate emptied — used to live only in the activity trail and the Sources panel, both of
-- which can be collapsed. Keeping the lines with the answer puts them in the transcript, where the
-- badge is, and keeps them there after a reload.
--
-- jsonb array of strings, one per gap. An empty array is "none recorded" — never null — so a row
-- written before this column means the same thing as an answer that had sources.

alter table public.messages
  add column if not exists gaps jsonb not null default '[]'::jsonb;

comment on column public.messages.gaps is
  'Gaps behind an unsourced answer, as displayed (jsonb array of strings); empty when the answer had sources.';
