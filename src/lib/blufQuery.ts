/**
 * The bottom line of an answer, turned into the two things a post can offer.
 *
 * The prompt's answer shape starts with 2-4 sentences saying what the sources collectively show —
 * that lead is both the most searchable passage in the post and the one part a model always writes.
 * The trailing FOLLOW-UPS section is the opposite: asked for, and often missing, which leaves a post
 * with nothing to press. So the lead's subject becomes a query, and follow-up questions are derived
 * from it when the model supplied none.
 *
 * The subject is a **phrase, not a bag of words**. Taking every distinctive word in order produced
 * queries like "provided search identify original introduced reciprocal rank fusion": eight true
 * words, no subject, and a chip nobody would press. The subject is now the longest run of adjacent
 * content words inside the lead's first sentence, with an acronym that merely repeats the phrase
 * ("Reciprocal Rank Fusion (RRF)") dropped. When the lead has no such run — only scattered words, or
 * nothing but the vocabulary of answering — there is no subject, so there is no query and no derived
 * question. A missing chip is honest; a chip that searches for "sources suggest" is not.
 *
 * Everything here is taken from the answer's own words: the query is a phrase from the lead, and
 * each question is a fixed frame around it. Nothing is generated, so nothing can be invented — the
 * worst case is a dull query, never a citation or a fact that was not already there. Which frame is
 * asked is not fixed, though: `framesFor` reads the dates and the claim ledger the post already
 * carries, so the questions cannot argue with the freshness receipt printed beside them.
 */

export interface Bluf {
  /** the lead sentences, citations and markdown stripped */
  lead: string;
  /** the one phrase the lead is about, as a search query; empty when it has no such phrase */
  query: string;
  /** searchable next questions, derived from a substantive phrase and the answer's own state */
  followUps: string[];
}

/**
 * What the answer already knows about its own evidence, so the questions can meet it where it is.
 *
 * All of it is read from the post: the date window of the pages the prompt carried, and the
 * verdicts the model's own claim ledger gave them. Absent fields mean "nothing known", and the
 * frames then fall back to the neutral default.
 */
export interface AnswerSignals {
  /** newest publication date among the pages the prompt carried, `YYYY-MM-DD` */
  newest?: string | null;
  /** age of that page in whole months; null when nothing is dated */
  newestAgeMonths?: number | null;
  /** how many of those pages carry a date, and how many do not */
  dated?: number;
  undated?: number;
  /** the ledger marks at least one claim contested */
  contested?: boolean;
  /**
   * The citations on those contested rows, without brackets, in ledger order. A bare boolean can
   * only say "something is disputed", so every derived question had to ask about the subject again;
   * the markers are what let one of them point at the rows that disagree.
   */
  contestedSources?: string[];
  /**
   * Figures or names the grounding audit could not find in any cited page, in answer order. The
   * answer asserted them and its own sources do not carry them, so the useful next question is the
   * page that does — a state a post can be in with no claim ledger at all.
   */
  unverified?: string[];
}

/** Citation markers, links, and the markdown decoration a model puts around a lead. */
const CITATION = /\[(?:\d{1,3}|[a-z])\]/gi;
const LINK = /\[([^\]]*)\]\([^)]*\)/g;
const DECORATION = /[*_`~#>]+/g;
const BULLET = /^(?:[-*•]|\d+[.)])\s+/;
const HEADING = /^#{1,6}\s+/;
const TABLE_RULE = /^\|?\s*:?-{2,}/;
const WORD = /[A-Za-z][A-Za-z0-9'’-]*|\d+(?:[.,]\d+)?%?/g;
const SENTENCE = /[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g;

/**
 * Words that say nothing about a subject, plus the vocabulary every answer opens with ("the sources
 * suggest", "the evidence indicates"). Keeping the second group out matters more than it looks: an
 * answer whose lead is entirely meta-vocabulary has no subject in it, and saying so beats handing
 * back a chip that searches for the vocabulary of answering.
 */
const STOP = new Set(
  (
    'a an the and or but if then than that this these those it its is are was were be been being ' +
    'has have had do does did of in on at to for from by with without about into over under as so ' +
    'both each other others some any all more most less least not no nor only also however while ' +
    'when where which who whom whose what why how there here they them their we our you your i he ' +
    'she his her one two three first second third new now still just very much many such same own ' +
    'up out off again further once per via vs versus can could may might must shall should will ' +
    'would across between during through within among against toward towards upon above below ' +
    'beyond near around since until after before because therefore thus hence although though ' +
    'whether'
  ).split(' '),
);

const META = new Set(
  (
    'source sources evidence data datum answer answers report reports show shows shown suggest suggests ' +
    'suggested indicate indicates indicated according claim claims state states stated found find finds ' +
    'note notes noted say says said agree agrees agreed argue argues argued point points matter matters ' +
    'study studies paper papers research researchers author authors article articles piece pieces work ' +
    'works finding findings result results observation observations collectively overall seem seems ' +
    'appear appears clear unclear strong strongest important key main primary recent last year years ' +
    'time times thing things something nothing need needs remain remains include includes including ' +
    'based use uses used using make makes made take takes took get gets give gives put puts help helps ' +
    'measure measures measured test tests tested compare compared describe describes mention mentions ' +
    'become becomes became continue continues continued likely probably roughly nearly almost ' +
    'disagree disagrees disagreed see seen look looks showing ' +
    // how a model talks about the search it was given, rather than about the subject: without these,
    // "The provided search results do not identify the original paper that introduced X" hands back
    // "provided search identify original introduced x"
    'provide provides provided given retrieve retrieves retrieved identify identifies identified ' +
    'introduce introduces introduced introducing specify specifies specified standard original ' +
    'typically usually commonly generally widely accepted known definition definitions define defines ' +
    'defined knowledge general citing cite cites cited search searched searching query queries ' +
    'question questions prompt context below following above-mentioned aforementioned ' +
    'summary summarise summarises summarize summarizes'
  ).split(' '),
);

/** The lead, assembled from the lines before the first blank line or heading. */
function leadOf(prose: string): string {
  const kept: string[] = [];
  for (const raw of prose.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      if (kept.length > 0) break;
      continue;
    }
    if (HEADING.test(line) || TABLE_RULE.test(line)) {
      if (kept.length > 0) break;
      continue;
    }
    kept.push(line.replace(BULLET, ''));
    if (kept.join(' ').length > 400) break;
  }

  const clean = kept
    .join(' ')
    .replace(LINK, '$1')
    .replace(CITATION, ' ')
    .replace(DECORATION, ' ')
    .replace(BULLET, '')
    .replace(/\s+/g, ' ')
    .trim();

  // three sentences is what the prompt asks a lead to be; more than that is the detail section
  const sentences = clean.match(SENTENCE) ?? [];
  return sentences.slice(0, 3).join(' ').replace(/\s+/g, ' ').trim();
}

const bare = (token: string) => token.toLowerCase().replace(/[.'’-]+$/, '');

/** A word that carries subject matter: not grammar, not the vocabulary of answering. */
function isContent(word: string): boolean {
  return !STOP.has(word) && !META.has(word) && word.length >= 2;
}

interface Subject {
  phrase: string;
  /** the phrase names something specific: a proper noun, an identifier, a date, or a long term */
  substantive: boolean;
}

/**
 * The phrase a lead is about, and whether it is worth hanging three questions on.
 *
 * The longest run of adjacent content words in one sentence of the lead, capped at five words, and
 * taken from the first sentence that has one. Adjacency is the whole point: it is what separates
 * "reciprocal rank fusion" from the eight scattered words that produced the old query. A trailing
 * acronym that only repeats the run is dropped, so "Reciprocal Rank Fusion (RRF)" does not become
 * "reciprocal rank fusion rrf".
 *
 * Adjacency alone is still too generous: "costs fell" is an adjacent pair and not a subject, and a
 * derived question built on it is the generic question this feature is supposed to avoid. So the
 * phrase earns three questions only when it carries one of three cheap, positive signals that the
 * words denote something in particular: a name (a capitalised word inside the run), a number, or a
 * term long enough to be technical rather than grammatical. All three are load-bearing — the length
 * clause is what keeps the module's best case, a lowercase technical phrase like "surface code
 * thresholds", from losing its questions — and none needs a dictionary or a model call, which is
 * the point. A phrase with none of the three is still searched as a query; it simply does not earn
 * three questions.
 */
function subjectOf(lead: string): Subject {
  // the lead opens with the bottom line, so its first sentence wins whenever it has a subject at
  // all; an answer that opens with "the sources do not settle this" still gets one from the next
  let thin: Subject | null = null;
  for (const sentence of lead.match(SENTENCE) ?? [lead]) {
    const found = subjectIn(sentence);
    if (!found.phrase) continue;
    if (found.substantive) return found;
    thin ??= found;
  }
  return thin ?? { phrase: '', substantive: false };
}

/** The longest run of adjacent content words in one sentence. */
function subjectIn(sentence: string): Subject {
  let best: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length > best.length) best = run;
    run = [];
  };
  // adjacency is decided on the sentence's own word order, so a run has to be rebuilt from every
  // token — a filtered list would join words that were never next to each other
  for (const token of sentence.match(WORD) ?? []) {
    if (isContent(bare(token))) run.push(token);
    else flush();
  }
  flush();

  let phrase = best;
  const last = phrase[phrase.length - 1] ?? '';
  if (phrase.length > 2 && /^[A-Z]{2,6}$/.test(last)) {
    const initials = phrase.slice(0, -1).map((token) => token[0].toLowerCase()).join('');
    if (initials === last.toLowerCase()) phrase = phrase.slice(0, -1);
  }

  phrase = phrase.slice(0, 5);
  const words = phrase.map(bare);
  // two words in one phrase is a subject ("surface code"); two words apart is a bag
  if (words.length < 2) return { phrase: '', substantive: false };

  // the first token of a sentence is capitalised by grammar, not by being a name
  const named = phrase.slice(1).some((token) => /^[A-Z]/.test(token));
  return {
    phrase: words.join(' '),
    substantive:
      named || words.some((word) => /\d/.test(word) || word.replace(/[^a-z0-9]/g, '').length >= 6),
  };
}

/**
 * Three questions about the subject, chosen from what the answer already says about itself.
 *
 * The frames are still fixed text — nothing here can invent a fact — but a fixed *set* of frames
 * produced a row that argued with the strip above it: a window whose newest page was seven years
 * old still asked "what changed in the past year", and a ledger that already marked a claim
 * contested was asked whether contrary evidence exists, which is the one thing the answer had just
 * said. So the time question names the newest date it actually has, an undated answer asks for
 * dates instead of pretending to have them, and a contested ledger asks which of the rows that
 * disagree settles it — naming their markers, so the chip points at evidence rather than repeating
 * the subject. A figure the grounding audit could not find in any cited page outranks both: the
 * question it earns is for the page that carries it. A page older than a year is old enough that
 * "the past year" is a claim about the wrong window.
 */
function framesFor(phrase: string, signals: AnswerSignals): string[] {
  const dated = signals.dated ?? 0;
  const undated = signals.undated ?? 0;
  // the ledger's own citation markers, cleaned and capped: they are what make the first question
  // point at the disagreeing rows instead of restating the subject a third time
  const disputed = [
    ...new Set(
      (signals.contestedSources ?? [])
        .map((id) => String(id).replace(/[^0-9a-z]/gi, ''))
        .filter(Boolean),
    ),
  ]
    .slice(0, 3)
    .map((id) => `[${id}]`);
  const settled = disputed.length > 1
    ? `Which source settles ${phrase}: ${disputed.slice(0, -1).join(', ')} or ${disputed[disputed.length - 1]}?`
    : disputed.length === 1
      ? `Does ${disputed[0]} settle ${phrase}?`
      : `Which source settles ${phrase}?`;
  // the figures the answer could not source, named in the question that asks for their page
  const unbacked = [...new Set((signals.unverified ?? []).map((token) => String(token).trim()).filter(Boolean))]
    .slice(0, 3);
  const carries = unbacked.length
    ? `Which page carries ${unbacked.length === 1
        ? unbacked[0]
        : `${unbacked.slice(0, -1).join(', ')} and ${unbacked[unbacked.length - 1]}`} on ${phrase}?`
    : null;
  const questions = [
    carries ?? (signals.contested ? settled : `What is the strongest primary source on ${phrase}?`),
    signals.contested
      ? `What would resolve the disagreement about ${phrase}?`
      : `What evidence contradicts ${phrase}?`,
  ];
  if (dated === 0 && undated > 0) questions.push(`Which sources date ${phrase}?`);
  else if (dated > 0 && signals.newest && (signals.newestAgeMonths ?? 0) >= 12) {
    questions.push(`What has changed about ${phrase} since ${signals.newest}?`);
  } else questions.push(`What changed about ${phrase} in the past year?`);
  return questions;
}

/** A lead as the two things a post can offer: its subject as a query, and questions about it. */
export function blufOf(prose: string, signals: AnswerSignals = {}): Bluf {
  const lead = leadOf(prose);
  const { phrase, substantive } = subjectOf(lead);
  if (!phrase) return { lead, query: '', followUps: [] };

  return {
    lead,
    query: phrase,
    // one thin subject would otherwise produce the same three stock questions under every post
    followUps: substantive ? framesFor(phrase, signals) : [],
  };
}
