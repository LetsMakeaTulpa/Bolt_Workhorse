-- A retried turn, linked to the attempt it replaced.
--
-- Asking again appends a new question and answer, so on screen a retry read as an unrelated answer
-- beside the stopped one: nothing said the two attempts were the same question, and a reader could
-- only tell by comparing the prose. The new turn now records the message it replaces, so the
-- transcript can say "retry of the earlier attempt" and the replaced turn can point forward to it.
--
-- Nullable, and `on delete set null`: a link that outlives its target would point at nothing.

alter table public.messages
  add column if not exists retry_of uuid references public.messages(id) on delete set null;

comment on column public.messages.retry_of is
  'The message this turn retries; null for a first attempt.';
