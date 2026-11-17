/**
 * The bottom line of an answer, turned into the two things a post can offer.
 *
 * The prompt's answer shape starts with 2-4 sentences saying what the sources collectively show —
 * that lead is both the most searchable sentence in the post and the one part a model always writes.
 * The trailing FOLLOW-UPS section is the opposite: asked for, and often missing, which leaves a post
 * with nothing to press. So the lead becomes a query, and follow-up questions are derived from it
 * when the model supplied none.
 *
 * Everything here is taken from the answer's own words: the query is the lead's distinctive terms,
 * and each question is a fixed frame around those terms. Nothing is generated, so nothing can be
 * invented — the worst case is a dull query, never a citation or a fact that was not already there.
 */

export interface Bluf {
  /** the lead sentences, citations and markdown stripped */
  lead: string;
  /** the lead as a search query; empty when it has nothing distinctive enough to search */
  query: string;
  /** searchable next questions, derived from the query's terms */
  followUps: string[];
}

/** Citation markers, links, and the markdown decoration a model puts around a lead. */
const CITATION = /\[(?:\d{1,3}|[a-z])\]/gi;
const LINK = /\[([^\]]*)\]\([^)]*\)/g;
const DECORATION = /[*_`~#>]+/g;
const BULLET = /^(?:[-*•]|\d+[.)])\s+/;
const HEADING = /^#{1,6}\s+/;
const TABLE_RULE = /^\|?\s*:?-{2,}/;
const WORD = /[A-Za-z][A-Za-z0-9'’-]*|\d+(?:[.,]\d+)?%?/g;

/**
 * Words that say nothing about a subject, plus the vocabulary every answer opens with ("the sources
 * suggest", "the evidence indicates"). Keeping the second group out matters more than it looks: an
 * answer whose lead is entirely meta-vocabulary has no query in it, and saying so beats handing back
 * a chip that searches for "sources suggest".
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
    'disagree disagrees disagreed see seen look looks showing'
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
  const sentences = clean.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) ?? [];
  return sentences.slice(0, 3).join(' ').replace(/\s+/g, ' ').trim();
}

/** The distinctive terms of the lead, in the order the answer wrote them. */
export function blufTerms(lead: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const match of lead.match(WORD) ?? []) {
    const word = match.toLowerCase().replace(/[.'’-]+$/, '');
    if (word.length < 2 && !/\d/.test(word)) continue;
    if (STOP.has(word) || META.has(word)) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    terms.push(word);
    if (terms.length === 8) break;
  }
  return terms;
}

/** A lead as a search query: its terms, nothing else — no operators, so nothing can restrict it. */
export function blufOf(prose: string): Bluf {
  const lead = leadOf(prose);
  const terms = blufTerms(lead);
  if (terms.length < 2) return { lead, query: '', followUps: [] };

  const query = terms.join(' ');
  const topic = terms.slice(0, 6).join(' ');
  return {
    lead,
    query,
    followUps: [
      `What is the strongest primary source on ${topic}?`,
      `What evidence contradicts ${topic}?`,
      `What changed about ${topic} in the past year?`,
    ],
  };
}
