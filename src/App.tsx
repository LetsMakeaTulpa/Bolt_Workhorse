import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearch } from './hooks/useSearch';
import { useEngineKeys } from './hooks/useEngineKeys';
import { supabase } from './lib/supabase';
import { fetchModels, fallbackChain, SEARCH_TOOL, streamTurn, type ChatStreamCallbacks } from './lib/api';
import { runSearchToolLoop, type ToolMessage } from './lib/searchTool';
import { DEFAULT_ENGINES } from './lib/engines';
import { describePromptVariant, readPromptVariant, systemPromptFor } from './lib/promptVariant';
import { buildGapReport } from './lib/emptyResult';
import type {
  Conversation, Message, Source, ModelInfo, Finding,
  ResearchPreset, ActivityLog, SourceRecord,
} from './types';
import { Sidebar } from './components/Sidebar';
import { ChatArea } from './components/ChatArea';
import { InvestigationPanel, type PanelTab } from './components/InvestigationPanel';
import type { ModelNotice } from './components/ModelNotice';
import { readEmptyResultBlock, writeEmptyResultBlock } from './lib/emptyResultPref';
import { formatSourceContext } from './lib/sourceContext';
import { readPanelCollapsed, writePanelCollapsed } from './lib/panelPref';
import { ModelSelector } from './components/ModelSelector';
import { SettingsModal } from './components/SettingsModal';
import { PresetSelector } from './components/PresetSelector';
import { AuthScreen } from './components/AuthScreen';
import type { Session } from '@supabase/supabase-js';
import { Menu, Settings, Search, Compass, PanelRightClose, PanelRight, Activity, Globe, Shield, Radar, LogOut, Loader2 } from 'lucide-react';
import { decideAfterSearch, STOPPED_SEARCH_NOTE, SUPERSEDED_SEARCH_NOTE } from './lib/turnDecision';
import { insertRowTolerant, noteDroppedColumns } from './lib/messageInsert';

const DEFAULT_MODEL = 'xortron/RESTRICTED-RESEARCH-MODEL';

/** Appended to an answer the user stopped mid-stream: the row must never read as finished prose. */
const STOPPED_NOTE = '_(Stopped before completion — this is a partial answer.)_';

export default function App() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentConversation, setCurrentConversation] = useState<Conversation | null>(null);
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
  const [rawSearchOnly, setRawSearchOnly] = useState(false);
  const [findings, setFindings] = useState<Finding[]>([]);
  // where the panel was left last time: a collapsed panel that reopens on every reload is a panel
  // that has to be closed again on every reload
  const [showSearchPanel, setShowSearchPanel] = useState(() => !readPanelCollapsed());
  const [panelTab, setPanelTab] = useState<PanelTab>('map');
  const [showSidebar, setShowSidebar] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [presets, setPresets] = useState<ResearchPreset[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<string>('general');
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);
  const [sources, setSources] = useState<SourceRecord[]>([]);
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
      loadMessages(currentConversation.id);
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
    if (data) setMessages(data as Message[]);
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

  const {
    results: searchResults,
    isSearching,
    status: searchStatus,
    issues: engineIssues,
    laneYield,
    relaxedGate,
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
    abortStream,
    closeActivity,
  });

  /** stop a search or a completion, whichever is running */
  const cancelSearch = () => {
    cancelSearchRun();
    abortStream();
  };

  const handleSendMessage = async (content: string, options?: { forceSearch?: boolean }) => {
    if (!content.trim() || isStreaming) return;
    // a notice belongs to the answer it describes, not to the next question
    setModelNotice(null);
    const shouldSearch = searchEnabled || options?.forceSearch === true;
    const turnId = turnRef.current + 1;
    turnRef.current = turnId;
    const turnSuperseded = () => turnRef.current !== turnId;

    let conv = currentConversation;
    if (!conv) {
      conv = await createConversation();
      setCurrentConversation(conv);
    }

    const userMsg: Message = {
      id: crypto.randomUUID(),
      conversation_id: conv.id,
      role: 'user',
      content,
      search_enabled: shouldSearch,
      search_results: [],
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);

    await supabase.from('messages').insert({
      conversation_id: conv.id, role: 'user', content, search_enabled: shouldSearch,
    });

    if (messages.length === 0) {
      const title = content.substring(0, 50) + (content.length > 50 ? '...' : '');
      await supabase.from('conversations').update({ title, updated_at: new Date().toISOString() }).eq('id', conv.id);
      setConversations((prev) => prev.map((c) => (c.id === conv!.id ? { ...c, title } : c)));
    }

    let searchResultsData: Source[] = [];
    if (shouldSearch) {
      searchResultsData = await performSearch(content, conv.id);
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
        const { data: savedNote } = await insertRowTolerant<Message>(supabase, 'messages', {
          conversation_id: conv.id,
          role: 'assistant',
          content: noteContent,
          model: selectedModel,
          search_enabled: searchEnabled,
          search_results: [],
        });
        if (savedNote?.id) {
          setMessages((prev) => prev.map((m) => (m.id === localId ? { ...m, id: savedNote.id } : m)));
        }
        return;
      }
      if (runAborted()) {
        await logActivity(conv.id, 'search', 'Search interrupted — answering from the model, unverified', {}, 'completed');
      }

      // Chat with search built in: a thin search run informs the answer, it never replaces it. The
      // gaps are recorded and the model answers from its own knowledge, told to say it is unverified.
      if (searchResultsData.length === 0 && emptyResultBlock) {
        const report = buildGapReport({
          query: content,
          engines,
          issues: engineIssues,
          laneYield: laneYield,
        });
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

    // every source the prompt carries this turn; any other fused source stays in the panel only
    const inPrompt = new Set<string>();

    if (searchResultsData.length > 0) {
      // the top sources carry the text of the page itself, when it could be read
      for (const source of searchResultsData) inPrompt.add(source.url);
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
    const assistantMsgId = crypto.randomUUID();
    // the saved row records which sources the prompt carried, so the strip can say how many of the
    // fused list the model actually read rather than leaving "ignored" and "never shown" alike
    const storedResults = () =>
      searchResultsData.map((source) => ({ ...source, in_prompt: inPrompt.has(source.url) }));
    const assistantMsg: Message = {
      id: assistantMsgId,
      conversation_id: conv.id,
      role: 'assistant',
      content: '',
      model: selectedModel,
      search_enabled: searchEnabled,
      search_results: storedResults(),
      tool_searches: toolSearches,
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

        const { data: savedMsg, dropped } = await insertRowTolerant<Message>(supabase, 'messages', {
          conversation_id: conv!.id, role: 'assistant', content: finalContent,
          model: effectiveModel, search_enabled: searchEnabled, search_results: storedResults(),
          system_prompt: activePrompt, tool_searches: toolSearches,
        });
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
      onError: (error) => {
        setIsStreaming(false);
        setStreamingContent('');
        setMessages((prev) => prev.map((m) =>
          m.id === assistantMsgId ? { ...m, content: `Error: ${error}` } : m
        ));
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
          const { dropped: stoppedDropped } = await insertRowTolerant<Message>(supabase, 'messages', {
            conversation_id: conv!.id, role: 'assistant', content: stopped,
            model: effectiveModel, search_enabled: searchEnabled, search_results: storedResults(),
            system_prompt: activePrompt, tool_searches: toolSearches,
          });
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

    // The model may search again when the first pass was thin. Each call runs the real engines and
    // keeps streaming — performSearch normally aborts a running stream, so it is told not to.
    let toolRun: Awaited<ReturnType<typeof runSearchToolLoop>>;
    try {
      toolRun = await runSearchToolLoop({
      messages: llmMessages as ToolMessage[],
      // with search off the model is not offered the tool at all
      tools: searchEnabled ? [SEARCH_TOOL] : [],
      maxSearches: 2,
      onSearch: (query) => {
        toolSearches = [...toolSearches, query];
        // the bubble owns the list while the answer streams, so the strip appears as it happens
        setMessages((prev) => prev.map((m) => (m.id === assistantMsgId ? { ...m, tool_searches: toolSearches } : m)));
        void logActivity(conv!.id, 'search', `Model searched again: "${query}"`, { query, tool: 'search_web' }, 'completed');
      },
      stream: (turnMessages, turnTools) =>
        streamTurn(
          selectedModel,
          turnMessages,
          { onToken: callbacks.onToken, onModelSwitch: callbacks.onModelSwitch, onModelServed: callbacks.onModelServed },
          { fallbacks: chain, signal: streamController.signal, tools: turnTools },
        ),
      runSearch: async (query) => {
        if (!searchEnabled) {
          return { count: 0, text: 'Search is switched off for this turn. Answer from what you have.' };
        }
        const found = await performSearch(query, conv!.id, { keepStreaming: true });
        if (found.length === 0) {
          return { count: 0, text: `Search for "${query}" returned no usable sources. Answer with what you already have.` };
        }
        // the answer now has sources behind it: the bubble must stop saying otherwise, and the row
        // that gets saved must remember them
        searchResultsData = [...searchResultsData, ...found];
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMsgId ? { ...m, search_results: storedResults() } : m)),
        );
        // only the first eight of a follow-up search reach the model; the rest are panel-only
        const offered = found.slice(0, 8);
        for (const source of offered) inPrompt.add(source.url);
        const block = formatSourceContext(offered, { contentChars: 3000 });
        return { count: found.length, text: `Search results for "${query}":\n\n${block}` };
      },
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

  const handleRetrySearch = async (query: string) => {
    if (currentConversation) await performSearch(query, currentConversation.id);
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

      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b border-border-subtle bg-bg-surface px-4 py-2.5">
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

        <div className="flex flex-1 overflow-hidden">
          <div className="flex-1 overflow-hidden">
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
              onRetryTurn={handleSendMessage}
              onSaveResults={handleSaveResults}
              onFollowUp={handleSendMessage}
              modelNotice={modelNotice}
              onDismissModelNotice={() => setModelNotice(null)}
            />
          </div>

          {showSearchPanel ? (
            <InvestigationPanel
              searchResults={searchResults}
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
                lastSearchQuery && emptyResultBlock
                  ? buildGapReport({ query: lastSearchQuery, engines, issues: engineIssues, laneYield }).gaps
                  : []
              }
              tab={panelTab}
              onTabChange={setPanelTab}
              onCollapse={() => setPanelOpen(false)}
            />
          ) : (
            <aside className="flex w-11 flex-col items-center gap-1 border-l border-border-subtle bg-bg-deep py-2">
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
