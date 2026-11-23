import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearch } from './hooks/useSearch';
import { useEngineKeys } from './hooks/useEngineKeys';
import { supabase } from './lib/supabase';
import { fetchModels, fallbackChain, DORK_TOOL, SEARCH_TOOL, streamTurn, type ChatStreamCallbacks } from './lib/api';
import { runSearchToolLoop, type ToolMessage } from './lib/searchTool';
import { DEFAULT_ENGINES, SEARCH_SCOPES } from './lib/engines';
import { describePromptVariant, readPromptVariant, systemPromptFor } from './lib/promptVariant';
import { buildGapReport } from './lib/emptyResult';
import type {
  Conversation, Message, Source, ModelInfo, Finding,
  ResearchPreset, ActivityLog, SourceRecord, ToolSearchYield,
} from './types';
import { Sidebar } from './components/Sidebar';
import { ChatArea } from './components/ChatArea';
import { InvestigationPanel, type PanelTab } from './components/InvestigationPanel';
import type { ModelNotice } from './components/ModelNotice';
import { readEmptyResultBlock, writeEmptyResultBlock } from './lib/emptyResultPref';
import { FOLLOW_UP_CONTENT_CHARS, formatSourceContext, PROMPT_CONTENT_CHARS, promptReasonFor } from './lib/sourceContext';
import { readPanelCollapsed, writePanelCollapsed } from './lib/panelPref';
import { promptCoverage } from './lib/machineTrace';
import { ModelSelector } from './components/ModelSelector';
import { SettingsModal } from './components/SettingsModal';
import { PresetSelector } from './components/PresetSelector';
import { AuthScreen } from './components/AuthScreen';
import type { Session } from '@supabase/supabase-js';
import { Menu, Settings, Search, Compass, PanelRightClose, PanelRight, Activity, Globe, Shield, Radar, LogOut, Loader2 } from 'lucide-react';
import { decideAfterSearch, STOPPED_SEARCH_NOTE, SUPERSEDED_SEARCH_NOTE } from './lib/turnDecision';
import { reuseForRetry } from './lib/reuseSources';
import { insertRowTolerant, noteDroppedColumns, retryLinkFor, updateRowTolerant } from './lib/messageInsert';
import { runToolSearch as executeToolSearch } from './lib/toolSearch';
import type { RunRecord } from './lib/runRecord';

const DEFAULT_MODEL = 'xortron/RESTRICTED-RESEARCH-MODEL';

/** Appended to an answer the user stopped mid-stream: the row must never read as finished prose. */
const STOPPED_NOTE = '_(Stopped before completion — this is a partial answer.)_';

/**
 * Said once per session when the run store is missing or refusing writes. Per session rather than
 * per run: a warning on every search would bury the transcript it is describing.
 */
let runStoreWarned = false;

export default function App() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentConversation, setCurrentConversation] = useState<Conversation | null>(null);
  /** the conversation this client just created for the turn it is about to send */
  const skipInitialLoadRef = useRef<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL);
  const [isStreaming, setIsStreaming] = useState(false);
  /** the model that answered, when it was not the one selected — shown above the transcript */
  const [modelNotice, setModelNotice] = useState<ModelNotice | null>(null);
  /** whether an empty search ends in the gap-report block or in an answer */
  const [emptyResultBlock, setEmptyResultBlock] = useState(readEmptyResultBlock);
  const [searchEnabled, setSearchEnabled] = useState(true);
  const [engines, setEngines] = useState<string[]>(DEFAULT_ENGINES);
  /** the in-flight completion; stopping or replacing a run must stop the model too */
  const streamRunRef = useRef<AbortController | null>(null);
  const [useDorks, setUseDorks] = useState(false);
  /** a dork pressed in an answer, handed to the composer; null when nothing is waiting */
  const [dorkDraft, setDorkDraft] = useState<string | null>(null);
  const [rawSearchOnly, setRawSearchOnly] = useState(false);
  const [findings, setFindings] = useState<Finding[]>([]);
  // where the panel was left last time: a collapsed panel that reopens on every reload is a panel
  // that has to be closed again on every reload
  const [showSearchPanel, setShowSearchPanel] = useState(() => !readPanelCollapsed());
  const [panelTab, setPanelTab] = useState<PanelTab>('map');
  /**
   * The citation selected on either side — a marker in the newest answer or a card in the panel.
   * One id is all it takes: both directions already read the mapping the grounding pass builds, so
   * no new row or column is stored for a selection.
   */
  const [citationFocus, setCitationFocus] = useState<string | null>(null);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [presets, setPresets] = useState<ResearchPreset[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<string>('general');
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);
  const [sources, setSources] = useState<SourceRecord[]>([]);
  /** what the last search-only re-run found, per post, so the post can say what it changed */
  const [rerunReports, setRerunReports] = useState<Record<string, { query: string; results: Source[] }>>({});
  const [streamingContent, setStreamingContent] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Supabase Auth owns identity; RLS does the rest. Nothing loads until there is a session.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => listener.subscription.unsubscribe();
  }, []);

  const userId = session?.user.id;

  // Load per-account data whenever the signed-in user changes (and clear it on sign-out).
  useEffect(() => {
    if (!userId) {
      setConversations([]);
      setCurrentConversation(null);
      setMessages([]);
      setFindings([]);
      setSources([]);
      setActivityLogs([]);
      clearSearchResults();
      return;
    }
    loadConversations();
    loadPresets();
    loadFindings();
    handleNewChat();
  }, [userId]);

  useEffect(() => {
    fetchModels()
      .then(({ models: m, default_model }) => {
        if (m.length > 0) {
          setModels(m);
          setSelectedModel(default_model);
        }
      })
      .catch((err) => console.error('Failed to load models:', err));
  }, []);

  useEffect(() => {
    if (currentConversation) {
      // A conversation created for the question in flight has no rows to load yet. Fetching it here
      // raced the user-row insert: an empty answer wiped the question from the transcript, and with
      // it the `query` the answer needs for its freshness receipt.
      if (skipInitialLoadRef.current === currentConversation.id) skipInitialLoadRef.current = null;
      else loadMessages(currentConversation.id);
      loadActivityLogs(currentConversation.id);
      loadSources(currentConversation.id);
      setSelectedModel(currentConversation.model);
      if (currentConversation.preset) setSelectedPreset(currentConversation.preset);
    } else {
      setMessages([]);
      clearSearchResults();
      setActivityLogs([]);
      setSources([]);
    }
  }, [currentConversation]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  const loadConversations = async () => {
    const { data } = await supabase.from('conversations').select('*').order('updated_at', { ascending: false });
    if (data) setConversations(data as Conversation[]);
  };

  const loadMessages = async (conversationId: string) => {
    const { data } = await supabase
      .from('messages').select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });
    if (data) {
      for (const row of data as Message[]) persistedIds.current.add(row.id);
      setMessages(data as Message[]);
    }
  };

  const loadFindings = async () => {
    const { data } = await supabase
      .from('findings').select('*')
      .eq('status', 'saved')
      .order('created_at', { ascending: false }).limit(50);
    if (data) setFindings(data as Finding[]);
  };

  const loadPresets = async () => {
    const { data } = await supabase.from('research_presets').select('*').order('category', { ascending: true });
    if (data) setPresets(data as ResearchPreset[]);
  };

  const loadActivityLogs = async (conversationId: string) => {
    const { data } = await supabase
      .from('activity_logs').select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false }).limit(30);
    if (data) setActivityLogs(data as ActivityLog[]);
  };

  const loadSources = async (conversationId: string) => {
    const { data } = await supabase
      .from('sources').select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false }).limit(50);
    if (data) setSources(data as SourceRecord[]);
  };

  const logActivity = async (conversationId: string, type: ActivityLog['activity_type'], description: string, details: Record<string, unknown> = {}, status: ActivityLog['status'] = 'completed') => {
    const { data } = await supabase
      .from('activity_logs')
      .insert({ conversation_id: conversationId, activity_type: type, description, details, status })
      .select().single();
    if (data) setActivityLogs((prev) => [data as ActivityLog, ...prev].slice(0, 30));
    // returning the row lets a caller close its own entry when the run is superseded
    return (data as ActivityLog) ?? null;
  };

  const createConversation = async (): Promise<Conversation> => {
    const { data, error } = await supabase
      .from('conversations')
      .insert({ title: 'New Investigation', model: selectedModel, preset: selectedPreset })
      .select().single();
    if (error) throw error;
    const conv = data as Conversation;
    setConversations((prev) => [conv, ...prev]);
    return conv;
  };

  const handleNewChat = () => {
    setCurrentConversation(null);
    setMessages([]);
    clearSearchResults();
    setStreamingContent('');
    setActivityLogs([]);
    setSources([]);
  };

  const handleSelectConversation = (conv: Conversation) => setCurrentConversation(conv);

  const handleDeleteConversation = async (id: string) => {
    await supabase.from('conversations').delete().eq('id', id);
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (currentConversation?.id === id) handleNewChat();
  };

  const closeActivity = (row: ActivityLog, description: string) => {
    setActivityLogs((prev) =>
      prev.map((entry) => (entry.id === row.id ? { ...entry, status: 'completed', description } : entry)),
    );
    void supabase.from('activity_logs').update({ status: 'completed', description }).eq('id', row.id);
  };

  /** the conversation a search writes into, created (and titled) on demand */
  const ensureSearchConversation = async (title?: string): Promise<string> => {
    if (currentConversation?.id) return currentConversation.id;
    const conv = await createConversation();
    setCurrentConversation(conv);
    if (title) await supabase.from('conversations').update({ title }).eq('id', conv.id);
    return conv.id;
  };

  const saveSearchSources = async (conversationId: string, results: Source[], originalQuery: string) => {
    const rows = results.map((r, i) => ({
      conversation_id: conversationId,
      title: r.title,
      url: r.url,
      snippet: r.snippet,
      provider: r.source_engine,
      original_query: originalQuery,
      publication_date: r.published ?? '',
      relevance_score: r.relevance_score ?? 0,
      citation_id: r.citation_id ?? `[${i + 1}]`,
      // the score's components travel with the row, so the panel can still explain the order after
      // a reload, when only the stored rows exist
      metadata: {
        ...(r.score_terms ? { score_terms: r.score_terms } : {}),
        ...(r.coverage_quota ? { coverage_quota: true } : {}),
      },
      // the row records whether this source came back with page text or only a snippet
      extraction_status: r.content ? 'extracted' : 'pending',
      source_type: r.source_engine === 'arxiv' || r.source_engine === 'openalex' ? 'academic' : 'web',
    }));
    const { data } = await supabase.from('sources').insert(rows).select();
    if (data) setSources((previous) => [...(data as SourceRecord[]), ...previous].slice(0, 50));
  };

  const abortStream = useCallback(() => streamRunRef.current?.abort(), []);

  /** the newest question owns the transcript; an older turn steps aside instead of answering over it */
  const turnRef = useRef(0);

  /**
   * Ids whose rows the database accepted, loaded or inserted this session.
   *
   * `messages.retry_of` is a foreign key to `messages(id)` and each row is saved under the id the
   * transcript renders, so a link is written when — and only when — its target is really in the table.
   */
  const persistedIds = useRef<Set<string>>(new Set());

  /** Collapse or open the panel, and remember the choice on this device. */
  const setPanelOpen = useCallback((open: boolean) => {
    setShowSearchPanel(open);
    writePanelCollapsed(!open);
  }, []);

  // names only: the composer shows which providers are configured, never a value
  const {
    names: storedKeyNames,
    unavailable: keysUnavailable,
    deployment: deploymentKeyNames,
    refresh: refreshKeyNames,
  } = useEngineKeys(session?.user?.id);

  /**
   * Keep the per-lane lists of a run.
   *
   * A run that cannot be stored must not fail the search that produced it, so this warns once per
   * session instead of throwing: the answers are still on screen, and the gap is named rather than
   * hidden behind a working search.
   */
  const saveSearchRun = async (conversationId: string, run: RunRecord) => {
    const { error } = await supabase.from('search_runs').insert({
      conversation_id: conversationId,
      query: run.query,
      kind: run.kind,
      engines: run.engines,
      queries_used: run.queries,
      lanes: run.lanes,
      lanes_hash: run.lanesHash,
    });
    if (error && !runStoreWarned) {
      runStoreWarned = true;
      console.warn(`[fieldwork] search runs are not being stored: ${error.message} (apply the pending migration)`);
    }
  };

  const {
    results: searchResults,
    isSearching,
    status: searchStatus,
    issues: engineIssues,
    laneYield,
    relaxedGate,
    forcedRecency,
    queriesUsed,
    lastQueries,
    lastQuery: lastSearchQuery,
    performSearch,
    cancelSearch: cancelSearchRun,
    runLane: handleRunLane,
    runAborted,
    runCancelled,
    clearResults: clearSearchResults,
  } = useSearch({
    engines,
    useDorks,
    presets,
    selectedPreset,
    isStreaming,
    logActivity,
    ensureConversation: ensureSearchConversation,
    saveSources: saveSearchSources,
    saveRun: saveSearchRun,
    abortStream,
    closeActivity,
  });

  /** stop a search or a completion, whichever is running */
  const cancelSearch = () => {
    cancelSearchRun();
    abortStream();
  };

  const handleSendMessage = async (
    content: string,
    options?: { forceSearch?: boolean; reused?: Source[] | null; retryOf?: string },
  ) => {
    if (!content.trim() || isStreaming) return;
    // a notice belongs to the answer it describes, not to the next question
    setModelNotice(null);
    // so does a citation selection: the ids are about to be assigned again
    setCitationFocus(null);
    // a retry that already has its sources still wants the answer pipeline, even with search off
    const reused = options?.reused ?? [];
    const shouldSearch = searchEnabled || options?.forceSearch === true || reused.length > 0;
    const turnId = turnRef.current + 1;
    turnRef.current = turnId;
    const turnSuperseded = () => turnRef.current !== turnId;
    // A link to a row that was never saved is rejected by the foreign key, and the question would be
    // lost with it; only an id the database accepted is named.
    const retryOf = retryLinkFor(options?.retryOf, persistedIds.current);

    let conv = currentConversation;
    if (!conv) {
      conv = await createConversation();
      skipInitialLoadRef.current = conv.id;
      setCurrentConversation(conv);
    }

    const userMsg: Message = {
      id: crypto.randomUUID(),
      conversation_id: conv.id,
      role: 'user',
      content,
      search_enabled: shouldSearch,
      search_results: [],
      // a retried turn says which attempt it replaces, so the transcript can link the two
      retry_of: retryOf,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);

    // Tolerant, like the answers: a database without the column keeps the question and the retry.
    // The row keeps the id the transcript already renders, so the link names a real row and both
    // anchors still match after a reload.
    const savedQuestion = await insertRowTolerant<Message>(supabase, 'messages', {
      id: userMsg.id,
      conversation_id: conv.id,
      role: 'user',
      content,
      search_enabled: shouldSearch,
      retry_of: retryOf,
    });
    if (!savedQuestion.error) persistedIds.current.add(userMsg.id);
    // A database without `retry_of` keeps the question and drops the link, which would leave the
    // transcript reading as a first attempt; say so in the trail instead of losing it quietly. A row
    // that carried no link has nothing to report, so the column is only named when one was attempted.
    await noteDroppedColumns(
      retryOf ? savedQuestion.dropped : savedQuestion.dropped.filter((column) => column !== 'retry_of'),
      async (message, detail) => {
        await logActivity(conv.id, 'analyze', message, detail, 'completed');
      },
    );

    if (messages.length === 0) {
      const title = content.substring(0, 50) + (content.length > 50 ? '...' : '');
      await supabase.from('conversations').update({ title, updated_at: new Date().toISOString() }).eq('id', conv.id);
      setConversations((prev) => prev.map((c) => (c.id === conv!.id ? { ...c, title } : c)));
    }

    let searchResultsData: Source[] = [];
    // the words the search really sent, kept with the answer so the transcript can show the prompt's
    // question rather than the one on screen: empty when this turn ran no search
    let compiledQueries: string[] = [];
    // Why this turn found nothing, kept for the transcript as well as the trail: the answer is
    // labelled unverified, and the gaps are the explanation that label leaves out.
    let gapLines: string[] = [];
    if (shouldSearch && reused.length > 0) {
      // Retry after the sources were already retrieved: regenerate from that same list instead of
      // asking every engine again. Same sources and citation ids, no provider cost, and nothing new
      // to confuse a comparison with the attempt that failed.
      searchResultsData = reused;
      await logActivity(
        conv.id,
        'search',
        `Reusing ${reused.length} source${reused.length === 1 ? '' : 's'} already retrieved — answering without querying an engine`,
        { sources: reused.length, reused: true },
        'completed',
      );
    } else if (shouldSearch) {
      searchResultsData = await performSearch(content, conv.id);
      compiledQueries = lastQueries();
      // A stopped or replaced search used to end the turn right here, with nothing under the
      // question: that reads as the app not answering at all, and it is what left people asking
      // whether the app had broken. Decide explicitly instead, and every outcome is visible:
      // answer from the model, or leave a line that says why there is no answer.
      const afterSearch = decideAfterSearch({
        aborted: runAborted(),
        cancelled: runCancelled(),
        superseded: turnSuperseded(),
      });
      if (afterSearch !== 'answer') {
        const replaced = afterSearch === 'superseded-note';
        await logActivity(
          conv.id,
          'search',
          replaced
            ? 'Search replaced by a newer question — this turn was not answered'
            : 'Search stopped before it returned a source',
          { superseded: replaced },
          'completed',
        );
        const noteContent = replaced ? SUPERSEDED_SEARCH_NOTE : STOPPED_SEARCH_NOTE;
        const localId = crypto.randomUUID();
        setMessages((prev) => [
          ...prev,
          {
            id: localId,
            conversation_id: conv.id,
            role: 'assistant',
            content: noteContent,
            model: selectedModel,
            search_enabled: searchEnabled,
            search_results: [],
            created_at: new Date().toISOString(),
          },
        ]);
        // The note is the only record that this turn happened. Kept in memory alone, a reload put
        // the question back on screen with nothing under it and took the note's Retry with it —
        // the exact state this decision exists to prevent.
        // saved under the id on screen, so a retry of this note still resolves after a reload
        const noteSave = await insertRowTolerant<Message>(supabase, 'messages', {
          id: localId,
          conversation_id: conv.id,
          role: 'assistant',
          content: noteContent,
          model: selectedModel,
          search_enabled: searchEnabled,
          search_results: [],
        });
        if (!noteSave.error) persistedIds.current.add(localId);
        return;
      }
      if (runAborted()) {
        await logActivity(conv.id, 'search', 'Search interrupted — answering from the model, unverified', {}, 'completed');
      }

      // Chat with search built in: a thin search run informs the answer, it never replaces it. The
      // gaps are recorded and the model answers from its own knowledge, told to say it is unverified.
      if (searchResultsData.length === 0) {
        // Recorded whatever the disclosure preference says. The answer is unverified either way, so
        // the transcript must be able to explain why; the preference only changes the prose.
        const report = buildGapReport({
          query: content,
          engines,
          issues: engineIssues,
          laneYield: laneYield,
        });
        gapLines = report.gaps;
        await logActivity(
          conv.id,
          'search',
          `No usable sources this run — answering from the model, unverified (${report.gaps.length} gap${report.gaps.length === 1 ? '' : 's'})`,
          { engines, gaps: report.gaps },
          'completed',
        );
      }
    }

    // Build LLM messages
    // the built-in prompt, or the variant this account saved in Settings — kept in hand so the
    // answer row can record the exact text that produced it
    const activePrompt = systemPromptFor(session?.user?.id);
    const llmMessages: { role: string; content: string }[] = [{
      role: 'system',
      content: activePrompt,
    }];

    // every source the prompt carries this turn, and how much of its page text the prompt carried:
    // any other fused source stays in the panel only
    const inPrompt = new Map<string, number>();
    // the tail of a follow-up search, dropped on purpose: a source that is out of the prompt for
    // this reason must not read like one the turn simply never got to
    const capped = new Set<string>();

    if (searchResultsData.length > 0) {
      // the top sources carry the text of the page itself, when it could be read
      for (const source of searchResultsData) inPrompt.set(source.url, PROMPT_CONTENT_CHARS);
      const searchContext = formatSourceContext(searchResultsData);
      llmMessages.push({
        role: 'system',
        content: `Web search results for "${content}" (ranked by Reciprocal Rank Fusion):\n\n${searchContext}\n\nUse these sources to inform your response. Cite sources by their citation ID. Note the provider and assess source credibility. Where page text is given, read it as the source itself: quote figures from it exactly, and prefer it over the snippet when the two differ.`,
      });
    } else if (shouldSearch) {
      llmMessages.push({
        role: 'system',
        // with the block off the answer goes out undisclaimed, but never unguarded against invented
        // citations
        content: emptyResultBlock
          ? `Web search for "${content}" returned no usable sources this run (engines tried: ${engines.join(', ')}). Answer the question from your own knowledge. Do not invent URLs, titles or citation IDs, and state plainly that this answer is not backed by retrieved sources.`
          : `Web search for "${content}" returned no usable sources this run (engines tried: ${engines.join(', ')}), and you are answering without sources. Answer from your own knowledge. Do not invent URLs, titles or citation IDs.`,
      });
    }

    for (const msg of messages) {
      llmMessages.push({ role: msg.role, content: msg.content });
    }
    llmMessages.push({ role: 'user', content });

    setIsStreaming(true);
    setStreamingContent('');

    let fullContent = '';
    // the model's own searches, so the transcript can show them and offer each query back
    let toolSearches: string[] = [];
    // what each of those searches added, so the strip can tell a productive one from a redundant one
    let toolSearchYields: ToolSearchYield[] = [];
    const assistantMsgId = crypto.randomUUID();
    // the saved row records which sources the prompt carried, so the strip can say how many of the
    // fused list the model actually read rather than leaving "ignored" and "never shown" alike
    const storedResults = () =>
      searchResultsData.map((source) => {
        const cap = inPrompt.get(source.url);
        return {
          ...source,
          in_prompt: cap !== undefined,
          prompt_chars: cap,
          prompt_reason: promptReasonFor(source, cap, capped.has(source.url)),
        };
      });
    const assistantMsg: Message = {
      id: assistantMsgId,
      conversation_id: conv.id,
      role: 'assistant',
      content: '',
      model: selectedModel,
      search_enabled: searchEnabled,
      search_results: storedResults(),
      queries_used: compiledQueries,
      tool_searches: toolSearches,
      tool_search_yields: toolSearchYields,
      gaps: gapLines,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, assistantMsg]);

    const synthLog = await logActivity(conv.id, 'synthesize', 'Synthesizing response from gathered sources', { model: selectedModel }, 'running');

    // the model that actually answers, which may not be the one that was selected
    let effectiveModel = selectedModel;
    const chain = fallbackChain(selectedModel, models);

    // cancelled by the stop control, or superseded by whatever runs next
    streamRunRef.current?.abort();
    const streamController = new AbortController();
    streamRunRef.current = streamController;

    // the stream callbacks are unchanged; the search-tool loop below drives them turn by turn
    const callbacks: ChatStreamCallbacks = {
      onModelServed: (requested, served) => {
        setModelNotice({ kind: 'served', from: requested, to: served });
        // the answer is real, but it is not the model the picker says: record it rather than silently
        // keeping the attribution the provider contradicted
        void logActivity(
          conv.id,
          'analyze',
          `Provider answered as ${served}, not ${requested} — this answer came from ${served}`,
          { requested, served },
          'completed',
        );
      },
      onModelSwitch: (from, to, reason) => {
        effectiveModel = to;
        setModelNotice({ kind: 'fallback', from, to, reason });
        setMessages((prev) => prev.map((m) => (m.id === assistantMsgId ? { ...m, model: to } : m)));
        void logActivity(conv.id, 'analyze', `${from} unavailable (${reason}) — answered on ${to}`, { from, to }, 'completed');
      },
      onToken: (token) => {
        fullContent += token;
        setStreamingContent(fullContent);
        setMessages((prev) => prev.map((m) => (m.id === assistantMsgId ? { ...m, content: fullContent } : m)));
      },
      onDone: async (finalContent) => {
        setIsStreaming(false);
        setStreamingContent('');

        const { data: savedMsg, error: saveError, dropped } = await insertRowTolerant<Message>(supabase, 'messages', {
          id: assistantMsgId,
          conversation_id: conv!.id, role: 'assistant', content: finalContent,
          model: effectiveModel, search_enabled: searchEnabled, search_results: storedResults(),
          queries_used: compiledQueries,
          system_prompt: activePrompt, tool_searches: toolSearches,
          tool_search_yields: toolSearchYields,
          gaps: searchResultsData.length === 0 ? gapLines : [],
        });
        if (!saveError) persistedIds.current.add(assistantMsgId);
        await noteDroppedColumns(dropped, async (message, detail) => {
          await logActivity(conv!.id, 'analyze', message, detail, 'completed');
        });

        // Save findings
        if (searchResultsData.length > 0 && savedMsg) {
          const findingsToInsert = searchResultsData.map((r) => ({
            conversation_id: conv!.id, message_id: (savedMsg as Message).id,
            query: content, title: r.title, url: r.url, snippet: r.snippet,
            source_engine: r.source_engine, status: 'saved' as const,
          }));
          const { data: savedFindings } = await supabase.from('findings').insert(findingsToInsert).select();
          if (savedFindings) setFindings((prev) => [...(savedFindings as Finding[]), ...prev].slice(0, 50));
        }

        await logActivity(conv!.id, 'synthesize', 'Response synthesized with citations', { sources: searchResultsData.length });

        await supabase.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', conv!.id);
      },
      onError: async (error) => {
        setIsStreaming(false);
        setStreamingContent('');
        setMessages((prev) => prev.map((m) =>
          m.id === assistantMsgId ? { ...m, content: `Error: ${error}` } : m
        ));
        // The failed answer keeps its Retry on screen, so the row is saved too: a retry links to the
        // attempt it replaces, and a target that only ever existed in memory cannot be linked after a
        // reload — the same reason the stopped answer is saved.
        const failedSave = await insertRowTolerant<Message>(supabase, 'messages', {
          id: assistantMsgId,
          conversation_id: conv!.id, role: 'assistant', content: `Error: ${error}`,
          model: effectiveModel, search_enabled: searchEnabled, search_results: storedResults(),
          queries_used: compiledQueries,
          system_prompt: activePrompt, tool_searches: toolSearches,
          tool_search_yields: toolSearchYields,
          gaps: searchResultsData.length === 0 ? gapLines : [],
        });
        if (!failedSave.error) persistedIds.current.add(assistantMsgId);
        setActivityLogs((prev) => prev.map((a) =>
          a.activity_type === 'synthesize' && a.status === 'running'
            ? { ...a, status: 'failed', description: `Synthesis failed: ${error}` }
            : a
        ));
      },
      // the stream was stopped on purpose. The partial is labelled and persisted: dropping it makes
      // the turn vanish on reload, which reads as though the question was never answered at all.
      onAbort: async (partial) => {
        setIsStreaming(false);
        setStreamingContent('');
        // the abort path may hand back less than onToken already delivered, so trust the longer one
        const kept = (partial.length > fullContent.length ? partial : fullContent).trim();
        const stopped = kept ? `${kept}\n\n${STOPPED_NOTE}` : STOPPED_NOTE;
        setMessages((prev) => prev.map((m) => (m.id === assistantMsgId ? { ...m, content: stopped } : m)));

        // nothing streamed yet: a row that only says "stopped" would be noise in the transcript
        if (kept) {
          const { error: stoppedError, dropped: stoppedDropped } = await insertRowTolerant<Message>(supabase, 'messages', {
            id: assistantMsgId,
            conversation_id: conv!.id, role: 'assistant', content: stopped,
            model: effectiveModel, search_enabled: searchEnabled, search_results: storedResults(),
            queries_used: compiledQueries,
            system_prompt: activePrompt, tool_searches: toolSearches,
            tool_search_yields: toolSearchYields,
            gaps: searchResultsData.length === 0 ? gapLines : [],
          });
          if (!stoppedError) persistedIds.current.add(assistantMsgId);
          await noteDroppedColumns(stoppedDropped, async (message, detail) => {
            await logActivity(conv!.id, 'analyze', message, detail, 'completed');
          });
          await supabase.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', conv!.id);
        }

        setActivityLogs((prev) => prev.map((a) =>
          a.id === synthLog?.id
            ? { ...a, status: 'completed', description: 'Synthesis stopped' }
            : a
        ));
        if (synthLog?.id) {
          void supabase.from('activity_logs')
            .update({ status: 'completed', description: 'Synthesis stopped' })
            .eq('id', synthLog.id);
        }
      },
    };

    /**
     * Run one of the model's own searches and fold what it found into this answer's evidence.
     *
     * The two rules that shape a dork — no query compiler, operator-capable engines only — live in
     * `runToolSearch` so they can be tested; this keeps only the state they act on.
     */
    const runToolSearch = async (query: string, options: { dork?: boolean } = {}) => {
      const outcome = await executeToolSearch({
        query,
        dork: options.dork === true,
        searchEnabled,
        engines,
        conversationId: conv!.id,
        performSearch,
        knownUrls: searchResultsData.map((source) => source.url),
      });
      // a refusal never ran a search, so there is nothing to record and nothing to offer
      if (!outcome.yielded) return { count: 0, text: outcome.text };

      toolSearchYields = [...toolSearchYields, outcome.yielded];
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantMsgId ? { ...m, tool_search_yields: toolSearchYields } : m)),
      );
      if (outcome.count === 0) return { count: 0, text: outcome.text };

      // the answer now has sources behind it: the bubble must stop saying otherwise, and the row
      // that gets saved must remember them
      searchResultsData = [...searchResultsData, ...outcome.offered, ...outcome.capped];
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId
            ? // the answer now has sources behind it, so the gaps it started with no longer apply
              { ...m, search_results: storedResults(), gaps: [] }
            : m,
        ),
      );
      // only the first eight of a follow-up search reach the model; the rest are panel-only, and the
      // row says so: "beyond the cap" is a different omission from "nothing was ever prompted"
      for (const source of outcome.offered) inPrompt.set(source.url, FOLLOW_UP_CONTENT_CHARS);
      for (const source of outcome.capped) capped.add(source.url);
      return { count: outcome.count, text: outcome.text };
    };

    // The model may search again when the first pass was thin. Each call runs the real engines and
    // keeps streaming — performSearch normally aborts a running stream, so it is told not to.
    let toolRun: Awaited<ReturnType<typeof runSearchToolLoop>>;
    try {
      toolRun = await runSearchToolLoop({
      messages: llmMessages as ToolMessage[],
      // with search off the model is not offered the tool at all
      // both tools, so the model can choose operators when a plain query cannot reach the page
      tools: searchEnabled ? [SEARCH_TOOL, DORK_TOOL] : [],
      maxSearches: 2,
      onSearch: (query, _index, tool) => {
        toolSearches = [...toolSearches, query];
        // the bubble owns the list while the answer streams, so the strip appears as it happens
        setMessages((prev) => prev.map((m) => (m.id === assistantMsgId ? { ...m, tool_searches: toolSearches } : m)));
        void logActivity(
          conv!.id,
          'search',
          tool === 'search_dorks' ? `Model ran a dork: "${query}"` : `Model searched again: "${query}"`,
          { query, tool },
          'completed',
        );
      },
      stream: (turnMessages, turnTools) =>
        streamTurn(
          selectedModel,
          turnMessages,
          { onToken: callbacks.onToken, onModelSwitch: callbacks.onModelSwitch, onModelServed: callbacks.onModelServed },
          { fallbacks: chain, signal: streamController.signal, tools: turnTools },
        ),
      runSearch: (query) => runToolSearch(query),
      runDorks: (query) => runToolSearch(query, { dork: true }),
      });
    } catch (error) {
      // the composer is disabled while streaming, so an exception escaping here would leave the app
      // unable to send anything at all — which reads as the model having stopped answering
      setIsStreaming(false);
      setStreamingContent('');
      await logActivity(conv.id, 'synthesize', `Turn failed: ${error instanceof Error ? error.message : 'unknown error'}`, {}, 'failed');
      callbacks.onError(error instanceof Error ? error.message : 'the request failed');
      return;
    }

    if (toolRun.stoppedBy === 'aborted') await callbacks.onAbort?.(toolRun.content);
    else if (toolRun.stoppedBy === 'error') callbacks.onError(toolRun.error ?? 'unknown error');
    else await callbacks.onDone(toolRun.content);

  };

  const handleUpdateFindingStatus = async (id: string, status: 'saved' | 'shared' | 'discarded') => {
    if (status === 'discarded') {
      await supabase.from('findings').delete().eq('id', id);
      setFindings((prev) => prev.filter((f) => f.id !== id));
    } else {
      await supabase.from('findings').update({ status }).eq('id', id);
      setFindings((prev) => prev.filter((f) => f.id !== id));
    }
  };

  /**
   * Run a search on its own.
   *
   * It never rewrites an answer, so the post it was pressed from is told what the run found — how
   * many sources, how many it did not already have — and offered the one control that would update
   * it, rather than leaving a button that looks like it answered and did not.
   */
  const handleRetrySearch = async (
    query: string,
    options?: { messageId?: string; forceRecent?: boolean },
  ) => {
    if (!currentConversation) return;
    const recent = options?.forceRecent === true;
    // the receipt's move: the same question, ranked with dates weighted, on the scope that carries
    // live pages. It does not rewrite the engine selection the composer shows — a diagnosis should
    // not quietly change the settings someone chose.
    const found = await performSearch(
      query,
      currentConversation.id,
      recent
        ? { engines: SEARCH_SCOPES.find((scope) => scope.id === 'recent')?.engines, forceFresh: true }
        : undefined,
    );
    const messageId = options?.messageId;
    if (!messageId) return;
    setRerunReports((prev) => ({
      ...prev,
      [messageId]: { query, results: found, note: recent ? 'recency forced · Recent scope' : undefined },
    }));
    // the post says what changed; the trail keeps the same sentence after the post is gone
    const known = new Set((messages.find((entry) => entry.id === messageId)?.search_results ?? []).map((source) => source.url));
    const fresh = found.filter((source) => !known.has(source.url)).length;
    await logActivity(
      currentConversation.id,
      'search',
      `Search only${recent ? ' (recency forced, Recent scope)' : ''}: “${query}” returned ${found.length} source${
        found.length === 1 ? '' : 's'
      }, ${fresh} not in that answer — nothing was rewritten`,
      { query, sources: found.length, new_sources: fresh, message_id: messageId, recency_forced: recent },
      'completed',
    );
  };

  /** The freshness receipt's next move: search the same question for recent pages. */
  const handleSearchRecent = async (query: string, options?: { messageId?: string }) => {
    await handleRetrySearch(query, { messageId: options?.messageId, forceRecent: true });
  };

  /**
   * Re-run one of the queries the function actually sent.
   *
   * Uncompiled on purpose: the point of the control is to run those words again, so letting the
   * compiler rewrite them a second time would change the query under the person asking.
   */
  const handleRunQuery = async (query: string) => {
    if (!currentConversation) return;
    await performSearch(query, currentConversation.id, { compileQueries: false });
  };

  /** Answer again from a search-only run's sources: no engine is queried, only the model. */
  const handleAnswerWithSources = async (query: string, reused: Source[]) => {
    await handleSendMessage(query, { reused });
  };

  /**
   * The sources this conversation already stored for a question, if any.
   *
   * The run that just failed still holds its fused list in memory, page text included; the stored
   * rows are the fallback, and the only copy that outlives the turn.
   */
  const storedSourcesFor = async (question: string): Promise<Source[] | null> => {
    const conversationId = currentConversation?.id;
    if (!conversationId) return null;
    const { data } = await supabase
      .from('sources')
      .select('*')
      .eq('conversation_id', conversationId)
      .eq('original_query', question);
    return reuseForRetry({
      question,
      conversationId,
      lastQuery: lastSearchQuery,
      live: searchResults,
      rows: (data ?? []) as SourceRecord[],
    });
  };

  /**
   * Retry a turn. A failure that already stored its sources is re-answered from those sources, so
   * the retry costs one generation instead of a whole search; anything else asks the engines again.
   */
  const handleRetryTurn = async (query: string, options?: { reuseSources?: boolean; messageId?: string }) => {
    const reused = options?.reuseSources ? await storedSourcesFor(query) : null;
    // the new turn records the attempt it replaces, so the two read as attempts at one question
    await handleSendMessage(query, { reused, retryOf: options?.messageId });
  };

  /** Save a message's sources as findings, skipping anything already filed. Returns how many were new. */
  const handleSaveResults = async (query: string, results: Source[]): Promise<number> => {
    const already = new Set(findings.map((finding) => finding.url));
    const rows = results
      .filter((result) => !already.has(result.url))
      .map((result) => ({
        conversation_id: currentConversation?.id ?? null,
        query,
        title: result.title,
        url: result.url,
        snippet: result.snippet,
        source_engine: result.source_engine,
        status: 'saved' as const,
      }));
    if (rows.length === 0) return 0;
    const { data } = await supabase.from('findings').insert(rows).select();
    if (data) setFindings((previous) => [...(data as Finding[]), ...previous].slice(0, 50));
    return rows.length;
  };

  /**
   * Record whether the answer met the question.
   *
   * Relevance says a page matched the words; it never says the answer was worth having, so nothing
   * scored the engine weights or the ranking cuts that produced it. This is that outcome, written
   * to the answer row and read back beside the queries, the pages the prompt carried and their
   * score terms. Applied locally first — a press must answer immediately — and rolled back when the
   * write failed, because a verdict the database refused is not ground truth.
   */
  const handleUsefulness = async (messageId: string, useful: boolean) => {
    const before = messages.find((m) => m.id === messageId)?.useful ?? null;
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, useful } : m)));
    const { error, dropped } = await updateRowTolerant(supabase, 'messages', { id: messageId }, { useful });
    if (!error) return;
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, useful: before } : m)));
    throw new Error(
      dropped.length > 0
        ? `messages.${dropped.join(', messages.')} is not in the database yet (apply the pending migration)`
        : (error.message ?? 'the update was refused'),
    );
  };

  /** Raw mode: gather, fuse and save sources, then stop without touching the model. */
  const handleRawSearch = async (query: string) => {
    const clean = query.trim();
    if (!clean || isStreaming) return;
    let conversationId = currentConversation?.id ?? '';
    if (!conversationId) {
      const conv = await createConversation();
      setCurrentConversation(conv);
      conversationId = conv.id;
      await supabase.from('conversations').update({ title: clean }).eq('id', conversationId);
    }
    await performSearch(clean, conversationId);
    // the point of raw mode is the source list, so put the panel where the results are
    setPanelTab('sources');
  };

  /**
   * What the composer does with a typed message.
   *
   * This is a chat, so a message is a message: search runs because the Search switch is on, not
   * because the text was typed into a box. "Sources only" is the one mode where a search is the
   * request itself, and it says so on the button.
   */
  const handleComposerSend = async (query: string) => {
    // a running search does not block a new one: performSearch cancels it, so the newest query wins
    if (!query.trim() || isStreaming) return;
    if (rawSearchOnly) {
      await handleRawSearch(query);
      return;
    }
    await handleSendMessage(query.trim());
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
  };

  const currentPreset = presets.find((p) => p.name === selectedPreset);

  if (!authReady) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg-base">
        <Loader2 size={20} className="animate-spin text-text-muted" />
      </div>
    );
  }

  if (!session) return <AuthScreen />;

  // read while rendering: saving a variant in Settings closes the modal, that re-renders this, and
  // the composer then names the prompt the next turn is going to send
  const promptStatus = describePromptVariant(readPromptVariant(session.user?.id));

  return (
    <div className="flex h-screen overflow-hidden bg-bg-base">
      {showSidebar && (
        <Sidebar
          conversations={conversations}
          currentConversation={currentConversation}
          onNewChat={handleNewChat}
          onSelectConversation={handleSelectConversation}
          onDeleteConversation={handleDeleteConversation}
          findingsCount={findings.length}
          presets={presets}
          selectedPreset={selectedPreset}
          onSelectPreset={setSelectedPreset}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex items-center justify-between gap-2 px-4 py-2.5">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowSidebar(!showSidebar)}
              className="rounded-lg p-1.5 text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
            >
              <Menu size={18} />
            </button>
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-accent-hover glow-accent">
                <Compass size={16} className="text-bg-base" />
              </div>
              <span className="text-base font-semibold text-text-primary tracking-tight">Fieldwork</span>
              <span className="hidden md:inline text-xs text-text-muted ml-1">Research Intelligence</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <PresetSelector
              presets={presets}
              selectedPreset={selectedPreset}
              onSelectPreset={setSelectedPreset}
            />
            <ModelSelector
              models={models}
              selectedModel={selectedModel}
              onSelectModel={setSelectedModel}
            />
            <button
              onClick={() => setSearchEnabled(!searchEnabled)}
              className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                searchEnabled
                  ? 'bg-olive-subtle text-olive border border-olive/30'
                  : 'text-text-secondary hover:bg-bg-hover border border-border-subtle'
              }`}
            >
              <Search size={14} />
              <span className="hidden lg:inline">{searchEnabled ? 'Search On' : 'Search Off'}</span>
            </button>
            <button
              onClick={() => setPanelOpen(!showSearchPanel)}
              className={`rounded-lg p-1.5 transition-colors ${
                showSearchPanel ? 'bg-bg-hover text-text-primary' : 'text-text-secondary hover:bg-bg-hover'
              }`}
              title={showSearchPanel ? 'Collapse panel' : 'Expand panel'}
              aria-label={showSearchPanel ? 'Collapse panel' : 'Expand panel'}
              aria-pressed={!showSearchPanel}
            >
              {showSearchPanel ? <PanelRightClose size={18} /> : <PanelRight size={18} />}
            </button>
            <button
              onClick={() => setShowSettings(true)}
              className="rounded-lg p-1.5 text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
            >
              <Settings size={18} />
            </button>
            <button
              onClick={handleSignOut}
              title={`Sign out${session.user.email ? ` (${session.user.email})` : ''}`}
              className="flex items-center gap-1.5 rounded-lg p-1.5 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
            >
              <LogOut size={18} />
            </button>
          </div>
        </header>

        {/* The work sits in one inset window: a panel of page, not a full-bleed control room. */}
        <div className="flex flex-1 gap-2 overflow-hidden px-2 pb-2">
          <div className="flex min-w-0 flex-1 overflow-hidden rounded-xl border border-border-subtle bg-bg-surface/40">
            <ChatArea
              messages={messages}
              isStreaming={isStreaming}
              streamingContent={streamingContent}
              onSendMessage={handleSendMessage}
              searchEnabled={searchEnabled}
              isSearching={isSearching}
              messagesEndRef={messagesEndRef}
              presetName={selectedPreset}
              onSearch={handleComposerSend}
              onRunLane={handleRunLane}
              onUseDork={setDorkDraft}
              draftQuery={dorkDraft}
              onDraftUsed={() => setDorkDraft(null)}
              onCancelSearch={cancelSearch}
              storedKeyNames={storedKeyNames}
              deploymentKeyNames={deploymentKeyNames}
              promptStatus={promptStatus}
              keysUnavailable={keysUnavailable}
              onOpenSettings={() => setShowSettings(true)}
              searchLabel={searchStatus}
              engineIssues={engineIssues}
              laneYield={laneYield}
              relaxedGate={relaxedGate}
              rawOnly={rawSearchOnly}
              onRawOnlyChange={setRawSearchOnly}
              engines={engines}
              onEnginesChange={setEngines}
              useDorks={useDorks}
              onUseDorksChange={setUseDorks}
              onRetrySearch={handleRetrySearch}
              onSearchRecent={handleSearchRecent}
              // the citation selected in the Sources panel lights the newest answer's sentences
              focusedCitation={citationFocus}
              onCitationFocus={setCitationFocus}
              reruns={rerunReports}
              onAnswerWithSources={handleAnswerWithSources}
              onRetryTurn={handleRetryTurn}
              onSaveResults={handleSaveResults}
              onFollowUp={handleSendMessage}
              onUsefulness={handleUsefulness}
              modelNotice={modelNotice}
              onDismissModelNotice={() => setModelNotice(null)}
            />
          </div>

          {showSearchPanel ? (
            <InvestigationPanel
              searchResults={searchResults}
              // which panel rows the model actually read, taken from the saved answers: the panel's
              // own source rows predate the prompt and cannot know
              promptCoverage={promptCoverage(messages)}
              // which stored rows were brought in by a search the model ran itself, so the panel can
              // say so without sending the reader back to the chip strip under the answer
              modelSearches={[...new Set(messages.flatMap((m) => m.tool_searches ?? []))]}
              // the last run weighted dates regardless of intent, so a card must not say it ignored them
              forcedRecency={forcedRecency}
              // a rewritten question is shown with the words that were really sent, and each is runnable
              queriesUsed={queriesUsed}
              onRunQuery={handleRunQuery}
              // one id, both directions: a card press lights the answer, and vice versa
              focusedCitation={citationFocus}
              onFocusCitation={setCitationFocus}
              isSearching={isSearching}
              findings={findings}
              onUpdateFindingStatus={handleUpdateFindingStatus}
              onRetrySearch={handleRetrySearch}
              activityLogs={activityLogs}
              sources={sources}
              query={lastSearchQuery}
              gaps={
                // an empty Sources panel names the same gaps the answer's gap report lists, so a
                // dead search never leaves a page with nothing on it
                lastSearchQuery
                  ? buildGapReport({ query: lastSearchQuery, engines, issues: engineIssues, laneYield }).gaps
                  : []
              }
              tab={panelTab}
              onTabChange={setPanelTab}
              onCollapse={() => setPanelOpen(false)}
            />
          ) : (
            <aside className="flex w-11 flex-col items-center gap-1 overflow-hidden rounded-xl border border-border-subtle bg-bg-deep py-2">
              <button
                onClick={() => setPanelOpen(true)}
                className="rounded-lg p-1.5 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
                title="Expand investigation panel"
                aria-label="Expand investigation panel"
              >
                <PanelRight size={16} />
              </button>
              <div className="my-1 h-px w-5 bg-border-subtle" />
              {([
                { id: 'map', icon: Radar, label: 'Map', count: searchResults.length },
                { id: 'activity', icon: Activity, label: 'Activity', count: activityLogs.length },
                { id: 'sources', icon: Globe, label: 'Sources', count: sources.length },
                { id: 'evidence', icon: Shield, label: 'Findings', count: findings.length },
              ] as const).map((entry) => (
                <button
                  key={entry.id}
                  onClick={() => {
                    setPanelTab(entry.id);
                    setPanelOpen(true);
                  }}
                  className="relative rounded-lg p-1.5 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
                  title={entry.label}
                  aria-label={`Open ${entry.label}`}
                >
                  <entry.icon size={16} />
                  {entry.count > 0 && (
                    <span className="absolute -right-0.5 -top-0.5 rounded-full bg-accent px-1 text-[8px] font-semibold leading-3 text-bg-deep">
                      {entry.count > 99 ? '99' : entry.count}
                    </span>
                  )}
                </button>
              ))}
            </aside>
          )}
        </div>
      </div>

      {showSettings && (
        <SettingsModal
          presets={presets}
          selectedPreset={selectedPreset}
          onSelectPreset={setSelectedPreset}
          onClose={() => {
            setShowSettings(false);
            // a key saved in settings must show up in the composer without a reload
            void refreshKeyNames();
          }}
          userId={session?.user?.id}
          emptyResultBlock={emptyResultBlock}
          onEmptyResultBlockChange={(enabled) => {
            setEmptyResultBlock(enabled);
            writeEmptyResultBlock(enabled);
          }}
        />
      )}
    </div>
  );
}
