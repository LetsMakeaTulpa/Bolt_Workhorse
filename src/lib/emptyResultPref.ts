/**
 * Whether an empty search still ends in the gap-report block.
 *
 * The block is the honest default: a search that collected nothing says so, names the gaps, and
 * refuses to answer around the absence. It is also a wall between the question and the model's own
 * knowledge, and sometimes the answer is what is wanted — so it can be turned off. Kept on the
 * device rather than in the database: it changes what this screen does with a turn, not what the
 * account is, and it must be readable synchronously when the first turn runs.
 */
const KEY = 'fieldwork.empty-result-block.v1';

/** `off` means the toggle is off; anything else (including nothing stored) means on. */
export function parseEmptyResultBlock(raw: string | null | undefined): boolean {
  if (typeof raw !== 'string') return true;
  return raw.trim().toLowerCase() !== 'off';
}

/** What the toggle should say, given the stored value. */
export function describeEmptyResultBlock(enabled: boolean): string {
  return enabled
    ? 'On — an empty search ends in a gap report instead of an answer'
    : 'Off — an empty search still gets an answer from the model';
}

export function readEmptyResultBlock(): boolean {
  try {
    return parseEmptyResultBlock(typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY));
  } catch {
    // storage blocked: the honest default is the block
    return true;
  }
}

export function writeEmptyResultBlock(enabled: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, enabled ? 'on' : 'off');
  } catch {
    // a preference that cannot persist still applies to this turn
  }
}

export const EMPTY_RESULT_BLOCK_KEY = KEY;
