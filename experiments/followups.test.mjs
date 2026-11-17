// The follow-up section is stripped from the rendered answer, so a parser bug either loses real
// prose or leaks machinery into the bubble. Both are checked here.
import { asUrl, tmpPath, ESBUILD } from './lib/build.mjs';
import { execFileSync } from 'node:child_process';

const OUT = tmpPath('fieldwork-followups.mjs');
execFileSync(process.execPath, [ESBUILD, 'src/lib/followUps.ts', '--bundle', '--format=esm', `--outfile=${OUT}`, '--log-level=error'], {
  stdio: 'inherit',
});
const { splitFollowUps } = await import(`${asUrl(OUT)}?t=${Date.now()}`);

const BLUF = tmpPath('fieldwork-bluf.mjs');
execFileSync(process.execPath, [ESBUILD, 'src/lib/blufQuery.ts', '--bundle', '--format=esm', `--outfile=${BLUF}`, '--log-level=error'], {
  stdio: 'inherit',
});
const { blufOf, sameQuery } = await import(`${asUrl(BLUF)}?t=${Date.now()}`);

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// 1. the shape the prompt asks for
const plain = splitFollowUps(
  'The sources agree [1]. One dissents [2].\n\nFOLLOW-UPS\n- What did the second source measure?\n- Who funded the retraction?\n- Is there a later dataset?',
);
check('splits the heading off the body', plain.body === 'The sources agree [1]. One dissents [2].', JSON.stringify(plain.body));
check('keeps three questions', plain.followUps.length === 3, String(plain.followUps.length));
check('strips the bullet marker', plain.followUps[0] === 'What did the second source measure?', plain.followUps[0]);

// 2. models decorate headings and bullets
const decorated = splitFollowUps('Answer.\n\n**FOLLOW-UPS**\n* **Why now?**\n* What changed?\n* Who benefits?');
check('accepts a bold heading and bold questions', decorated.followUps[0] === 'Why now?', decorated.followUps[0]);
check('accepts asterisk bullets', decorated.followUps.length === 3, String(decorated.followUps.length));

// 3. numbered lists happen too
const numbered = splitFollowUps('Answer.\n\nFollow ups:\n1. First?\n2) Second?');
check('accepts a numbered list', numbered.followUps.join('|') === 'First?|Second?', numbered.followUps.join('|'));

// 4. no heading means no stripping
const none = splitFollowUps('A plain answer with no section at all.');
check('leaves an answer without a section untouched', none.body === 'A plain answer with no section at all.' && none.followUps.length === 0);

// 5. prose that merely mentions follow-ups must survive
const prose = splitFollowUps('Good follow-ups would be hard here.\n\nBut the sources are thin.');
check('does not treat prose about follow-ups as a section', prose.body.includes('Good follow-ups') && prose.followUps.length === 0);

// 6. a heading followed by prose is not a question list
const proseTail = splitFollowUps('Answer.\n\nFOLLOW-UPS\nThese are worth considering but the sources do not support them yet.');
check('refuses to strip a section that is prose, not bullets', proseTail.body.includes('worth considering') && proseTail.followUps.length === 0);

// 7. cap keeps the bubble readable
const many = splitFollowUps(
  `Answer.\n\nFOLLOW-UPS\n- a?\n- b?\n- c?\n- d?\n- e?`,
);
check('caps the chip count at four', many.followUps.length === 4, String(many.followUps.length));

// 8. trailing whitespace never reaches the rendered markdown
const trailing = splitFollowUps('Answer.   \n\n\nFOLLOW-UPS\n- a?\n- b?\n- c?\n\n');
check('trims the body', trailing.body === 'Answer.', JSON.stringify(trailing.body));
check('ignores blank lines after the bullets', trailing.followUps.length === 3, String(trailing.followUps.length));

// 9. an empty answer must not throw
const empty = splitFollowUps('');
check('handles an empty answer', empty.body === '' && empty.followUps.length === 0);

// ── 10. the bottom line, as the query a post can offer ──────────────────────────────────────
const lede = blufOf(
  '**Surface code thresholds above 1% error are the binding constraint [1][2].** A second source disagrees about the margin [3].\n\nDetail that is not the bottom line: the 2025 roadmap slipped.',
);
check('bluf: markdown and citations are stripped', lede.lead.startsWith('Surface code thresholds above 1% error') && !/\[\d/.test(lede.lead), lede.lead);
check('bluf: the detail section is not the bottom line', !/roadmap slipped/.test(lede.lead), lede.lead);
check('bluf: at most three sentences', (lede.lead.match(/[.!?]/g) ?? []).length <= 3, lede.lead);
check('bluf: the query is the lead’s subject phrase, in order', lede.query === 'surface code thresholds', lede.query);
check('bluf: the rest of the sentence is not appended to it', !/binding|constraint|above/.test(lede.query), lede.query);
const dated = blufOf('The 2025 roadmap slipped again.');
check('bluf: a number inside the subject survives', /2025/.test(dated.query), dated.query);
check(
  'bluf: stopwords and answer vocabulary are gone',
  !/\b(?:the|above|are|source|sources|disagrees|detail)\b/.test(lede.query),
  lede.query,
);
check('bluf: the query is plain — no operators, no quotes', !/[:"“”]|\bsite:/.test(lede.query), lede.query);
check('bluf: the query stays short enough to be a query', lede.query.split(' ').length <= 5, lede.query);

// a link contributes its words, never its URL
const linked = blufOf('See [the 2025 roadmap](https://example.org/private/roadmap.pdf). It slipped again.');
check('bluf: a link leaves its text, not its address', /2025 roadmap/.test(linked.lead) && !/https?:|example\.org/.test(linked.query), linked.query);

// an answer made entirely of answer vocabulary has no query in it, and says so instead of guessing
const metaOnly = blufOf('The sources agree on one point. The evidence suggests it is important.');
check('bluf: nothing distinctive means no query', metaOnly.query === '', metaOnly.query);
check('bluf: and therefore no invented questions', metaOnly.followUps.length === 0, String(metaOnly.followUps.length));
check('bluf: an empty answer is handled', blufOf('').query === '' && blufOf('').followUps.length === 0);

// the live failure this replaced: every word true, no subject, and a chip nobody would press —
// "provided search identify original introduced reciprocal rank fusion"
const aboutTheSearch = blufOf(
  'The provided search results do not identify the original paper that introduced Reciprocal Rank Fusion (RRF) or specify the standard $k$ constant used [1][2]. Based on general knowledge, RRF was introduced by Cormack, gosta, and Clarke in their 2009 paper "Reciprocal Rank Fusion algorithm."',
);
check('bluf: the query is the lead’s subject, not every distinctive word', aboutTheSearch.query === 'reciprocal rank fusion', aboutTheSearch.query);
check('bluf: an acronym that repeats the phrase is dropped', !/\brrf\b/.test(aboutTheSearch.query), aboutTheSearch.query);
check(
  'bluf: the derived questions are about that subject',
  aboutTheSearch.followUps.length === 3 && aboutTheSearch.followUps.every((q) => /reciprocal rank fusion/.test(q)),
  aboutTheSearch.followUps.join(' | '),
);

// a bag of two words is not a subject: the words have to be adjacent to count
const scattered = blufOf('The results were provided, identify what changed and specify the standard.');
check('bluf: scattered words are not a subject', scattered.subject === '' && scattered.query === '', scattered.query);
check('bluf: and a lead without a subject gets no derived questions', scattered.followUps.length === 0, String(scattered.followUps.length));

// adjacent is not enough to be a subject: "costs fell" is a sentence fragment, and three questions
// built on it are the stock questions this gate exists to stop
const thin = blufOf('Costs fell.');
check('bluf: a thin subject still keeps its query', thin.query === 'costs fell', thin.query);
check('bluf: a thin subject earns no derived questions', thin.followUps.length === 0, String(thin.followUps.length));
// the bottom line is often the first sentence, but an opening that only says what the sources fail
// to settle must not cost the post its subject when the next sentence names it
const later = blufOf('The sources do not settle it [1]. Surface code thresholds are the binding constraint.');
check('bluf: a subject in a later lead sentence is still found', later.subject === 'surface code thresholds', later.subject);

// one search under two labels is one search
check('sameQuery: case, spacing and punctuation are not a new query', sameQuery('Reciprocal Rank Fusion', 'reciprocal  rank-fusion'));
check('sameQuery: a wider query is a different query', !sameQuery('reciprocal rank fusion 2009', 'reciprocal rank fusion'));
check('sameQuery: an empty query matches nothing', !sameQuery('', ''));

// ── 11. the questions a post ends with when the model wrote none ──
check('bluf: three next questions', lede.followUps.length === 3, String(lede.followUps.length));
check('bluf: each one is a question', lede.followUps.every((q) => q.trim().endsWith('?')), lede.followUps.join(' | '));
check('bluf: each one carries the lead’s subject', lede.followUps.every((q) => /surface code/.test(q)), lede.followUps.join(' | '));

// the frames are fixed, so a derived question cannot introduce a fact the answer never carried
const frame = new Set('what is the strongest primary source on evidence contradicts changed about in past year'.split(' '));
const subject = new Set(lede.subject.split(' '));
check(
  'bluf: a derived question adds no words of its own',
  lede.followUps.every((q) => q.toLowerCase().match(/[a-z0-9%]+/g).every((word) => frame.has(word) || subject.has(word))),
  lede.followUps.join(' | '),
);

console.log(`\n${passed}/${passed + failures.length} assertions passed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exit(1);
}
