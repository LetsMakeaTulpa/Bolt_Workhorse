-- Whether the reader said this answer met the question.
--
-- Everything stored with an answer measures relevance: how well a page matched the words, and which
-- terms lifted it in the fusion pass. None of that says the answer was worth having — a turn can
-- rank perfectly and still miss what was asked — so the engine weights and the ranking cuts had no
-- outcome to be scored against. One press on the answer labels the whole turn: its queries, the
-- pages the prompt carried, and the `score_terms` that ranked them.
--
-- true  = the reader said it answered the question
-- false = the reader said it missed
-- null  = no one has said either way, which is not the same as "no"
--
-- Nullable on purpose: a row that was never rated must not be counted as a miss.

alter table public.messages
  add column if not exists useful boolean;

comment on column public.messages.useful is
  'Reader verdict on whether the answer met the question: true answered, false missed, null unrated.';
