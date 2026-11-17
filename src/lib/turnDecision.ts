/**
 * What a chat turn does when its search did not come back cleanly.
 *
 * The old behaviour was `if (runAborted()) return`, and it produced the worst possible outcome for
 * a chat: the question stayed on screen with nothing under it, no error, no notice, and no way to
 * tell whether the app had broken. Three cases have to be told apart:
 *
 *  - a newer question replaced this one — stay silent; the newer turn owns the transcript, and two
 *    answers racing each other is worse than none;
 *  - a person pressed stop — say so, in the transcript, and stop;
 *  - anything else interrupted the search (an engine-set change re-superseding the run, a provider
 *    that never answered) — answer anyway. Chatting is the point; sources are the bonus.
 */

export type AfterSearchAction = 'answer' | 'stopped-note' | 'silent';

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
  if (superseded) return 'silent';
  if (cancelled) return 'stopped-note';
  return 'answer';
}

/** The transcript line a stopped search leaves behind, so the question is never left unanswered. */
export const STOPPED_SEARCH_NOTE =
  '_(Search stopped — nothing was answered. Send the question again, or switch Search off to just talk.)_';
