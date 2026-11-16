import { useState } from 'react';
import { ChevronDown, Filter } from 'lucide-react';
import { ENGINE_LABELS } from '../lib/engines';
import type { EngineIssue } from '../lib/engines';
import { laneContribution, summarizeLaneYield } from '../lib/fusion';
import type { LaneYield } from '../lib/fusion';

/**
 * What each engine gave and what the relevance gate kept, shown under the composer.
 *
 * Two kinds of loss, two kinds of chip: a lane that answered with nothing at all ("no results") and
 * a lane that answered but had results thrown away ("3/5"). The second is a button, because a count
 * cannot be judged — it expands to the titles the gate dropped with the coverage it judged them on,
 * lowest first, which is where an over-eager gate becomes visible.
 */
export function LaneYieldRow({
  laneYield = [],
  issues = [],
}: {
  /** per-engine yield from the last fusion */
  laneYield?: LaneYield[];
  /** the failure strip: an engine already explained there is not also called dead here */
  issues?: EngineIssue[];
}) {
  const explained = issues.filter((issue) => issue.severity === 'warning').map((issue) => issue.engine);
  const { dead, wasted } = laneContribution(summarizeLaneYield(laneYield), explained);
  /** the engine whose dropped results are listed, if any: the count alone is not judgeable */
  const [openDropped, setOpenDropped] = useState<string | null>(null);

  if (dead.length === 0 && wasted.length === 0) return null;

  const droppedRow = wasted.find((row) => row.engine === openDropped);
  const droppedList = [...(droppedRow?.dropped ?? [])].sort((a, b) => a.rel - b.rel);

  return (
    <div className="mb-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-text-muted">
        <Filter size={11} className="text-text-muted" />
        <span className="opacity-80">Lane yield</span>
        {dead.map((row) => {
          const label = ENGINE_LABELS.get(row.engine) ?? row.engine;
          return (
            <span
              key={`dead:${row.engine}`}
              title={`${label} answered this query with no results at all`}
              className="flex items-center gap-1 rounded border border-border-subtle bg-bg-elevated px-1.5 py-0.5 text-text-muted"
            >
              <span className="font-medium">{label}</span>
              <span className="opacity-80">no results</span>
            </span>
          );
        })}
        {wasted.map((row) => {
          const label = ENGINE_LABELS.get(row.engine) ?? row.engine;
          const open = openDropped === row.engine;
          return (
            <button
              type="button"
              key={row.engine}
              onClick={() => setOpenDropped(open ? null : row.engine)}
              aria-expanded={open}
              title={`${row.offTopic} of ${row.returned} results from ${label} were dropped by the relevance gate as off-topic — click to list them`}
              className="flex items-center gap-1 rounded border border-warning/30 bg-warning-subtle px-1.5 py-0.5 text-warning transition-colors hover:border-warning/60"
            >
              <span className="font-medium">{label}</span>
              <span className="opacity-80">
                {row.kept}/{row.returned}
              </span>
              <ChevronDown size={9} className={`opacity-70 transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
          );
        })}
      </div>
      {droppedRow && (
        <ul className="mt-1 space-y-0.5 rounded border border-border-subtle bg-bg-elevated px-2 py-1.5 text-[10px]">
          <li className="text-text-muted opacity-70">
            {ENGINE_LABELS.get(droppedRow.engine) ?? droppedRow.engine} — dropped by the gate, lowest coverage first
          </li>
          {droppedList.length === 0 && <li className="text-text-muted opacity-60">No titles recorded for this run.</li>}
          {droppedList.map((item, index) => (
            <li key={`${droppedRow.engine}:${index}`} className="flex items-baseline gap-1.5">
              <span className="tabular-nums text-text-muted opacity-60">{item.rel.toFixed(2)}</span>
              <span className="truncate text-text-secondary" title={item.title}>
                {item.title}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
