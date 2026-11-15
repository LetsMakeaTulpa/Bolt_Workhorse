// The follow-up section is stripped from the rendered answer, so a parser bug either loses real
// prose or leaks machinery into the bubble. Both are checked here.
import { execFileSync } from 'node:child_process';

const OUT = '/tmp/fieldwork-followups.mjs';
execFileSync('npx', ['--yes', 'esbuild', 'src/lib/followUps.ts', '--bundle', '--format=esm', `--outfile=${OUT}`, '--log-level=error'], {
  stdio: 'inherit',
});
const { splitFollowUps } = await import(`${OUT}?t=${Date.now()}`);

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

console.log(`\n${passed}/${passed + failures.length} assertions passed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exit(1);
}
