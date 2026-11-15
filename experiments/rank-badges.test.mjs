// The badge tells the user why a source sits where it sits, so it must agree with the multiplier
// fusion actually applied — including the case where the date played no part.
import { execFileSync } from 'node:child_process';

const OUT = '/tmp/fieldwork-rank-explain.mjs';
const FUSION = '/tmp/fieldwork-rank-fusion.mjs';
execFileSync('npx', ['--yes', 'esbuild', 'src/lib/rankExplain.ts', '--bundle', '--format=esm', `--outfile=${OUT}`, '--log-level=error'], {
  stdio: 'inherit',
});
execFileSync('npx', ['--yes', 'esbuild', 'src/lib/fusion.ts', '--bundle', '--format=esm', `--outfile=${FUSION}`, '--log-level=error'], {
  stdio: 'inherit',
});
const { summaryForQuery, freshnessBonus } = await import(`${OUT}?t=${Date.now()}`);
const { queryIntent } = await import(`${FUSION}?t=${Date.now()}`);

const NOW = Date.UTC(2026, 10, 15);
const daysAgo = (days) => new Date(NOW - days * 86_400_000).toISOString().slice(0, 10);

let passed = 0;
const failures = [];
const check = (name, condition, detail) => {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

// 1. the label says what the ranking did
check('a news query reads as recency-seeking', summaryForQuery('latest AI regulation news 2026', NOW).label === 'recency-seeking');
check('a conceptual query reads as conceptual', summaryForQuery('why do graph neural networks overfit on small graphs', NOW).label === 'conceptual');
check('a history query reads as timeless', summaryForQuery('history of the roman republic', NOW).label === 'timeless');
check('an identifier query reads as exact match', summaryForQuery('CVE-2024-3094 exploitation', NOW).label === 'exact match');
check('an ordinary query reads as mixed', summaryForQuery('postgres index bloat', NOW).label === 'mixed');

// 2. the multiplier matches the ranking rule (1 + 0.6 × recencyWeight)
const fresh = queryIntent('latest AI regulation news 2026', NOW);
check('a three-day-old result earns the full boost', Math.abs(freshnessBonus(daysAgo(3), fresh, NOW) - 1.6) < 1e-9, String(freshnessBonus(daysAgo(3), fresh, NOW)));
check('a year-old result earns a small boost', Math.abs(freshnessBonus(daysAgo(365), fresh, NOW) - 1.21) < 1e-9, String(freshnessBonus(daysAgo(365), fresh, NOW)));
check('a five-year-old result is barely lifted', freshnessBonus(daysAgo(1900), fresh, NOW) < 1.08, String(freshnessBonus(daysAgo(1900), fresh, NOW)));

// 3. no date, no story to tell
check('an undated result is neutral', freshnessBonus(undefined, fresh, NOW) === 1);
check('an unparseable date is neutral', freshnessBonus('not-a-date', fresh, NOW) === 1);

// 4. a timeless query never claims a freshness boost, even on a fresh source
const timeless = queryIntent('history of the roman republic', NOW);
check('a timeless query ignores the date', freshnessBonus(daysAgo(1), timeless, NOW) === 1);

// 5. navigational queries damp books, so recency must stay neutral too
const exact = queryIntent('CVE-2024-3094 exploitation', NOW);
check('an exact-match query ignores the date', freshnessBonus(daysAgo(1), exact, NOW) === 1);

console.log(`\n${passed}/${passed + failures.length} assertions passed`);
if (failures.length > 0) process.exit(1);
