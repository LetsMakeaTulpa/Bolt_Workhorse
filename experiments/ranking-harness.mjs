#!/usr/bin/env node
// Ranking quality harness: runs a fixed query set through fusion twice — once with the previous
// weighting (flat engine trust, no recency) and once with the current intent-weighted scheme —
// and reports nDCG@10, MRR, P@5 and recall@10 against graded relevance judgements.
//
//   node experiments/ranking-harness.mjs
//   node experiments/ranking-harness.mjs --verbose
//   node experiments/ranking-harness.mjs --check      # exit 1 on an overall regression
//   node experiments/ranking-harness.mjs --fixture path/to/queries.json
//
// The fixture is deliberately offline: judgments come with the query set, so a weight change can
// be scored in a second, on every commit, with no API keys and no network.
//
// The query set is contested on purpose. A set where every engine's top hit is on-topic scores
// identically under any weighting, which looks like "no regression" but measures nothing: each
// contested query pairs two results with near-identical term coverage so only engine trust or a
// publication date can separate them.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] && !args[at + 1].startsWith('--') ? args[at + 1] : fallback;
};

const FIXTURE_PATH = value('fixture', 'experiments/fixtures/ranking-queries.json');
const CHECK = has('check');
const VERBOSE = has('verbose');

// ── fusion, bundled straight from source ─────────────────────────────────────
const MODULE = '/tmp/fieldwork-ranking-fusion.mjs';
execFileSync(
  'npx',
  ['--yes', 'esbuild', 'src/lib/fusion.ts', '--bundle', '--format=esm', `--outfile=${MODULE}`, '--log-level=error'],
  { stdio: 'inherit' },
);
const { canonicalUrl, engineWeights, fuseResults } = await import(`${MODULE}?t=${Date.now()}`);

// ── fixture ──────────────────────────────────────────────────────────────────
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const NOW = Date.parse(fixture.evaluated_at ?? '2026-11-15T00:00:00Z');
const queries = Array.isArray(fixture.queries) ? fixture.queries : [];
if (queries.length === 0) {
  console.error(`No queries in ${FIXTURE_PATH}`);
  process.exit(2);
}

/** Split a fixture query into fusion input (no `r`) and a judgement map keyed by canonical URL. */
function prepare(entry) {
  const lists = {};
  const judgements = new Map();
  for (const [engine, rows] of Object.entries(entry.lists ?? {})) {
    lists[engine] = [];
    for (const row of rows ?? []) {
      const source = { title: row.t, url: row.u, snippet: row.s ?? '', source_engine: engine };
      if (row.p) source.published = row.p;
      lists[engine].push(source);
      const key = canonicalUrl(row.u);
      // a URL judged twice keeps its best grade
      judgements.set(key, Math.max(judgements.get(key) ?? 0, Number(row.r ?? 0)));
    }
  }
  return { lists, judgements };
}

// ── metrics ─────────────────────────────────────────────────────────────────
const gain = (rel) => 2 ** rel - 1;

/**
 * How far the best answer sits above the best lesser result, relative to its own score.
 *
 * nDCG only sees order, so a weighting that leaves a lesser result 0.02 behind and one that
 * leaves it 0.60 behind both score the same when the order holds. This measures that gap
 * directly: 1 means nothing competes, 0 means a lesser result is tied with the best answer,
 * negative means a lesser result leads. "Lesser" is anything graded below the best grade in
 * the fixture, so a decoy graded 1 counts when a 2 exists. Null when nothing competes (every
 * judged result is the best grade, or the list is empty) — there is no gap to report.
 */
function separation(ranked, judgements) {
  const items = ranked.map((item) => ({
    score: Number(item.score ?? 0),
    rel: judgements.get(canonicalUrl(item.url)) ?? 0,
  }));
  const bestGrade = Math.max(...judgements.values());
  const good = items.filter((item) => item.rel === bestGrade);
  const lesser = items.filter((item) => item.rel < bestGrade);
  if (!good.length || !lesser.length) return null;
  const best = Math.max(...good.map((item) => item.score));
  if (!(best > 0)) return null;
  return (best - Math.max(...lesser.map((item) => item.score))) / best;
}

function score(ranked, judgements, k = 10) {
  const rels = ranked.slice(0, k).map((item) => judgements.get(canonicalUrl(item.url)) ?? 0);
  const dcg = rels.reduce((sum, rel, index) => sum + gain(rel) / Math.log2(index + 2), 0);
  const ideal = [...judgements.values()].sort((a, b) => b - a).slice(0, k);
  const idcg = ideal.reduce((sum, rel, index) => sum + gain(rel) / Math.log2(index + 2), 0);
  const ndcg = idcg > 0 ? dcg / idcg : 0;

  const firstStrong = rels.findIndex((rel) => rel >= 2);
  const mrr = firstStrong >= 0 ? 1 / (firstStrong + 1) : 0;

  const p5 = rels.slice(0, 5).filter((rel) => rel >= 1).length / Math.max(1, Math.min(5, rels.length || 5));

  const judgedRelevant = [...judgements.values()].filter((rel) => rel >= 1).length || 1;
  const recall = rels.filter((rel) => rel >= 1).length / judgedRelevant;

  return { ndcg, mrr, p5, recall, rels, margin: separation(ranked, judgements) };
}

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
/** Mean of the defined values only: a query with nothing to separate has no margin to average. */
const meanDefined = (values) => mean(values.filter((value) => value !== null && value !== undefined));
const fmtSigned = (value) => `${value >= 0 ? '+' : ''}${value.toFixed(3)}`;
const fmt = (value) => (Number.isFinite(value) ? value.toFixed(3) : '—');

// ── run both configurations ─────────────────────────────────────────────────
const rows = [];
for (const entry of queries) {
  const { lists, judgements } = prepare(entry);
  if (judgements.size === 0) {
    console.error(`Query ${entry.id} has no judgements`);
    process.exit(2);
  }

  const baselineWeights = engineWeights(entry.query, NOW, { character: false });
  const baseline = fuseResults(entry.query, lists, {
    now: NOW, limit: 10, weights: baselineWeights, recency: false,
  });
  const candidate = fuseResults(entry.query, lists, { now: NOW, limit: 10 });

  const before = score(baseline, judgements);
  const after = score(candidate, judgements);
  rows.push({ id: entry.id, class: entry.class ?? 'general', before, after, baseline, candidate, judgements });
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(`\nRanking benchmark: ${rows.length} queries from ${FIXTURE_PATH}`);
console.log('before = flat engine trust, no freshness · after = intent weights + freshness\n');
console.log('query              class        nDCG@10        MRR         ΔnDCG    margin   Δ');
console.log('─'.repeat(88));
for (const row of rows) {
  const delta = row.after.ndcg - row.before.ndcg;
  const flag = delta > 0.0005 ? '▲' : delta < -0.0005 ? '▼' : '·';
  const marginDelta = row.before.margin === null || row.after.margin === null
    ? null
    : row.after.margin - row.before.margin;
  const marginCell = row.before.margin === null || row.after.margin === null
    ? '—'
    : `${fmt(row.before.margin)}→${fmt(row.after.margin)}`;
  const marginFlag = marginDelta === null ? ' ' : marginDelta > 0.0005 ? '▲' : marginDelta < -0.0005 ? '▼' : '·';
  console.log(
    `${row.id.padEnd(18)} ${row.class.padEnd(12)} ${fmt(row.before.ndcg)} → ${fmt(row.after.ndcg)}  ` +
      `${fmt(row.before.mrr)} → ${fmt(row.after.mrr)}  ${flag} ${delta >= 0 ? '+' : ''}${delta.toFixed(3)}  ` +
      `${marginCell}  ${marginFlag}${marginDelta === null ? '' : fmtSigned(marginDelta)}`,
  );
  if (VERBOSE) {
    const label = (item) => judgements.getLabel?.(item) ?? row.judgements.get(canonicalUrl(item.url)) ?? 0;
    console.log(`   before: ${row.baseline.slice(0, 5).map((item) => `${label(item)}:${new URL(item.url).hostname.replace(/^www\./, '')}`).join('  ')}`);
    console.log(`   after : ${row.candidate.slice(0, 5).map((item) => `${label(item)}:${new URL(item.url).hostname.replace(/^www\./, '')}`).join('  ')}`);
  }
}

const classes = [...new Set(rows.map((row) => row.class))];
console.log('\nby intent class (mean over queries)');
console.log('class         n   nDCG before → after   Δ       MRR Δ    P@5 Δ   recall Δ   margin Δ');
for (const name of classes) {
  const subset = rows.filter((row) => row.class === name);
  const b = { ndcg: mean(subset.map((r) => r.before.ndcg)), mrr: mean(subset.map((r) => r.before.mrr)), p5: mean(subset.map((r) => r.before.p5)), recall: mean(subset.map((r) => r.before.recall)), margin: meanDefined(subset.map((r) => r.before.margin)) };
  const a = { ndcg: mean(subset.map((r) => r.after.ndcg)), mrr: mean(subset.map((r) => r.after.mrr)), p5: mean(subset.map((r) => r.after.p5)), recall: mean(subset.map((r) => r.after.recall)), margin: meanDefined(subset.map((r) => r.after.margin)) };
  const d = (x, y) => `${x - y >= 0 ? '+' : ''}${(x - y).toFixed(3)}`;
  console.log(
    `${name.padEnd(13)} ${String(subset.length).padEnd(3)} ${fmt(b.ndcg)} → ${fmt(a.ndcg)}      ${d(a.ndcg, b.ndcg)}  ${d(a.mrr, b.mrr)}   ${d(a.p5, b.p5)}   ${d(a.recall, b.recall)}   ${d(a.margin, b.margin)}`,
  );
}

const overallBefore = {
  ndcg: mean(rows.map((r) => r.before.ndcg)),
  mrr: mean(rows.map((r) => r.before.mrr)),
  p5: mean(rows.map((r) => r.before.p5)),
  recall: mean(rows.map((r) => r.before.recall)),
  margin: meanDefined(rows.map((r) => r.before.margin)),
};
const overallAfter = {
  ndcg: mean(rows.map((r) => r.after.ndcg)),
  mrr: mean(rows.map((r) => r.after.mrr)),
  p5: mean(rows.map((r) => r.after.p5)),
  recall: mean(rows.map((r) => r.after.recall)),
  margin: meanDefined(rows.map((r) => r.after.margin)),
};
const improved = rows.filter((r) => r.after.ndcg - r.before.ndcg > 0.0005).length;
const regressed = rows.filter((r) => r.after.ndcg - r.before.ndcg < -0.0005).length;

console.log('\noverall');
console.log(`  nDCG@10   ${fmt(overallBefore.ndcg)} → ${fmt(overallAfter.ndcg)}   (${(overallAfter.ndcg - overallBefore.ndcg >= 0 ? '+' : '') + (overallAfter.ndcg - overallBefore.ndcg).toFixed(3)})`);
console.log(`  MRR       ${fmt(overallBefore.mrr)} → ${fmt(overallAfter.mrr)}`);
console.log(`  P@5       ${fmt(overallBefore.p5)} → ${fmt(overallAfter.p5)}`);
console.log(`  recall@10 ${fmt(overallBefore.recall)} → ${fmt(overallAfter.recall)}`);
console.log(`  margin    ${fmt(overallBefore.margin)} → ${fmt(overallAfter.margin)}   (headroom over the best lesser result)`);
console.log('  margin is order-free: 1 = nothing competes, 0 = a lesser result ties the best answer,');
console.log('  negative = a lesser result still leads. "—" means every judged result was the best grade.');
console.log(`  improved on ${improved}/${rows.length} queries, regressed on ${regressed}`);
if (improved === 0) {
  console.log('\n  ! no query moved. Either the weighting changed nothing, or the query set has lost its');
  console.log('    contested pairs and now scores the same however results are ranked.');
}

if (has('json')) {
  console.log('\n' + JSON.stringify({
    queries: rows.map((row) => ({
      id: row.id, class: row.class,
      before: { ndcg: row.before.ndcg, mrr: row.before.mrr, p5: row.before.p5, recall: row.before.recall, margin: row.before.margin },
      after: { ndcg: row.after.ndcg, mrr: row.after.mrr, p5: row.after.p5, recall: row.after.recall, margin: row.after.margin },
    })),
    overall: { before: overallBefore, after: overallAfter },
  }, null, 2));
}

// ── gate ────────────────────────────────────────────────────────────────────
if (CHECK) {
  const problems = [];
  if (overallAfter.ndcg < overallBefore.ndcg - 0.001) {
    problems.push(`overall nDCG regressed: ${fmt(overallBefore.ndcg)} → ${fmt(overallAfter.ndcg)}`);
  }
  for (const name of classes) {
    const subset = rows.filter((row) => row.class === name);
    const b = mean(subset.map((r) => r.before.ndcg));
    const a = mean(subset.map((r) => r.after.ndcg));
    if (a < b - 0.05) problems.push(`${name} nDCG regressed: ${fmt(b)} → ${fmt(a)}`);
  }
  if (problems.length) {
    console.error('\nFAILED');
    for (const problem of problems) console.error(`  ✗ ${problem}`);
    process.exit(1);
  }
  console.log('\n✓ no regression against the previous weighting');
}
