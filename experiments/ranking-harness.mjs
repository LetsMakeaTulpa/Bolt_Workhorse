#!/usr/bin/env node
// Ranking quality harness: runs a fixed query set through fusion twice — once with the previous
// weighting (flat engine trust, no recency) and once with the current intent-weighted scheme —
// and reports nDCG@10, MRR, P@5 and recall@10 against graded relevance judgements.
//
//   node experiments/ranking-harness.mjs
//   node experiments/ranking-harness.mjs --verbose
//   node experiments/ranking-harness.mjs --check      # exit 1 on an overall regression
//   node experiments/ranking-harness.mjs --fixture path/to/queries.json
//   node experiments/ranking-harness.mjs --compare path/to/weights.json
//
// `--compare` scores any two weight configurations you name, instead of the fixed default pair
// (flat trust with no freshness versus whatever `engineWeights` does today). A configuration is
// `{ "label", "weights": "flat" | "intent" | { engine: number }, "recency": boolean }`; the file is
// `{ "before": {...}, "after": {...} }`. That is what a constant change is actually asking: the
// same fixed queries, the old numbers and the new numbers, one table apart.
//
// The fixture is deliberately offline: judgments come with the query set, so a weight change can
// be scored in a second, on every commit, with no API keys and no network.
//
// The query set is contested on purpose. A set where every engine's top hit is on-topic scores
// identically under any weighting, which looks like "no regression" but measures nothing: each
// contested query pairs two results with near-identical term coverage so only engine trust or a
// publication date can separate them.

import { tmpPath, ESBUILD } from './lib/build.mjs';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] && !args[at + 1].startsWith('--') ? args[at + 1] : fallback;
};

const FIXTURE_PATH = value('fixture', 'experiments/fixtures/ranking-queries.json');
const COMPARE_PATH = value('compare', null);
const CHECK = has('check');
const VERBOSE = has('verbose');

// How much the lead over the best lesser result may shrink before `--check` fails. Margin is a
// fraction of the best score, so these are absolute proportions, not ratios: 0.02 overall is a
// fifth of the typical gap this fixture produces.
const MARGIN_TOLERANCE = 0.02;
const CLASS_MARGIN_TOLERANCE = 0.05;
/** A single query narrowing by this much is listed, so the cause is visible even when the mean holds. */
const QUERY_MARGIN_DROP = 0.05;

// ── fusion, bundled straight from source ─────────────────────────────────────
// The local esbuild JS entry point runs under node directly: spawning `npx` through cmd.exe on
// Windows cannot find the binary, and shell quoting would mangle the define flags.
const MODULE = (process.env.RANKING_MODULE ?? tmpPath('fieldwork-ranking-fusion.mjs')).replaceAll('\\', '/');
execFileSync(
  process.execPath,
  [ESBUILD, 'src/lib/fusion.ts', '--bundle', '--format=esm', `--outfile=${MODULE}`, '--log-level=error'],
  { stdio: 'inherit' },
);
const { canonicalUrl, engineWeights, fuseResults, termCoverage, tokens } = await import(
  `${pathToFileURL(MODULE).href}?t=${Date.now()}`
);

// ── the two configurations being compared ────────────────────────────────────
// Default: the pre-intent scheme against the current one. `--compare` replaces either side with a
// named configuration, which is how a weight change is scored without editing this file.
const DEFAULT_CONFIGS = {
  before: { label: 'flat engine trust, no freshness', weights: 'flat', recency: false },
  after: { label: 'current intent weights + freshness' },
};

function loadConfigs(path) {
  if (!path) return DEFAULT_CONFIGS;
  const spec = JSON.parse(readFileSync(path, 'utf8'));
  if (!spec.before || !spec.after) {
    console.error(`${path} needs a "before" and an "after" configuration`);
    process.exit(2);
  }
  const label = (side, value) => (typeof value.label === 'string' && value.label ? value.label : side);
  return {
    before: { ...spec.before, label: label('before', spec.before) },
    after: { ...spec.after, label: label('after', spec.after) },
  };
}

const configs = loadConfigs(COMPARE_PATH);

/** Turn a named configuration into `fuseResults` options for one query. */
function optionsFor(config, query) {
  const options = { now: NOW, limit: 10 };
  if (config.weights === 'flat') {
    // the pre-intent table: keyword routing still applies, engine character does not
    options.weights = engineWeights(query, NOW, { character: false });
  } else if (config.weights === 'intent') {
    options.weights = engineWeights(query, NOW);
  } else if (config.weights && typeof config.weights === 'object') {
    options.weights = config.weights;
  } else if (config.weights !== undefined) {
    console.error(`unknown weights mode "${config.weights}" — use "flat", "intent" or a { engine: number } map`);
    process.exit(2);
  }
  // an explicit map with no single engine is a mistake worth naming, not an empty ranking
  if (options.weights && Object.keys(options.weights).length === 0) {
    console.error('a weights map must name at least one engine');
    process.exit(2);
  }
  if (config.recency !== undefined) options.recency = Boolean(config.recency);
  return options;
}

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
 * IDF-weighted coverage of every result in a query — the same number fusion scores with.
 * A `tie` query claims its on-topic pair is separated by nothing but a date or engine trust, so
 * this checks the claim instead of trusting the fixture's prose: equal coverage is what makes such
 * a query discriminating.
 */
function coverageOf(lists, query) {
  const all = Object.values(lists).flat();
  const df = new Map();
  for (const item of all) {
    for (const token of new Set(tokens(`${item.title} ${item.snippet}`))) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }
  return all.map((item) => ({ item, coverage: termCoverage(query, item, df, all.length) }));
}

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
const tieProblems = [];
for (const entry of queries) {
  const { lists, judgements } = prepare(entry);
  if (judgements.size === 0) {
    console.error(`Query ${entry.id} has no judgements`);
    process.exit(2);
  }

  // Fixture integrity, checked for every query: two judged results whose titles are close enough to
  // merge into one entity means the pair can never be reordered, so the query silently measures a
  // single answer. Ties additionally have to be exactly equal on coverage.
  {
    const onTopic = coverageOf(lists, entry.query)
      .filter(({ item }) => (judgements.get(canonicalUrl(item.url)) ?? 0) >= 1)
      .map(({ item, coverage }) => ({ url: item.url, coverage }));
    if (onTopic.length < 2) {
      if (entry.tie) {
        tieProblems.push(`${entry.id}: a ${entry.tie} tie needs two on-topic results, found ${onTopic.length}`);
      }
    } else {
      const spread = Math.max(...onTopic.map((row) => row.coverage)) - Math.min(...onTopic.map((row) => row.coverage));
      if (entry.tie && spread > 1e-9) {
        tieProblems.push(
          `${entry.id}: on-topic results differ in coverage by ${spread.toFixed(6)} — relevance alone separates them, so it is not a ${entry.tie} tie`,
        );
      }

      // Merging two engines' copies of one page is the point of entity resolution, so an absent URL
      // is not a defect on its own. Losing the *best-graded* page is: it means a top answer was
      // swallowed by a lesser one and the query now scores an order it never judged.
      const fusedDefault = fuseResults(entry.query, lists, { now: NOW, limit: 50 });
      const bestJudged = Math.max(...judgements.values());
      const bestRanked = Math.max(...fusedDefault.map((row) => judgements.get(canonicalUrl(row.url)) ?? 0));
      if (bestRanked < bestJudged) {
        tieProblems.push(
          `${entry.id}: the best-graded result (${bestJudged}) never appears in the fused list — merged into a lesser result, so the query scores an order it never judged`,
        );
      }
    }
  }

  const baseline = fuseResults(entry.query, lists, optionsFor(configs.before, entry.query));
  const candidate = fuseResults(entry.query, lists, optionsFor(configs.after, entry.query));

  const before = score(baseline, judgements);
  const after = score(candidate, judgements);
  rows.push({ id: entry.id, class: entry.class ?? 'general', before, after, baseline, candidate, judgements });
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(`\nRanking benchmark: ${rows.length} queries from ${FIXTURE_PATH}`);
console.log(`before = ${configs.before.label} · after = ${configs.after.label}\n`);
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
const marginDrops = rows
  .filter((row) => row.before.margin !== null && row.after.margin !== null && row.after.margin < row.before.margin - QUERY_MARGIN_DROP)
  .map((row) => ({ id: row.id, drop: row.after.margin - row.before.margin }));
if (marginDrops.length > 0) {
  const worst = marginDrops.reduce((a, b) => (b.drop < a.drop ? b : a));
  console.log(`  margin narrowed on ${marginDrops.length}/${rows.length} queries (worst ${worst.id} ${fmtSigned(worst.drop)})`);
} else {
  console.log('  margin narrowed on no query');
}
if (improved === 0) {
  console.log('\n  ! no query moved. Either the weighting changed nothing, or the query set has lost its');
  console.log('    contested pairs and now scores the same however results are ranked.');
}
for (const problem of tieProblems) console.log(`\n  ! ${problem}`);

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

  // margin can fall while nDCG holds: the right result stays first, but a lesser one closes in on
  // it, which is the leading edge of the next reordering. Order metrics cannot see that, so it is
  // gated on its own.
  const marginsOf = (subset, side) => subset.map((row) => row[side].margin).filter((value) => value !== null && value !== undefined);
  const definedBoth = marginsOf(rows, 'before').length > 0 && marginsOf(rows, 'after').length > 0;
  if (definedBoth && overallAfter.margin < overallBefore.margin - MARGIN_TOLERANCE) {
    problems.push(
      `overall margin regressed: ${fmt(overallBefore.margin)} → ${fmt(overallAfter.margin)} (lead narrowed by more than ${MARGIN_TOLERANCE})`,
    );
  }
  for (const name of classes) {
    const subset = rows.filter((row) => row.class === name);
    const b = marginsOf(subset, 'before');
    const a = marginsOf(subset, 'after');
    if (b.length === 0 || a.length === 0) continue;
    const before = mean(b);
    const after = mean(a);
    if (after < before - CLASS_MARGIN_TOLERANCE) {
      problems.push(`${name} margin regressed: ${fmt(before)} → ${fmt(after)}`);
    }
  }
  // a tie query exists to be moved by recency or intent alone: if it stops moving, the set has
  // stopped being discriminative even though nothing regressed. That is a claim about this fixture
  // against the shipped weighting, so it only applies to the default pair — a `--compare` run is
  // free to choose a configuration that deliberately moves nothing.
  for (const name of COMPARE_PATH ? [] : classes.filter((name) => name.endsWith('-tie'))) {
    const subset = rows.filter((row) => row.class === name);
    const b = mean(subset.map((r) => r.before.ndcg));
    const a = mean(subset.map((r) => r.after.ndcg));
    if (a - b < 0.05) problems.push(`${name} is no longer discriminative: nDCG ${fmt(b)} → ${fmt(a)}`);
  }
  problems.push(...tieProblems);
  if (problems.length) {
    console.error('\nFAILED');
    for (const problem of problems) console.error(`  ✗ ${problem}`);
    process.exit(1);
  }
  console.log('\n✓ no regression against the previous weighting');
}
