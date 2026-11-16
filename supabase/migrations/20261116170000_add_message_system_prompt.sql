-- The prompt that produced an answer, stored with the answer.
--
-- A prompt variant changes behaviour — answer budget, claim ledger, citation rules — so which prompt
-- answered a question is part of what the row means, not a setting local to whichever machine sent
-- it. Storing the text itself rather than a flag means an answer stays traceable after the variant is
-- edited or cleared in Settings.
--
-- Null means the row predates this column, or was written before the client recorded it; the built-in
-- prompt is the only other candidate, and an unknown row is left unknown rather than assumed.

alter table public.messages add column if not exists system_prompt text;

comment on column public.messages.system_prompt is
  'The exact system prompt sent with this assistant turn; null when it was not recorded.';
