/**
 * Grounding: does the answer actually say what its sources say?
 *
 * Two failures are worth catching, and they are different:
 *
 *  - a citation ID that does not exist. The answer cites `[7]` and there are five sources. That is
 *    not a weak claim, it is an invented one, and it is the clearest sign the model wrote from
 *    memory while wearing the clothes of a sourced answer.
 *  - a sentence whose figures or names appear nowhere in the text of the sources it cites. The
 *    sources may be real and the number may be right — but if it is not in the page, this app cannot
 *    vouch for it, and saying so is the whole anti-fabrication promise.
 *
 * What this deliberately does not do: rewrite the answer, delete the sentence, or call it a lie. It
 * marks the sentence and names what it could not find, so a reader can check the page themselves.
 * A source that came back with only a snippet makes its sentences *unchecked*, not wrong: the figure
 * may be three lines below where the snippet stopped.
 */
import type { Source } from '../types';

export type GroundingStatus =
  /** every figure and name in the sentence appears in a cited source's page text */
  | 'grounded'
  /** the sentence cites a citation ID that is not among this answer's sources */
  | 'unknown-citation'
  /** the sentence cites sources that have no extracted text, so nothing could be checked */
  | 'no-page-text'
  /** figures or names that are in no cited page, or figures with no citation at all */
  | 'unsupported'
  /** nothing to check: no citation, no figure, no name */
  | 'unchecked';

export interface SentenceGrounding {
  text: string;
  citations: string[];
  status: GroundingStatus;
  /** figures and names that could not be found in the cited text (or the unknown citation IDs) */
  missing: string[];
}

export interface GroundingReport {
  sentences: SentenceGrounding[];
  /** citation IDs used by the answer that no source provides, without brackets */
  unknownCitations: string[];
  /** sentences that assert something we could not find — the ones to mark */
  flagged: SentenceGrounding[];
  /** sentences that cite snippet-only sources, so they could not be checked either way */
  unchecked: SentenceGrounding[];
  /** sentences whose figures and names were all found */
  grounded: number;
  /** sentences that carried something checkable */
  checked: number;
  /** one line for the UI */
  summary: string;
}

/** A cited source, narrowed to what the check reads. */
type CitedSource = Pick<Source, 'citation_id' | 'title' | 'url' | 'snippet' | 'content'>;

const ID = /\[(\d{1,3})\]/g;

/** Words that start sentences or carry no claim: capitalised all the time, never a name to check. */
const NOT_A_NAME = new Set([
  'the', 'this', 'that', 'these', 'those', 'there', 'then', 'they', 'their', 'them', 'it', 'its',
  'in', 'on', 'at', 'by', 'for', 'from', 'with', 'without', 'and', 'or', 'but', 'if', 'when', 'while',
  'as', 'to', 'of', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'has', 'have', 'had', 'not',
  'however', 'also', 'note', 'notably', 'first', 'second', 'third', 'finally', 'overall', 'in short',
  'sources', 'source', 'answer', 'summary', 'evidence', 'grounding', 'citation', 'citations',
  'yes', 'no', 'ok', 'okay', 'here', 'below', 'above', 'still', 'yet', 'so', 'thus', 'therefore',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'both', 'each',
  'many', 'most', 'some', 'all', 'any', 'more', 'less', 'new', 'old', 'other', 'another', 'same',
  // months and days are dates, and dates are checked as figures when they carry a day or year
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october',
  'november', 'december', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);

/** Abbreviations whose full stop does not end a sentence. */
const NOT_A_BREAK = /(?:\b(?:e\.g|i\.e|vs|etc|fig|no|dr|mr|mrs|ms|prof|approx|ca|cf|al|ed|eds|pp|p|vol)\.)$/i;

const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

/** The prose worth checking: fenced code, tables and headings are not claims about the world. */
function checkableProse(answer: string): string {
  return String(answer ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/^\s*#{1,6}\s+.*$/gm, ' ')
    .replace(/^\s*[-*+]\s+\[[ x]\]\s+/gm, ' ');
}

/** Sentences, with the abbreviation guard so "e.g. 2024" is not two claims. */
export function splitSentences(answer: string): string[] {
  const text = checkableProse(answer);
  const parts: string[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split(/\n/).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      // split on sentence enders, but put the punctuation back
      const pieces = line.split(/(?<=[.!?])\s+/);
      for (const piece of pieces) {
        if (!piece.trim()) continue;
        const last = parts[parts.length - 1];
        if (last !== undefined && NOT_A_BREAK.test(last)) {
          parts[parts.length - 1] = `${last} ${piece}`;
        } else {
          parts.push(piece);
        }
      }
    }
  }
  return parts.map((sentence) => sentence.trim()).filter(Boolean);
}

/** Citation IDs in a sentence, without brackets, in the order they appear. */
export function citationIds(sentence: string): string[] {
  const ids: string[] = [];
  for (const match of sentence.matchAll(ID)) if (!ids.includes(match[1])) ids.push(match[1]);
  return ids;
}

/**
 * Figures in a sentence: numbers that a reader would check. Single digits are skipped — they are
 * usually list markers, ordinals or "one of the two" — and so are bare years inside a longer date.
 */
export function figures(sentence: string): string[] {
  const found: string[] = [];
  // the unit branch has no trailing \b: after "%" the next character is punctuation or space, so a
  // word boundary there never matches and "47%" would be read as the bare number "47"
  const pattern = /(?:[$€£]\s?\d[\d.,]*|\b\d[\d.,]*\s?(?:%|percent|‰|bn|billion|million|trillion|k|ms|gb|mb|tb|kg|km|mi|°c|°f)|\b\d[\d.,]*\b)/gi;
  for (const match of sentence.matchAll(pattern)) {
    const raw = match[0].trim();
    const digits = raw.replace(/\D/g, '');
    const hasUnit = /[%‰a-z$€£]/i.test(raw);
    if (digits.length >= 2 || hasUnit) found.push(raw);
  }
  return [...new Set(found)];
}

/**
 * Names in a sentence: capitalised sequences that are not the first word and not everyday words.
 * Anything the question already mentioned is skipped — an answer repeating the question's subject is
 * not a new claim.
 */
export function names(sentence: string, question = ''): string[] {
  const asked = normalize(question);
  const words = sentence.replace(ID, ' ').split(/\s+/).filter(Boolean);
  const found: string[] = [];
  // the token index is carried along, because a sequence's position decides whether its capital is
  // the start of a sentence; comparing cleaned tokens back against the raw ones missed "Results,"
  let current: { text: string; index: number }[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const phrase = current.map((token) => token.text).join(' ');
    const startsSentence = current[0].index === 0;
    const single = current.length === 1;
    const key = normalize(phrase);
    current = [];
    if (key.length < 3 || NOT_A_NAME.has(key)) return;
    if (single && startsSentence) return;
    // an all-caps acronym is specific enough to check; a plain capitalised word needs 4+ letters
    const isAcronym = /^[A-Z][A-Z0-9]+$/.test(phrase);
    if (single && !isAcronym && phrase.length < 4) return;
    if (asked && asked.includes(key)) return;
    found.push(phrase);
  };

  words.forEach((word, index) => {
    const clean = word.replace(/^[("'“\[*]+/, '').replace(/[)"'”\]*,.;:!?]+$/, '');
    if (index > 0 && /^[A-Z][\w'’-]*/.test(clean)) current.push({ text: clean, index });
    else flush();
  });
  flush();
  return [...new Set(found)];
}

/** Whether a figure appears in the text, allowing the usual ways of writing the same number. */
function figurePresent(figure: string, haystack: string): boolean {
  const plain = figure.replace(/[$€£,\s]/g, '').toLowerCase();
  const padded = ` ${haystack} `;
  if (padded.includes(` ${normalize(figure)} `) || padded.includes(` ${normalize(figure)}`)) return true;
  if (plain && haystack.replace(/[$€£,\s]/g, '').includes(plain)) return true;
  return false;
}

const namePresent = (name: string, haystack: string): boolean => haystack.includes(normalize(name));

function pageTextOf(sources: CitedSource[]): string {
  return sources.map((source) => normalize(source.content ?? '')).filter(Boolean).join(' ');
}

function hasPageText(source: CitedSource): boolean {
  return normalize(source.content ?? '').length > 0;
}

/**
 * Check one answer against the sources stored with it.
 *
 * `question` is optional and only used to exempt names the user themselves supplied.
 */
export function checkGrounding(answer: string, sources: CitedSource[], question = ''): GroundingReport {
  const byId = new Map<string, CitedSource>();
  sources.forEach((source, index) => {
    const id = String(source.citation_id ?? `[${index + 1}]`).replace(/[[\]]/g, '').trim();
    if (id) byId.set(id, source);
  });

  const unknown = new Set<string>();
  const sentences: SentenceGrounding[] = [];

  for (const text of splitSentences(answer)) {
    const ids = citationIds(text);
    const figuresInText = figures(text);
    const namesInText = names(text, question);
    const claims = [...figuresInText, ...namesInText];

    if (ids.length === 0) {
      // a figure with no citation is the model asserting something it never sourced
      sentences.push({
        text,
        citations: [],
        status: claims.length > 0 ? 'unsupported' : 'unchecked',
        missing: claims,
      });
      continue;
    }

    const cited = ids.map((id) => byId.get(id)).filter((source): source is CitedSource => Boolean(source));
    const missingIds = ids.filter((id) => !byId.has(id));
    missingIds.forEach((id) => unknown.add(id));

    if (missingIds.length > 0) {
      sentences.push({ text, citations: ids, status: 'unknown-citation', missing: missingIds.map((id) => `[${id}]`) });
      continue;
    }

    if (claims.length === 0) {
      sentences.push({ text, citations: ids, status: 'unchecked', missing: [] });
      continue;
    }

    const pages = cited.filter(hasPageText);
    if (pages.length === 0) {
      sentences.push({ text, citations: ids, status: 'no-page-text', missing: [] });
      continue;
    }

    const haystack = pageTextOf(pages);
    const missing = [
      ...figuresInText.filter((figure) => !figurePresent(figure, haystack)),
      ...namesInText.filter((name) => !namePresent(name, haystack)),
    ];
    sentences.push({ text, citations: ids, status: missing.length > 0 ? 'unsupported' : 'grounded', missing });
  }

  const flagged = sentences.filter((sentence) => sentence.status === 'unsupported' || sentence.status === 'unknown-citation');
  const unchecked = sentences.filter((sentence) => sentence.status === 'no-page-text');
  const grounded = sentences.filter((sentence) => sentence.status === 'grounded').length;
  const checked = sentences.filter((sentence) => sentence.status !== 'unchecked').length;

  return {
    sentences,
    unknownCitations: [...unknown],
    flagged,
    unchecked,
    grounded,
    checked,
    summary: summarize({ flagged, unchecked, grounded, checked, unknown: [...unknown] }),
  };
}

function summarize({
  flagged,
  unchecked,
  grounded,
  checked,
  unknown,
}: {
  flagged: SentenceGrounding[];
  unchecked: SentenceGrounding[];
  grounded: number;
  checked: number;
  unknown: string[];
}): string {
  if (checked === 0) return '';
  const parts: string[] = [];
  if (unknown.length > 0) {
    parts.push(`${unknown.length} citation${unknown.length === 1 ? '' : 's'} that no source provides (${unknown.map((id) => `[${id}]`).join(', ')})`);
  }
  const unsupported = flagged.filter((sentence) => sentence.status === 'unsupported').length;
  if (unsupported > 0) {
    parts.push(`${unsupported} sentence${unsupported === 1 ? '' : 's'} with figures or names not found in the cited pages`);
  }
  if (unchecked.length > 0) {
    parts.push(`${unchecked.length} could not be checked (the cited source has only a snippet)`);
  }
  if (parts.length === 0) {
    return grounded === 1
      ? 'All 1 checked sentence matches its source'
      : `All ${grounded} checked sentences match their sources`;
  }
  return parts.join(' · ');
}
