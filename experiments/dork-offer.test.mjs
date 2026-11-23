// The dork an answer writes out is offered back to the reader: a code span that carries an operator
// is a query they can copy or send, and prose that only names the operator is not. A fenced block of
// unrelated code must not become a search button either.
// Run: node experiments/dork-offer.test.mjs (builds the module itself)
import { asUrl, bundle, tmpPath } from './lib/build.mjs';

const MODULE = process.env.DORK_OFFER_MODULE ?? tmpPath('dork-offer.mjs');
if (!process.env.DORK_OFFER_MODULE) bundle('src/lib/dorkOffer.ts', MODULE);
const { offeredDorks } = await import(asUrl(MODULE));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// 1. the dork a model writes to be run
{
  const answer = [
    'The first pass was thin. Try this instead:',
    '',
    '```',
    'site:example.org (ext:env OR ext:ini) -site:blog.example.org',
    '```',
  ].join('\n');
  const dorks = offeredDorks(answer);
  check(
    'a fenced dork is offered exactly as written',
    dorks.length === 1 && dorks[0] === 'site:example.org (ext:env OR ext:ini) -site:blog.example.org',
    JSON.stringify(dorks),
  );
}

// 2. an inline span is a dork too, and the backticks do not travel with it
{
  const dorks = offeredDorks('Retry with `intitle:"index of" backup` and see what comes back.');
  check('an inline dork is offered without its backticks', dorks.length === 1 && dorks[0] === 'intitle:"index of" backup', JSON.stringify(dorks));
}

// 3. a language tag on the fence is a fence detail, not a query
{
  const dorks = offeredDorks('```text\nsite:example.org filetype:pdf\n```');
  check('a tagged fence still yields the query on its own line', dorks.length === 1 && dorks[0] === 'site:example.org filetype:pdf', JSON.stringify(dorks));
}

// 4. prose is prose
{
  const dorks = offeredDorks('The site: operator limits results to one domain, so site:example.org works.');
  check('an operator named in prose is not offered', dorks.length === 0, JSON.stringify(dorks));
}

// 5. code is code
{
  const answer = '```js\nconst greeting = "hello world";\nconst label = `total ${count}`;\n```';
  const dorks = offeredDorks(answer);
  check('a fenced block of ordinary code offers nothing', dorks.length === 0, JSON.stringify(dorks));
}

// 6. one button per query, even when the answer says it twice
{
  const dorks = offeredDorks('`site:a.test ext:log`\n\nand again: `SITE:a.test EXT:log` is the same search');
  check('the same query is offered once, case-insensitively', dorks.length === 1, JSON.stringify(dorks));
}

// 7. a stack of dorks does not become a wall of buttons
{
  const answer = ['```', 'site:a.test ext:log', 'site:b.test ext:env', 'site:c.test ext:sql', 'site:d.test ext:bak', '```'].join('\n');
  const dorks = offeredDorks(answer);
  check('the offer is capped at three', dorks.length === 3, JSON.stringify(dorks));
}

// 8. a prompt marker is not part of the query
{
  const dorks = offeredDorks('```\n$ site:example.org filetype:xls\n```');
  check('a shell prompt prefix is stripped', dorks.length === 1 && dorks[0] === 'site:example.org filetype:xls', JSON.stringify(dorks));
}

// 9. a script is not a query
{
  const long = `site:example.org ${'x'.repeat(400)}`;
  const dorks = offeredDorks(`\`${long}\``);
  check('a line too long to be a query is skipped', dorks.length === 0, JSON.stringify(dorks));
}

const failures = results.filter((row) => !row.ok);
console.log(`\n${results.length - failures.length}/${results.length} assertions passed`);
if (failures.length) process.exit(1);
