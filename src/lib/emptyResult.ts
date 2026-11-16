/**
 * The terminal state of a search that found nothing.
 *
 * Before this, an empty search still went to the model, which answered around the absence: a
 * confident paragraph with no source behind it, which is the one output a research tool must not
 * produce. A turn that collected nothing now ends in an explicit list of gaps — which engines
 * failed, which lanes came back empty, which lanes were emptied by the relevance gate — instead of
 * prose. Nothing here is generated, so it cannot invent anything.
 */
import { ENGINE_LABELS } from './engines';
import type { EngineIssue } from './engines';
import type { LaneYield } from './fusion';

export interface EmptyResultInput {
  query: string;
  /** the engines this search was asked to use */
  engines?: string[];
  /** engines that could not answer, from the function's `engine_status` */
  issues?: EngineIssue[];
  /** per-lane yield, where a lane that returned nothing is a gap in its own right */
  laneYield?: LaneYield[];
  /** how many dork queries ran, when this was a lane run */
  queries?: number;
}

export interface GapReport {
  /** the message body: a short statement, a gaps list, and no answer */
  body: string;
  /** the gap lines on their own, for tests and for anything that wants to render them apart */
  gaps: string[];
}

const label = (engine: string) => ENGINE_LABELS.get(engine) ?? engine;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function buildGapReport({
  query,
  engines = [],
  issues = [],
  laneYield = [],
  queries,
}: EmptyResultInput): GapReport {
  const gaps: string[] = [];

  // a setup or provider failure is the first thing worth naming: it explains the whole turn
  const failed = issues.filter((entry) => entry.severity === 'warning');
  for (const issue of failed) {
    gaps.push(`${issue.name} — ${issue.label}${issue.detail ? ` (${issue.detail})` : ''}`);
  }

  // an engine that failed already has its cause above; calling its lane dead as well would blame it
  // twice for one problem
  const explained = new Set(failed.map((issue) => issue.engine));
  for (const row of laneYield.filter((entry) => entry.returned === 0 && !explained.has(entry.engine))) {
    gaps.push(`${label(row.engine)} answered with nothing`);
  }
  for (const row of laneYield.filter((entry) => entry.returned > 0 && entry.kept === 0 && !explained.has(entry.engine))) {
    gaps.push(
      `${label(row.engine)} returned ${plural(row.returned, 'result', 'results')} and the relevance gate kept none of them`,
    );
  }

  if (gaps.length === 0) {
    gaps.push(
      engines.length > 0
        ? `every selected engine (${engines.map(label).join(', ')}) answered with nothing`
        : 'no engine was selected, so nothing was actually searched',
    );
  }

  const scope = engines.length > 0 ? ` across ${engines.map(label).join(', ')}` : '';
  const attempt = queries && queries > 1 ? plural(queries, 'dork query', 'dork queries') : 'A search';

  // a lane run has one lane per query per engine: the same gap must not be listed five times
  const unique = [...new Set(gaps)];

  const body = [
    `**No sources.** ${attempt} for “${query.trim()}”${scope} finished without a usable source, so there is no answer to give.`,
    '',
    '**Gaps**',
    ...unique.map((gap) => `- ${gap}`),
    '',
    'No answer is given because nothing collected here supports one. Widen the query, add an engine with a working key, or run a lane, then ask again.',
  ].join('\n');

  return { body, gaps: unique };
}
