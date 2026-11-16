import { useCallback, useEffect, useRef, useState } from 'react';
import { webSearch } from '../lib/api';
import { CLIENT_ENGINE_IDS, searchClientEngines } from '../lib/clientEngines';
import { describeLaneYield, fuseResultsDetailed, summarizeLaneYield } from '../lib/fusion';
import type { LaneYield } from '../lib/fusion';
import { RunGuard } from '../lib/runGuard';
import {
  DORK_ENGINES,
  fallbackEnginesFor,
  mergeEngineIssues,
  summarizeEngineStatus,
  type EngineIssue,
} from '../lib/engines';
import { expandLane } from '../lib/dorks';
import type { ActivityLog, ResearchPreset, Source } from '../types';

/**
 * What the activity row stores about a run's yield: per engine, the counts plus the titles the
 * gate threw away. Titles are capped so one bad engine cannot bloat the row.
 */
function laneYieldDetail(rows: LaneYield[]) {
  return rows.map((row) => ({
    engine: row.engine,
    returned: row.returned,
    kept: row.kept,
    offTopic: row.offTopic,
    dropped: (row.dropped ?? []).map((item) => item.title).slice(0, 10),
  }));
}

/**
 * Search orchestration: which engines run, how their lists are fused, which run owns the screen,
 * and how a superseded or cancelled run is prevented from writing over the current one.
 *
 * App keeps the things that are not search — the conversation, the transcript, the completion —
 * and passes them in, so nothing here touches messages or the model.
 */
export interface UseSearchOptions {
  engines: string[];
  useDorks: boolean;
  presets: ResearchPreset[];
  selectedPreset: string;
  /** a completion is streaming; a lane run must not start underneath it */
  isStreaming: boolean;
  logActivity: (
    conversationId: string,
    type: ActivityLog['activity_type'],
    description: string,
    details?: Record<string, unknown>,
    status?: ActivityLog['status'],
  ) => Promise<ActivityLog | null>;
  /** the conversation to search into, created on demand (a lane may want to title it) */
  ensureConversation: (title?: string) => Promise<string>;
  /** store the fused list; App owns the `sources` table and the panel */
  saveSources: (conversationId: string, results: Source[], originalQuery: string) => Promise<void>;
  /** stop a completion that the new run has made stale */
  abortStream: () => void;
  /** close a run's own activity row; App owns `activity_logs`, so it writes the update */
  closeActivity: (row: ActivityLog, description: string) => void;
}

export function useSearch({
  engines,
  useDorks,
  presets,
  selectedPreset,
  isStreaming,
  logActivity,
  ensureConversation,
  saveSources,
  abortStream,
  closeActivity,
}: UseSearchOptions) {
  const [results, setResults] = useState<Source[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [status, setStatus] = useState('');
  /** engines that could not answer (missing key, rejected key, unrecognised name) for the strip */
  const [issues, setIssues] = useState<EngineIssue[]>([]);
  /** per-engine counts from the last fusion: what each produced, and what the gate kept */
  const [laneYield, setLaneYield] = useState<LaneYield[]>([]);
  /** the relevance gate kept nothing, so the closest results were shown anyway */
  const [relaxedGate, setRelaxedGate] = useState(false);
  /** the query behind the current result set, so the panel can explain the ranking */
  const [lastQuery, setLastQuery] = useState('');
  /** the in-flight search, plus the gate deciding which run is still allowed to write */
  const guardRef = useRef<RunGuard | null>(null);
  if (guardRef.current === null) guardRef.current = new RunGuard();
  const guard = guardRef.current;

  const engineSignature = engines.join(',');

  // A run belongs to the engine set it started with: changing the set supersedes it and aborts the
  // fetch, so a slow engine from the old set cannot land on top of the new one's results. The stale
  // "exa: missing key" must not outlive the selection either.
  useEffect(() => {
    const wasRunning = guard.supersede();
    setIssues([]);
    setIsSearching(false);
    setStatus('');
    // partial results belong to the aborted run, not to the engine set the user just picked; a
    // completed result set is left alone, because tweaking engines after reading results is normal
    if (wasRunning) {
      setResults([]);
      setLaneYield([]);
      setLastQuery('');
    }
  }, [engineSignature, guard]);

  const clearResults = useCallback(() => {
    setResults([]);
    setStatus('');
    setIssues([]);
    setLaneYield([]);
    setRelaxedGate(false);
  }, []);

  const performSearch = useCallback(
    async (query: string, convId: string): Promise<Source[]> => {
      // a new search owns the result list: supersede the previous run so a slow engine cannot
      // overwrite fresher results when it finally answers
      const run = guard.begin();
      const controller = run.controller;
      const isCurrent = run.isCurrent;
      // and an answer still streaming from the previous question is about to be stale too
      abortStream();

      setIsSearching(true);
      setLastQuery(query);
      setIssues([]);
      const preset = presets.find((p) => p.name === selectedPreset);
      const enginesToUse = engines.length > 0 ? engines : (preset?.config.engines ?? ['duckduckgo', 'wikipedia', 'arxiv', 'github']);
      const maxResults = preset?.config.max_results ?? 5;

      await logActivity(convId, 'plan', `Compiling search strategy for: "${query}"`, { preset: selectedPreset, engines: enginesToUse });
      const searchLog = await logActivity(
        convId,
        'search',
        `Searching across ${enginesToUse.length} engines`,
        { engines: enginesToUse, useDorks },
        'running',
      );

      try {
        const serverEngines = enginesToUse.filter((engine) => !CLIENT_ENGINE_IDS.has(engine));
        const browserEngines = enginesToUse.filter((engine) => CLIENT_ENGINE_IDS.has(engine));

        // clear the map for this run, then let engines stream their nodes in as they answer
        setResults([]);
        setLaneYield([]);
        const [serverResponse, browserResults] = await Promise.all([
          serverEngines.length > 0
            ? webSearch(query, serverEngines, maxResults, useDorks, selectedPreset, true, controller.signal).then((response) => {
                if (!isCurrent()) return response;
                if (response?.results?.length) {
                  setResults((previous) => [...previous, ...response.results]);
                }
                setIssues(summarizeEngineStatus(response?.engine_status));
                return response;
              })
            : null,
          searchClientEngines(
            query,
            browserEngines,
            maxResults,
            (_engine, items) => {
              if (isCurrent()) setResults((previous) => [...previous, ...items]);
            },
            controller.signal,
          ),
        ]);

        // a superseded run must not touch the list, the map or the database
        if (!isCurrent()) return [];

        let gathered = [...(serverResponse?.results ?? []), ...browserResults];
        let spareEngines: string[] = [];

        // An empty page is not a result page. If every selected engine answered with nothing, ask
        // the keyless set once, so a missing provider key degrades the ranking instead of blanking
        // the screen.
        if (gathered.length === 0) {
          const spare = fallbackEnginesFor(enginesToUse);
          if (spare.length > 0) {
            const spareServer = spare.filter((engine) => !CLIENT_ENGINE_IDS.has(engine));
            const spareBrowser = spare.filter((engine) => CLIENT_ENGINE_IDS.has(engine));
            const [spareResponse, spareResults] = await Promise.all([
              spareServer.length > 0
                ? webSearch(query, spareServer, maxResults, useDorks, selectedPreset, false, controller.signal)
                : null,
              searchClientEngines(
                query,
                spareBrowser,
                maxResults,
                (_engine, items) => {
                  if (isCurrent()) setResults((previous) => [...previous, ...items]);
                },
                controller.signal,
              ),
            ]);
            if (!isCurrent()) return [];
            if (spareResponse?.engine_status) {
              setIssues((previous) => mergeEngineIssues(previous, summarizeEngineStatus(spareResponse.engine_status)));
            }
            if (spareResults.length > 0) {
              gathered = [...(spareResponse?.results ?? []), ...spareResults];
              spareEngines = spare;
              await logActivity(
                convId,
                'search',
                `The selected engines found nothing — retried the keyless set and got ${gathered.length}`,
                { fallback_engines: spare },
                'completed',
              );
            }
          }
        }

        // group every engine's ranking separately, then fuse across them. Seeding each engine that
        // ran turns "answered with nothing" into a 0 lane in the yield report instead of a gap.
        const perEngine: Record<string, Source[]> = {};
        for (const engine of [...enginesToUse, ...spareEngines]) perEngine[engine] = [];
        for (const item of gathered) {
          const engine = item.source_engine || 'unknown';
          (perEngine[engine] ??= []).push(item);
        }
        const { results: fused, laneYield: yields, relaxed } = fuseResultsDetailed(query, perEngine, { limit: 40 });
        if (!isCurrent()) return [];

        const yieldReport = summarizeLaneYield(yields);
        setResults(fused);
        setLaneYield(yieldReport);
        setRelaxedGate(relaxed);

        await logActivity(convId, 'rank', `Reciprocal Rank Fusion applied to ${fused.length} results`, {
          engines_used: [...(serverResponse?.engines_used ?? []), ...browserEngines, ...spareEngines],
          queries_used: serverResponse?.queries_used ?? [query],
        });
        // the composer's lane strip disappears with the next search; the trail keeps what the gate
        // cost this engine, and which results it cost
        await logActivity(convId, 'rank', describeLaneYield(yieldReport, relaxed), {
          lane_yield: laneYieldDetail(yieldReport),
          gate_relaxed: relaxed,
        });
        await logActivity(convId, 'deduplicate', `Deduplicated and scored ${fused.length} unique sources`);

        if (fused.length > 0) await saveSources(convId, fused, query);

        // Update the search activity to completed
        if (searchLog) closeActivity(searchLog, 'Search completed');

        return fused;
      } catch (err) {
        // an aborted or superseded run is not a failure: the row it owns is closed in `finally`
        if (controller.signal.aborted || !isCurrent()) return [];
        console.error('Search error:', err);
        setResults([]);
        setLaneYield([]);
        await logActivity(convId, 'search', `Search failed: ${err instanceof Error ? err.message : 'unknown'}`, {}, 'failed');
        return [];
      } finally {
        if (isCurrent()) {
          setIsSearching(false);
        } else if (searchLog) {
          // the row belongs to this run, so it closes it — as a cancel or as a supersession, never
          // left spinning because a newer run owns the screen
          closeActivity(
            searchLog,
            controller.signal.aborted ? 'Search cancelled' : 'Search superseded by a newer run',
          );
        }
      }
    },
    [engines, useDorks, presets, selectedPreset, logActivity, saveSources, abortStream, closeActivity, guard],
  );

  /** true when the run that just finished was superseded or cancelled: its answer is stale */
  const runAborted = useCallback(() => guard.aborted, [guard]);

  const cancelSearch = useCallback(() => {
    // superseding, not merely aborting: the signal alone cannot stop an engine that ignores it
    if (!guard.supersede()) return false;
    setStatus('Search cancelled');
    setIsSearching(false);
    return true;
  }, [guard]);

  /**
   * Batch a whole dork lane: every template in the lane becomes its own query against the
   * selected engines, and the union is ranked once through the fusion layer. Queries are
   * kept as separate ranking lists (`engine·q3`) so a page matched by several dork patterns
   * outranks one that a single pattern happened to surface.
   */
  const runLane = useCallback(
    async (lane: string, target: string) => {
      const cleanTarget = target.trim();
      if (!cleanTarget || isSearching || isStreaming) return;
      const queries = expandLane(lane, cleanTarget, 10);
      if (queries.length === 0) return;

      // a lane run is a search too: superseding the previous run keeps a slow lane from landing on
      // top of whatever the user asked for next
      const run = guard.begin();
      const controller = run.controller;
      const isLaneCurrent = run.isCurrent;

      const conversationId = await ensureConversation(`${lane}: ${cleanTarget}`);

      const preset = presets.find((p) => p.name === selectedPreset);
      const enginesToUse = engines.length > 0 ? engines : (preset?.config.engines ?? ['duckduckgo', 'wikipedia', 'arxiv', 'github']);
      const maxResults = Math.max(3, preset?.config.max_results ?? 5);
      // Dork lanes only make sense on engines that parse operators; the rest would fill the
      // results with plain-text matches and bury the actual dork hits.
      const dorkCapable = enginesToUse.filter((engine) => DORK_ENGINES.has(engine));
      const laneEngines = dorkCapable.length > 0 ? dorkCapable : enginesToUse;
      const serverEngines = laneEngines.filter((engine) => !CLIENT_ENGINE_IDS.has(engine));
      const browserEngines = laneEngines.filter((engine) => CLIENT_ENGINE_IDS.has(engine));

      setIsSearching(true);
      setResults([]);
      setIssues([]);
      setLaneYield([]);
      setRelaxedGate(false);
      setStatus(`Lane "${lane}" — starting ${queries.length} queries`);
      await logActivity(
        conversationId,
        'plan',
        `Batch lane "${lane}": ${queries.length} dork queries against ${cleanTarget}`,
        { lane, queries, engines: laneEngines },
        'running',
      );
      if (dorkCapable.length === 0) {
        await logActivity(
          conversationId,
          'search',
          'None of the selected engines parse dork operators — results will mostly be plain-text matches. DuckDuckGo, Brave, Google, Exa, SearXNG and Tavily do.',
          { engines: laneEngines },
          'completed',
        );
      }

      // one lane per engine per query, seeded empty so a dead lane reports 0 rather than vanishing
      const perEngineQuery: Record<string, Source[]> = {};
      for (let index = 0; index < queries.length; index += 1) {
        for (const engine of laneEngines) perEngineQuery[`${engine}·q${index}`] = [];
      }
      let finished = 0;

      const runQuery = async (query: string, index: number) => {
        if (controller.signal.aborted) return;
        try {
          const [server, browser] = await Promise.all([
            serverEngines.length > 0
              ? webSearch(query, serverEngines, maxResults, true, selectedPreset, false, controller.signal)
              : null,
            searchClientEngines(query, browserEngines, maxResults, (_engine, items) => {
              if (isLaneCurrent()) setResults((previous) => [...previous, ...items]);
            }, controller.signal),
          ]);
          if (controller.signal.aborted) return;
          const serverItems = server?.results ?? [];
          if (serverItems.length) setResults((previous) => [...previous, ...serverItems]);
          if (server?.engine_status) {
            setIssues((previous) => mergeEngineIssues(previous, summarizeEngineStatus(server.engine_status)));
          }
          // silent-empty patterns are the useful signal in a lane run
          if (serverItems.length + browser.length === 0) {
            await logActivity(conversationId, 'search', `No results for dork: ${query}`, { query }, 'completed');
          }
          for (const item of [...serverItems, ...browser]) {
            const key = `${item.source_engine || 'unknown'}·q${index}`;
            (perEngineQuery[key] ??= []).push(item);
          }
        } catch (err) {
          await logActivity(conversationId, 'search', `Dork query failed: ${query}`, {}, 'failed');
        } finally {
          finished += 1;
          setStatus(`Lane "${lane}" — ${finished}/${queries.length} queries`);
        }
      };

      try {
        // two queries in flight at a time keeps provider rate limits happy
        const queue = queries.map((query, index) => ({ query, index }));
        const worker = async () => {
          for (;;) {
            if (controller.signal.aborted) return;
            const next = queue.shift();
            if (!next) return;
            await runQuery(next.query, next.index);
          }
        };
        await Promise.all(Array.from({ length: Math.min(2, queries.length) }, worker));

        const { results: fused, laneYield: yields, relaxed } = fuseResultsDetailed(cleanTarget, perEngineQuery, { limit: 60 });
        if (!isLaneCurrent()) return;
        const laneReport = summarizeLaneYield(yields);
        setResults(fused);
        setLaneYield(laneReport);
        setRelaxedGate(relaxed);
        await logActivity(conversationId, 'rank', `${queries.length} dork queries fused into ${fused.length} unique sources`, { lane, queries }, 'completed');
        await logActivity(conversationId, 'rank', describeLaneYield(laneReport, relaxed), {
          lane,
          lane_yield: laneYieldDetail(laneReport),
          gate_relaxed: relaxed,
        });
        if (fused.length === 0) {
          await logActivity(
            conversationId,
            'search',
            `Lane "${lane}" returned no sources. The engines that honour dorks may be rate-limited or unconfigured (Exa, SearXNG, Google and Tavily need secrets on the search function).`,
            { lane, engines: laneEngines },
            'failed',
          );
        }

        if (fused.length > 0) await saveSources(conversationId, fused, `${lane}: ${cleanTarget}`);
      } finally {
        if (isLaneCurrent()) {
          setIsSearching(false);
          setStatus('');
        }
      }
    },
    [engines, presets, selectedPreset, isSearching, isStreaming, logActivity, ensureConversation, saveSources, guard],
  );

  return {
    /** the fused list the panel renders */
    results,
    isSearching,
    status,
    issues,
    laneYield,
    relaxedGate,
    lastQuery,
    performSearch,
    cancelSearch,
    runLane,
    runAborted,
    clearResults,
  };
}
