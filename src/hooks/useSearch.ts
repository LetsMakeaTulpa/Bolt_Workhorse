import { useCallback, useEffect, useRef, useState } from 'react';
import { webSearch } from '../lib/api';
import { CLIENT_ENGINE_IDS, searchClientEngines } from '../lib/clientEngines';
import { fuseResultsDetailed, summarizeLaneYield } from '../lib/fusion';
import type { LaneYield } from '../lib/fusion';
import { DORK_ENGINES, mergeEngineIssues, summarizeEngineStatus, type EngineIssue } from '../lib/engines';
import { expandLane } from '../lib/dorks';
import type { ActivityLog, ResearchPreset, Source } from '../types';

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
  /** the query behind the current result set, so the panel can explain the ranking */
  const [lastQuery, setLastQuery] = useState('');
  /** the in-flight search; a newer run aborts it so stale results cannot land on top */
  const runRef = useRef<AbortController | null>(null);

  // a stale "exa: missing key" must not survive the user enabling a different engine set
  useEffect(() => {
    setIssues([]);
  }, [engines.join(',')]);

  const clearResults = useCallback(() => {
    setResults([]);
    setStatus('');
    setIssues([]);
    setLaneYield([]);
  }, []);

  const performSearch = useCallback(
    async (query: string, convId: string): Promise<Source[]> => {
      // a new search owns the result list: cancel the previous run so a slow engine cannot
      // overwrite fresher results when it finally answers
      runRef.current?.abort();
      // and an answer still streaming from the previous question is about to be stale too
      abortStream();
      const controller = new AbortController();
      runRef.current = controller;
      const isCurrent = () => runRef.current === controller;

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

        // group every engine's ranking separately, then fuse across them. Seeding each engine that
        // ran turns "answered with nothing" into a 0 lane in the yield report instead of a gap.
        const perEngine: Record<string, Source[]> = {};
        for (const engine of enginesToUse) perEngine[engine] = [];
        for (const item of [...(serverResponse?.results ?? []), ...browserResults]) {
          const engine = item.source_engine || 'unknown';
          (perEngine[engine] ??= []).push(item);
        }
        const { results: fused, laneYield: yields } = fuseResultsDetailed(query, perEngine, { limit: 40 });
        if (!isCurrent()) return [];

        setResults(fused);
        setLaneYield(summarizeLaneYield(yields));

        await logActivity(convId, 'rank', `Reciprocal Rank Fusion applied to ${fused.length} results`, {
          engines_used: [...(serverResponse?.engines_used ?? []), ...browserEngines],
          queries_used: serverResponse?.queries_used ?? [query],
        });
        await logActivity(convId, 'deduplicate', `Deduplicated and scored ${fused.length} unique sources`);

        if (fused.length > 0) await saveSources(convId, fused, query);

        // Update the search activity to completed
        if (searchLog) closeActivity(searchLog, 'Search completed');

        return fused;
      } catch (err) {
        // an aborted run is not a failure: the search that replaced it owns the status line
        if (controller.signal.aborted || !isCurrent()) {
          // ...but the row belongs to this run, so a user cancel has to close it itself
          if (controller.signal.aborted && isCurrent() && searchLog) closeActivity(searchLog, 'Search cancelled');
          return [];
        }
        console.error('Search error:', err);
        setResults([]);
        setLaneYield([]);
        await logActivity(convId, 'search', `Search failed: ${err instanceof Error ? err.message : 'unknown'}`, {}, 'failed');
        return [];
      } finally {
        if (isCurrent()) {
          setIsSearching(false);
        } else if (searchLog) {
          // the newer run has its own activity row; this one must not spin forever
          closeActivity(searchLog, 'Search superseded by a newer run');
        }
      }
    },
    [engines, useDorks, presets, selectedPreset, logActivity, saveSources, abortStream, closeActivity],
  );

  /** true when the run that just finished was superseded or cancelled: its answer is stale */
  const runAborted = useCallback(() => Boolean(runRef.current?.signal.aborted), []);

  const cancelSearch = useCallback(() => {
    const running = runRef.current;
    if (!running || running.signal.aborted) return false;
    running.abort();
    setStatus('Search cancelled');
    setIsSearching(false);
    return true;
  }, []);

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

      // a lane run is a search too: cancelling the previous run keeps a slow lane from landing on
      // top of whatever the user asked for next
      runRef.current?.abort();
      const controller = new AbortController();
      runRef.current = controller;
      const isLaneCurrent = () => runRef.current === controller;

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

        const { results: fused, laneYield: yields } = fuseResultsDetailed(cleanTarget, perEngineQuery, { limit: 60 });
        if (!isLaneCurrent()) return;
        setResults(fused);
        setLaneYield(summarizeLaneYield(yields));
        await logActivity(conversationId, 'rank', `${queries.length} dork queries fused into ${fused.length} unique sources`, { lane, queries }, 'completed');
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
    [engines, presets, selectedPreset, isSearching, isStreaming, logActivity, ensureConversation, saveSources],
  );

  return {
    /** the fused list the panel renders */
    results,
    isSearching,
    status,
    issues,
    laneYield,
    lastQuery,
    performSearch,
    cancelSearch,
    runLane,
    runAborted,
    clearResults,
  };
}
