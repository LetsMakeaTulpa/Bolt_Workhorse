/**
 * What a chat turn does when its search did not come back cleanly.
 *
 * The old behaviour was `if (runAborted()) return`, and it produced the worst possible outcome for
 * a chat: the question stayed on screen with nothing under it, no error, no notice, and no way to
 * tell whether the app had broken. Three cases have to be told apart, and every one of them now ends
 * visibly:
 *
 *  - a newer question replaced this one — say so. The newer turn owns the answer, and this turn
 *    answering would abort the stream already running, but a silent exit still leaves a question
 *    with nothing under it;
 *  - a person pressed stop — say so, in the transcript, and stop;
 *  - anything else interrupted the search (an engine-set change re-superseding the run, a provider
 *    that never answered) — answer anyway. Chatting is the point; sources are the bonus.
 */

export type AfterSearchAction = 'answer' | 'stopped-note' | 'superseded-note';

export function decideAfterSearch({
  aborted,
  cancelled,
  superseded,
}: {
  aborted: boolean;
  cancelled: boolean;
  superseded: boolean;
}): AfterSearchAction {
  if (!aborted) return 'answer';
  if (superseded) return 'superseded-note';
  if (cancelled) return 'stopped-note';
  return 'answer';
}

/** The transcript line a stopped search leaves behind, so the question is never left unanswered. */
export const STOPPED_SEARCH_NOTE =
  '_(Search stopped — nothing was answered. Send the question again, or switch Search off to just talk.)_';

/** The line a question leaves behind when a newer one took over: replaced, but never dropped quietly. */
export const SUPERSEDED_SEARCH_NOTE =
  '_(Search replaced by a newer question — this one was not answered. Ask it again if you still want it.)_';

/**
 * Which of the two notes is standing where an answer should be.
 *
 * The transcript uses this to offer a retry next to the note. Both notes tell the reader to send the
 * question again; before this, that meant retyping it, which is a strange thing to ask of a button
 * that could just be there. Recognising the note by its exact text keeps the pairing honest: a real
 * answer that happens to mention a stopped search is not a stopped search.
 */
export type UnansweredKind = 'stopped' | 'superseded';

export function unansweredKind(content: string): UnansweredKind | null {
  const text = content.trim();
  if (text === STOPPED_SEARCH_NOTE) return 'stopped';
  if (text === SUPERSEDED_SEARCH_NOTE) return 'superseded';
  return null;
}
