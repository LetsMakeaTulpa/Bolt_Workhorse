// The system prompt is behaviour, so it is asserted like behaviour: a stated answer budget, a
// claim ledger with three named verdicts, citation rules, and FOLLOW-UPS kept last so the answer
// parser still finds its trailing section.
// Run: node experiments/system-prompt.test.mjs

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// the local esbuild entry point under node directly: `npx` cannot be spawned from cmd.exe, and a
// shell would mangle quoting
const OUT = (process.env.PROMPT_MODULE ?? '/tmp/fieldwork-system-prompt.mjs').replaceAll('\\', '/');
const ESBUILD = `${process.cwd()}/node_modules/esbuild/bin/esbuild`.replaceAll('\\', '/');
execFileSync(
  process.execPath,
  [ESBUILD, 'src/lib/systemPrompt.ts', '--bundle', '--format=esm', `--outfile=${OUT}`, '--log-level=error'],
  { stdio: 'inherit' },
);

const { FIELDWORK_SYSTEM_PROMPT: prompt } = await import(`${pathToFileURL(OUT).href}?t=${Date.now()}`);
const words = prompt.trim().split(/\s+/).length;
const lines = prompt.split('\n');

check('the prompt is about 400 words', words >= 370 && words <= 440, `${words} words`);

// answer budget: a number per question shape, and a hard ceiling
check('it names a factual budget', /\b150 words for a factual lookup/.test(prompt));
check('it names an explanation budget', /\b300 words for an explanation/.test(prompt));
check('it names a survey budget', /\b500 words for a comparison or a survey/.test(prompt));
check('it caps every answer', /Never exceed 600 words/.test(prompt));
check('it forbids padding', /no summary of the summary/i.test(prompt));

// citations
check('citations use the supplied ids', /\[n\] marker using the citation IDs/.test(prompt));
check('inventing a citation is forbidden', /Never invent a number/.test(prompt));
check('a source must support its sentence', /does not support the sentence it is attached to/.test(prompt));
check('multiple support is cited together', /\[2\]\[5\]/.test(prompt));

// claim ledger
check('the ledger has its own section', /titled exactly CLAIM LEDGER/.test(prompt));
check('the ledger line format is given', /- \[n\] claim — established \| claimed \| contested/.test(prompt));
check('established is defined', /established: several independent sources agree/.test(prompt));
check('claimed is defined', /claimed: one source asserts it and nothing corroborates it/.test(prompt));
check('contested is defined', /contested: sources disagree/.test(prompt));
check('the ledger is capped', /at most six lines/.test(prompt));

// thin and empty evidence, and disagreement
check('conflicting numbers are never averaged', /Never average conflicting numbers/.test(prompt));
check('thin evidence is admitted', /stale, off-topic or empty, say so in one line/.test(prompt));
check('uncited mode is explicit', /skip the claim ledger/.test(prompt));

// structure: the answer order, and FOLLOW-UPS last so splitFollowUps still parses it
const ledgerAt = lines.findIndex((line) => /titled exactly CLAIM LEDGER/.test(line));
// the prompt names the section twice: once as an instruction, once as the template the model copies
const followAt = lines.findLastIndex((line) => /^FOLLOW-UPS$/.test(line));
check('the ledger comes before the follow-ups', ledgerAt > 0 && followAt > ledgerAt, `${ledgerAt} < ${followAt}`);
check(
  'the template ends with the follow-up bullets',
  lines.slice(followAt + 1).some((line) => /^-\s/.test(line.trim())) &&
    lines.slice(followAt + 1).every((line) => !line.trim() || /^-\s/.test(line.trim())),
  JSON.stringify(lines.slice(followAt).slice(-2)),
);
check('nothing the model is told to copy follows the bullets', lines.slice(followAt + 1).every((line) => !/follow-us|follow-ups/i.test(line)));
check('it asks for exactly three follow-ups', lines.slice(followAt + 1).filter((line) => /^-\s/.test(line.trim())).length === 3);
check('follow-ups must be searchable', /answerable by a search/.test(prompt));

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) process.exit(1);
