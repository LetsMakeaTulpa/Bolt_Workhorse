/**
 * The whole Sources list in one line: how many of the rows on screen actually reached the model.
 *
 * Every row already carries a chip, but the question this tab exists to answer — what did the
 * answer have in front of it — cannot be read off twenty of them. The counts come from the same
 * `PromptCoverage` the chips use, so the sentence can never claim something a row contradicts, and
 * a list saved before the verdict was recorded is called unknown rather than "never shown".
 */
import type { PromptCoverage } from '../types';

/** Which rows the list is showing: everything, or one coverage verdict. */
export type CoverageFilter = 'all' | 'reached' | 'left-out' | 'unrecorded';

export interface CoverageSummary {
  total: number;
  /** rows the prompt carried: given, or carried with its page text cut at the cap */
  reached: number;
  /** rows a saved answer recorded as left out */
  withheld: number;
  /** rows with no recorded verdict — saved before the prompt mark existed */
  unrecorded: number;
  /** reached, but only up to the per-source character cap */
  trimmed: number;
  /** left out because a follow-up search offers the model only its first eight sources */
  capped: number;
  /** left out because this turn built no prompt from its sources */
  noPrompt: number;
}

export function summarizeCoverage(sources: { prompt?: PromptCoverage }[]): CoverageSummary {
  const summary: CoverageSummary = {
    total: 0,
    reached: 0,
    withheld: 0,
    unrecorded: 0,
    trimmed: 0,
    capped: 0,
    noPrompt: 0,
  };
  for (const { prompt } of sources) {
    summary.total += 1;
    if (!prompt) {
      // no verdict is not a verdict: a row saved before the mark says nothing either way
      summary.unrecorded += 1;
      continue;
    }
    if (prompt.inPrompt) {
      summary.reached += 1;
      if (prompt.reason === 'trimmed') summary.trimmed += 1;
      continue;
    }
    summary.withheld += 1;
    if (prompt.reason === 'capped') summary.capped += 1;
    if (prompt.reason === 'no-prompt') summary.noPrompt += 1;
  }
  return summary;
}

const results = (n: number) => (n === 1 ? 'result' : 'results');

/**
 * The sentence above the list.
 *
 * "None reached the model" is only said when every row recorded that it was left out: a list of
 * rows saved before the verdict existed is unknown, and claiming nothing reached the model there
 * would invent an omission the record does not support. The causes that are not interchangeable —
 * text cut at the cap, a follow-up overflow, a turn with no prompt — are named separately, because
 * "left out" alone would hide which one applies.
 */
export function coverageSentence(summary: CoverageSummary): string {
  const { total, reached, withheld, unrecorded, trimmed, capped, noPrompt } = summary;
  if (total === 0) return '';

  const parts: string[] = [];
  if (reached === 0 && withheld === 0) {
    parts.push(`no verdict was recorded for these ${total} ${results(total)}, so it is unknown how many reached the model`);
  } else if (total === 1 && reached === 1) {
    parts.push('the only result reached the model');
  } else if (total === 1 && reached === 0 && unrecorded === 0) {
    parts.push('the only result did not reach the model');
  } else if (reached === total) {
    parts.push(`all ${total} ${results(total)} reached the model`);
  } else if (reached === 0 && unrecorded === 0) {
    parts.push(`none of the ${total} ${results(total)} reached the model`);
  } else {
    parts.push(`${reached} of ${total} ${results(total)} reached the model`);
  }
  if (trimmed > 0) parts.push(`${trimmed} had page text cut at the cap`);
  if (capped > 0) parts.push(`${capped} over the cap`);
  if (noPrompt > 0) parts.push(`${noPrompt} from a turn with no prompt`);
  if (unrecorded > 0) parts.push(`${unrecorded} with no recorded verdict`);

  const sentence = parts.join(' · ');
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

/** How many rows a filter would show. */
export function coverageCount(summary: CoverageSummary, filter: CoverageFilter): number {
  switch (filter) {
    case 'reached':
      return summary.reached;
    case 'left-out':
      return summary.withheld;
    case 'unrecorded':
      return summary.unrecorded;
    default:
      return summary.total;
  }
}

export function matchesCoverageFilter(source: { prompt?: PromptCoverage }, filter: CoverageFilter): boolean {
  if (filter === 'reached') return source.prompt?.inPrompt === true;
  if (filter === 'left-out') return source.prompt?.inPrompt === false;
  if (filter === 'unrecorded') return !source.prompt;
  return true;
}
