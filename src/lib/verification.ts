/**
 * Whether an answer was produced without a single retrieved source.
 *
 * A turn that ran a search and collected nothing still gets an answer — deliberately, since an
 * answer is better than an empty page — but until now the only trace was a line in the activity log,
 * which is a panel people collapse. In the transcript an ungrounded answer looked exactly like a
 * grounded one. This is the signal the bubble needs: `search_enabled` with no `search_results`.
 *
 * Reading the message rather than a flag on the current turn matters, because it survives a reload:
 * a conversation opened tomorrow still knows which of its answers had nothing behind them. A turn
 * with search off is not unverified — it never claimed sources in the first place.
 */
export interface VerifiableMessage {
  role: string;
  search_enabled?: boolean | null;
  search_results?: unknown[] | null;
}

export function isUnverifiedAnswer(message: VerifiableMessage): boolean {
  if (message.role !== 'assistant') return false;
  if (!message.search_enabled) return false;
  return (message.search_results?.length ?? 0) === 0;
}

/** The badge's text, and the sentence behind its tooltip. */
export interface UnverifiedNotice {
  label: string;
  detail: string;
}

export function describeUnverified(): UnverifiedNotice {
  return {
    label: 'Unverified — no sources retrieved',
    detail:
      'The search ran and collected nothing, so this answer is the model alone. Nothing in it is backed by a retrieved source, and any citation in it is unverified.',
  };
}
