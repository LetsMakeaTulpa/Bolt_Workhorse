#!/usr/bin/env node
// One-constant-at-a-time sensitivity sweep over the ranking constants, scored on the contested
// fixture. Answers two questions the harness cannot: which constants actually change the ranking,
// and whether a value that wins on the whole set also wins on queries it was not tuned on.
//
//   node experiments/ranking-sweep.mjs             # sensitivity tables
//   node experiments/ranking-sweep.mjs --ablate    # what each constant buys
//   node experiments/ranking-sweep.mjs --stability # leave-one-out check on the chosen values
//   node experiments/ranking-sweep.mjs --assert-separation  # exit 1 if a constant no longer moves
//                                                          anything against its neutral value
//   node experiments/ranking-sweep.mjs --calibrate          # what a real change to each constant
//                                                          actually moves, smallest first — the
//                                                          evidence behind the gate's tolerances
//
// Twenty-eight queries is still a small sample, so a value is only reported as "earning its place"
// when it improves the tuned queries without giving up ground on the held-out classes.

import { tmpPath, ESBUILD } from './lib/build.mjs';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const STABILITY = args.includes('--stability');
// `--assert-separation` is the gate: it needs the ablation table, and it exits non-zero when a
// constant has stopped being distinguishable from the value it is compared against
const ASSERT_SEPARATION = args.includes('--assert-separation');
const ABLATE = args.includes('--ablate') || ASSERT_SEPARATION;
const CALIBRATE = args.includes('--calibrate');

/**
 * What the separation gate calls no effect, and what it merely warns about.
 *
 * Calibrated with `--calibrate` rather than guessed: across every value the sweep evaluates, the
 * smallest margin move a real change to a constant produces on this fixture is 0.0007, and a change
 * that leaves the order untouched moves mean nDCG by 0.0000. A tolerance of 0.0005 therefore sits
 * just under the fixture's resolution — below it the honest reading is "this fixture cannot see it",
 * not "this constant does nothing". Ten tolerances up is the band worth warning about: passing today,
 * one flat query away from failing.
 */
const SEPARATION_TOLERANCE = { ndcg: 0.0005, margin: 0.0005, separation: 0.0005 };
const NEAR_THRESHOLD = SEPARATION_TOLERANCE.margin * 10;

const FIXTURE_PATH = 'experiments/fixtures/ranking-queries.json';
// run the local esbuild under node directly: `npx` cannot be spawned through cmd.exe on Windows
const MODULE = (process.env.RANKING_MODULE ?? tmpPath('fieldwork-ranking-sweep.mjs')).replaceAll('\\', '/');
execFileSync(
  process.execPath,
  [ESBUILD, 'src/lib/fusion.ts', '--bundle', '--format=esm', `--outfile=${MODULE}`, '--log-level=error'],
  { stdio: 'inherit' },
);
const { canonicalUrl, engineWeights, fuseResults, queryIntent } = await import(
  `${pathToFileURL(MODULE).href}?t=${Date.now()}`
);

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const NOW = Date.parse(fixture.evaluated_at ?? '2026-11-15T00:00:00Z');
const queries = fixture.queries;

function prepare(entry) {
  const lists = {};
  const judgements = new Map();
  for (const [engine, rows] of Object.entries(entry.lists ?? {})) {
    lists[engine] = (rows ?? []).map((row) => {
      const source = { title: row.t, url: row.u, snippet: row.s ?? '', source_engine: engine };
      if (row.p) source.published = row.p;
      judgements.set(canonicalUrl(row.u), Math.max(judgements.get(canonicalUrl(row.u)) ?? 0, Number(row.r ?? 0)));
      return source;
    });
  }
  return { lists, judgements };
}

const gain = (rel) => 2 ** rel - 1;

function ndcg(ranked, judgements, k = 10) {
  const rels = ranked.slice(0, k).map((item) => judgements.get(canonicalUrl(item.url)) ?? 0);
  const dcg = rels.reduce((sum, rel, index) => sum + gain(rel) / Math.log2(index + 2), 0);
  const ideal = [...judgements.values()].sort((a, b) => b - a).slice(0, k);
  const idcg = ideal.reduce((sum, rel, index) => sum + gain(rel) / Math.log2(index + 2), 0);
  return idcg > 0 ? dcg / idcg : 0;
}

function margin(ranked, judgements) {
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

/**
 * How far apart the scores are, independent of the order they produce.
 *
 * `margin` only looks at one boundary — best graded versus best lesser — so a constant that changes
 * how sharply the scorer separates everything below the winner is invisible to it. The relevance
 * exponent is exactly that kind of constant: raising it from 1.0 to 1.5 shrinks every lower score by
 * a different amount without necessarily swapping any pair. This averages the gap between each pair
 * of neighbours, as a share of the top score, so it reads as "how spread out is this ranking".
 * 0 means every result scored the same; a larger number means the winner stands further clear.
 */
function scoreSeparation(ranked) {
  const scores = ranked.map((item) => Number(item.score ?? 0)).filter((score) => score > 0);
  if (scores.length < 2 || !(scores[0] > 0)) return null;
  const gaps = [];
  for (let index = 0; index < scores.length - 1; index += 1) {
    gaps.push((scores[index] - scores[index + 1]) / scores[0]);
  }
  return mean(gaps);
}

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const meanDefined = (values) => mean(values.filter((value) => value !== null && value !== undefined));

// ── counterfactual weights ──────────────────────────────────────────────────
// The intent deltas live inside engineWeights. Rather than duplicate its base table here (which
// would drift), start from the real weights and apply the difference for the one delta under test.
const clamp = (value, lo = 0.25, hi = 1.6) => Math.max(lo, Math.min(hi, value));

const DEFAULT_DELTAS = { exaSemantic: 0.45, exaNavigational: 0.5, exaFresh: 0.2, tavilyFresh: 0.45 };

function weightsFor(query, override = {}) {
  const d = { ...DEFAULT_DELTAS, ...override };
  const intent = queryIntent(query, NOW);
  const weights = engineWeights(query, NOW);
  weights.exa = clamp(weights.exa + (d.exaSemantic - DEFAULT_DELTAS.exaSemantic) * intent.semantic
    - (d.exaNavigational - DEFAULT_DELTAS.exaNavigational) * intent.navigational
    - (d.exaFresh - DEFAULT_DELTAS.exaFresh) * intent.fresh);
  weights.tavily = clamp(weights.tavily + (d.tavilyFresh - DEFAULT_DELTAS.tavilyFresh) * intent.fresh);
  return weights;
}

function evaluate({ deltas = {}, fusion = {} }) {
  const per = [];
  for (const entry of queries) {
    const { lists, judgements } = prepare(entry);
    const ranked = fuseResults(entry.query, lists, {
      now: NOW,
      limit: 10,
      weights: weightsFor(entry.query, deltas),
      ...fusion,
    });
    per.push({
      id: entry.id,
      class: entry.class,
      ndcg: ndcg(ranked, judgements),
      margin: margin(ranked, judgements),
      // the order is a coarse reading of the same scores; this is the scores themselves
      separation: scoreSeparation(ranked),
      // the ranked order itself, so an ablation can say whether a constant reorders anything or
      // only nudges a score
      order: ranked.map((item) => canonicalUrl(item.url)).join('|'),
    });
  }
  return {
    per,
    ndcg: mean(per.map((row) => row.ndcg)),
    margin: meanDefined(per.map((row) => row.margin)),
    separation: meanDefined(per.map((row) => row.separation)),
  };
}

const TRAIN = new Set(['fresh', 'semantic']);
const scoreSet = (result, classes) => mean(result.per.filter((row) => classes.has(row.class)).map((row) => row.ndcg));

// ── grids ───────────────────────────────────────────────────────────────────
// `apply` returns the config to evaluate for a value; `default` is what the source ships today.
const GRIDS = [
  { key: 'recencyGain', label: 'freshness gain', defaultValue: 1.2, values: [0, 0.3, 0.6, 0.9, 1.2, 1.5],
    apply: (value) => ({ fusion: { recencyGain: value } }) },
  { key: 'relevanceExponent', label: 'relevance exponent', defaultValue: 1.5, values: [0.75, 1.0, 1.25, 1.5, 2.0, 2.5],
    apply: (value) => ({ fusion: { relevanceExponent: value } }) },
  { key: 'k', label: 'RRF smoothing k', defaultValue: 60, values: [5, 10, 30, 60, 100, 200],
    apply: (value) => ({ fusion: { k: value } }) },
  { key: 'exaSemantic', label: 'exa + semantic', defaultValue: 0.45, values: [0.15, 0.3, 0.45, 0.6, 0.8],
    apply: (value) => ({ deltas: { exaSemantic: value } }) },
  { key: 'exaNavigational', label: 'exa - navigational', defaultValue: 0.5, values: [0.2, 0.35, 0.5, 0.7, 0.9],
    apply: (value) => ({ deltas: { exaNavigational: value } }) },
  { key: 'tavilyFresh', label: 'tavily + fresh', defaultValue: 0.45, values: [0.1, 0.25, 0.45, 0.7, 1.0],
    apply: (value) => ({ deltas: { tavilyFresh: value } }) },

];

const baseline = evaluate({});
console.log(`\nSweep: ${queries.length} contested queries · current defaults nDCG ${baseline.ndcg.toFixed(3)}, margin ${baseline.margin.toFixed(3)}`);
const trainCount = queries.filter((row) => TRAIN.has(row.class)).length;
console.log(`train = fresh+semantic (${trainCount} queries) · holdout = everything else (${queries.length - trainCount})\n`);

const results = [];
/** every value the sweep evaluated, with what it moved — the calibration's raw material */
const sweeps = [];
for (const grid of GRIDS) {
  console.log(`${grid.label} (current ${grid.defaultValue})`);
  console.log('  value   nDCG    Δ       margin  Δ       sep     Δ       train   holdout');
  let best = null;
  for (const value of grid.values) {
    const result = evaluate(grid.apply(value));
    const train = scoreSet(result, TRAIN);
    const holdout = mean(result.per.filter((row) => !TRAIN.has(row.class)).map((row) => row.ndcg));
    const dn = result.ndcg - baseline.ndcg;
    const dm = result.margin - baseline.margin;
    const dsep = result.separation - baseline.separation;
    const isDefault = value === grid.defaultValue;
    console.log(
      `  ${String(value).padEnd(6)} ${result.ndcg.toFixed(3)}  ${(dn >= 0 ? '+' : '') + dn.toFixed(3)}  ${result.margin.toFixed(3)}  ${(dm >= 0 ? '+' : '') + dm.toFixed(3)}   ${result.separation.toFixed(3)}  ${(dsep >= 0 ? '+' : '') + dsep.toFixed(3)}   ${train.toFixed(3)}   ${holdout.toFixed(3)}${isDefault ? '   ← current' : ''}`,
    );
    sweeps.push({
      key: grid.key,
      label: grid.label,
      value,
      isDefault,
      dn,
      dm,
      dsep,
      separation: result.separation,
      reordered: result.per.filter((row, index) => row.order !== baseline.per[index].order).length,
    });
    if (!best || result.ndcg > best.result.ndcg + 1e-9) best = { value, result, train, holdout };
  }
  results.push({ grid, best, baseline });
  console.log('');
}

// ── calibration: how small is a real change? ────────────────────────────────
// The gate below has to call a constant "untested" without calling a quiet one untested by
// mistake. That needs a floor: the smallest effect an actual change to a constant produces on this
// fixture. Every non-default value the sweep already evaluated is exactly such a change, so sort
// them by how little they moved and read the floor off the bottom of the table.
if (CALIBRATE) {
  console.log(`
calibration: what a real change to a constant moves (smallest first)`);
  console.log("  constant              value   nDCG Δ    margin Δ  sep Δ     reordered");
  const ordered = [...sweeps]
    .filter((row) => !row.isDefault)
    .sort((a, b) => Math.abs(a.dn) - Math.abs(b.dn) || Math.abs(a.dm) - Math.abs(b.dm));
  for (const row of ordered) {
    console.log(
      `  ${row.label.padEnd(21)} ${String(row.value).padEnd(7)} ${((row.dn >= 0 ? "+" : "") + row.dn.toFixed(4)).padEnd(9)} ${((row.dm >= 0 ? "+" : "") + row.dm.toFixed(4)).padEnd(9)} ${((row.dsep >= 0 ? "+" : "") + row.dsep.toFixed(4)).padEnd(9)} ${row.reordered}`,
    );
  }

  const reordering = ordered.filter((row) => row.reordered > 0);
  const quietestReorder = reordering.length ? Math.min(...reordering.map((row) => Math.abs(row.dn))) : 0;
  const quietestMargin = ordered.length ? Math.min(...ordered.map((row) => Math.abs(row.dm))) : 0;
  const quietestSeparation = ordered.length ? Math.min(...ordered.map((row) => Math.abs(row.dsep))) : 0;
  console.log(`
  floor: the smallest change that still reorders a query moves nDCG by ${quietestReorder.toFixed(4)};`);
  const clearance = quietestMargin / SEPARATION_TOLERANCE.margin;
  console.log(
    `         the smallest margin move from any change is ${quietestMargin.toFixed(4)}; the gate sits at ` +
      `${SEPARATION_TOLERANCE.margin} (${clearance.toFixed(1)}x below it), warning from ${NEAR_THRESHOLD}`,
  );
  console.log(
    `         the smallest score-separation move is ${quietestSeparation.toFixed(4)}; the gate sits at ${SEPARATION_TOLERANCE.separation}`,
  );
}

// ── proposed combination ────────────────────────────────────────────────────
// Only adopt a value when it beats the current default on nDCG without losing held-out ground,
// and when the gain is large enough to survive rounding.
const adopt = results
  .filter(({ grid, best }) => best.value !== grid.defaultValue)
  .filter(({ best, baseline: base }) => best.result.ndcg > base.ndcg + 0.002)
  .map(({ grid, best }) => ({ grid, best }));

console.log('candidates worth adopting (beat the default on nDCG):');
if (adopt.length === 0) {
  console.log('  none — every constant is at or near its best value already');
} else {
  for (const { grid, best } of adopt) {
    console.log(
      `  ${grid.label.padEnd(20)} ${grid.defaultValue} → ${best.value}   nDCG ${baseline.ndcg.toFixed(3)} → ${best.result.ndcg.toFixed(3)}, margin ${baseline.margin.toFixed(3)} → ${best.result.margin.toFixed(3)}`,
    );
  }
}

if (adopt.length) {
  const combined = evaluate({});
  const deltas = {};
  const fusion = {};
  for (const { grid, best } of adopt) {
    if (grid.key in DEFAULT_DELTAS) deltas[grid.key] = best.value;
    else fusion[grid.key] = best.value;
  }
  const merged = evaluate({ deltas, fusion });
  console.log(`\ncombined: nDCG ${combined.ndcg.toFixed(3)} → ${merged.ndcg.toFixed(3)}, margin ${combined.margin.toFixed(3)} → ${merged.margin.toFixed(3)}`);
  console.log(`  config: ${JSON.stringify({ deltas, fusion })}`);
  for (const row of merged.per) {
    const original = baseline.per.find((item) => item.id === row.id);
    const d = row.ndcg - original.ndcg;
    if (Math.abs(d) > 0.0005) console.log(`  ${row.id.padEnd(18)} ${row.ndcg.toFixed(3)}  ${d >= 0 ? '+' : ''}${d.toFixed(3)}`);
  }
}

// ── ablation: what does each constant buy? ─────────────────────────────────
// Sweeping forward answers "is some other value better"; ablation answers "would removing this
// constant be noticed at all", which is the question of whether it earns its place. A constant
// whose removal costs nothing on a contested set is decoration.
if (ABLATE) {
  const current = evaluate({});
  console.log(`\nablation: current config nDCG ${current.ndcg.toFixed(3)}, margin ${current.margin.toFixed(3)}`);
  console.log('  constant              neutral   nDCG    Δ       margin   Δ        sep    Δ        verdict');
  const ABLATIONS = [
    { key: 'recencyGain', label: 'freshness gain 1.2', neutral: 'no freshness', cfg: { fusion: { recency: false } } },
    { key: 'relevanceExponent', label: 'relevance ^1.5', neutral: '^1.0', cfg: { fusion: { relevanceExponent: 1.0 } } },
    { key: 'k', label: 'RRF k=60', neutral: 'k=10', cfg: { fusion: { k: 10 } } },
    { key: 'exaSemantic', label: 'exa + semantic .45', neutral: '0', cfg: { deltas: { exaSemantic: 0 } } },
    { key: 'exaNavigational', label: 'exa - navigational .5', neutral: '0', cfg: { deltas: { exaNavigational: 0 } } },
    { label: 'exa - fresh .2', neutral: '0', cfg: { deltas: { exaFresh: 0 } } },
    { key: 'tavilyFresh', label: 'tavily + fresh .45', neutral: '0', cfg: { deltas: { tavilyFresh: 0 } } },

  ];
  const separations = [];
  for (const { key, label, neutral, cfg } of ABLATIONS) {
    const without = evaluate(cfg);
    const dn = current.ndcg - without.ndcg;
    const dm = current.margin - without.margin;
    const reordered = current.per.filter((row, index) => row.order !== without.per[index].order).length;
    // the scores are the finer reading: a constant can leave every pair in place and still change
    // how far the winner stands clear of the field, which is exactly what the exponent does
    const dsep = current.separation - without.separation;
    // Does the fixture identify the value, or only that the constant matters? The ablation asks
    // "would removing it be noticed"; the grid asks "which value should it hold". A grid where no
    // value separates from the default beyond the calibrated tolerance has not identified the
    // constant, and reporting that as earning its place would claim a verdict the data lacks.
    const beyond = (value, tolerance) => Math.abs(value) > tolerance;
    // decisive: the ablation itself clears a tolerance, or leaves at least one query in a different
    // order — order is evidence no tolerance can discount
    const decisive =
      reordered > 0 ||
      beyond(dn, SEPARATION_TOLERANCE.ndcg) ||
      beyond(dm, SEPARATION_TOLERANCE.margin) ||
      beyond(dsep, SEPARATION_TOLERANCE.separation);
    const gridRows = key ? sweeps.filter((row) => row.key === key && !row.isDefault) : [];
    // the grid answers a different question: whether any *other* value beats the default measurably
    const gridIdentifies = gridRows.some(
      (row) => row.reordered > 0 || beyond(row.dn, SEPARATION_TOLERANCE.ndcg) ||
        beyond(row.dm, SEPARATION_TOLERANCE.margin) || beyond(row.dsep, SEPARATION_TOLERANCE.separation),
    );
    const identified = decisive || gridIdentifies;
    separations.push({ key, label, neutral, reordered, dn, dm, dsep, identified });
    const verdict = !identified
      ? gridRows.length > 0
        ? 'unidentifiable (no value separates)'
        : 'unidentifiable (nothing to compare against)'
      : !decisive
        ? 'unidentifiable (default not separated, other values are)'
      : dn > 0.002
      ? 'earns its place (order)'
      : dsep > SEPARATION_TOLERANCE.separation
        ? 'earns its place (separation)'
        : dm > SEPARATION_TOLERANCE.margin
          ? 'earns its place (margin only)'
          : dsep < -SEPARATION_TOLERANCE.separation || dm < -SEPARATION_TOLERANCE.margin
            ? 'removal sharpens the ranking'
            : dn < -0.002
              ? 'removal improves the order'
              : 'separates, but below the reporting floor';
    console.log(
      `  ${label.padEnd(21)} ${neutral.padEnd(13)} ${without.ndcg.toFixed(3)}  ${(dn >= 0 ? '+' : '') + dn.toFixed(3)}  ${without.margin.toFixed(3)}  ${(dm >= 0 ? '+' : '') + dm.toFixed(3)}  ${(dsep >= 0 ? '+' : '') + dsep.toFixed(3)}   ${verdict}`,
    );
  }

  // The gate: a constant whose neutral value produces every same ranking and the same mean margin
  // is not "subtle", it is untested — the fixture can no longer tell the two configurations apart,
  // so any value chosen for it is arbitrary and the ablation's "earns its place" is unearned.
  if (ASSERT_SEPARATION) {
    const reordering = separations.filter((row) => row.reordered > 0).length;
    const byScore = separations.filter(
      (row) => row.reordered === 0 && Math.abs(row.dsep) > SEPARATION_TOLERANCE.separation,
    ).length;
    const unidentified = separations.filter((row) => !row.identified);
    console.log(
      `
separation: ${separations.length} constants · ${reordering} reorder at least one query · ` +
        `${byScore} separate the scores without moving a pair · ${unidentified.length} unidentifiable`,
    );
    // tolerances: see SEPARATION_TOLERANCE below --calibrate is what set them
    const silent = separations.filter(
      (row) =>
        row.reordered === 0 &&
        Math.abs(row.dn) <= SEPARATION_TOLERANCE.ndcg &&
        Math.abs(row.dm) <= SEPARATION_TOLERANCE.margin &&
        Math.abs(row.dsep) <= SEPARATION_TOLERANCE.separation,
    );
    for (const row of separations.filter((item) => item.reordered === 0 && !silent.includes(item))) {
      console.log(`  · ${row.label} changes no ordering, but separates the scores (Δsep ${row.dsep.toFixed(3)})`);
      if (Math.abs(row.dsep) > NEAR_THRESHOLD) continue;
      console.log(
        `  ! ${row.label} sits near the threshold (Δsep ${row.dsep.toFixed(4)}): the smallest score separation this fixture resolves is ~0.0007, so one more flat query would make it untestable`,
      );
    }
    if (silent.length > 0) {
      for (const row of silent) {
        console.error(
          `  ✗ ${row.label} is indistinguishable from ${row.neutral}: 0 queries reordered, ΔnDCG ${row.dn.toFixed(3)}, Δmargin ${row.dm.toFixed(3)}, Δsep ${row.dsep.toFixed(3)} — nothing on this fixture tests it`,
        );
      }
      process.exit(1);
    }
    // a constant whose value no grid row distinguishes is reported as such, even when its
    // ablation moves something: "earns its place" answers a different question
    for (const row of unidentified) {
      console.log(
        `  ? ${row.label} is unidentifiable on this fixture: no value in its grid separates from ` +
          `${row.neutral} beyond tolerance, so the value it holds now is unfitted`,
      );
    }
    console.log('  ✓ every constant differs from its neutral value');
  }
}

// ── leave-one-out stability ────────────────────────────────────────────────
if (STABILITY) {
  // A grid where every value scores the same is not "stable", it is unmeasured: whichever value a
  // first-found argmax returns is arbitrary. So count three things per constant instead of
  // declaring a winner: folds where the grid is flat (no signal), folds where the current default
  // is beaten (evidence to change), and which single query carries the gain.
  console.log('\nleave-one-out: does nDCG distinguish the values at all, and who carries the gain?');
  for (const { grid } of results) {
    let flatFolds = 0;
    let defaultBeatenFolds = 0;
    const culprits = new Map();
    for (const entry of queries) {
      const subset = queries.filter((item) => item.id !== entry.id);
      const scored = grid.values.map((value) => {
        const cfg = grid.apply(value);
        const scores = subset.map((item) => {
          const { lists, judgements } = prepare(item);
          const ranked = fuseResults(item.query, lists, { now: NOW, limit: 10, weights: weightsFor(item.query, cfg.deltas), ...cfg.fusion });
          return ndcg(ranked, judgements);
        });
        return { value, score: mean(scores) };
      });
      const top = Math.max(...scored.map((item) => item.score));
      const bottom = Math.min(...scored.map((item) => item.score));
      if (top - bottom < 0.001) { flatFolds += 1; continue; }
      const best = scored.filter((item) => item.score >= top - 1e-9).map((item) => item.value);
      const current = scored.find((item) => item.value === grid.defaultValue);
      if (!best.includes(grid.defaultValue) && current.score < top - 0.001) {
        defaultBeatenFolds += 1;
        for (const value of best) culprits.set(value, (culprits.get(value) ?? 0) + 1);
      }
    }
    const verdict = flatFolds === queries.length
      ? 'no signal — nDCG is identical at every value'
      : defaultBeatenFolds === 0
        ? 'keep default — never beaten on held-out folds'
        : `default beaten in ${defaultBeatenFolds}/${queries.length} folds`;
    const who = [...culprits.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => `${value}×${count}`).join('  ');
    console.log(`  ${grid.label.padEnd(20)} ${verdict}${who ? `  (winner: ${who})` : ''}`);
  }

  // How much of the fitted gain is a single query? Report the nDCG difference with each query
  // removed, so a constant that only fixes one query cannot be mistaken for a broad improvement.
  const mergedDeltas = {};
  const mergedFusion = {};
  for (const { grid, best } of adopt) {
    if (grid.key in DEFAULT_DELTAS) mergedDeltas[grid.key] = best.value;
    else mergedFusion[grid.key] = best.value;
  }
  if (adopt.length) {
    console.log('\nwhere the adopted config gains, per query (and the total without that query):');
    const withCfg = evaluate({ deltas: mergedDeltas, fusion: mergedFusion });
    for (const row of withCfg.per) {
      const original = baseline.per.find((item) => item.id === row.id);
      const delta = row.ndcg - original.ndcg;
      if (Math.abs(delta) <= 0.0005) continue;
      const rest = mean(withCfg.per.filter((item) => item.id !== row.id).map((item) => item.ndcg)) -
        mean(baseline.per.filter((item) => item.id !== row.id).map((item) => item.ndcg));
      console.log(`  ${row.id.padEnd(18)} ${delta >= 0 ? '+' : ''}${delta.toFixed(3)}   without it: ${rest >= 0 ? '+' : ''}${rest.toFixed(3)}`);
    }
  }
}
