import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearch } from './hooks/useSearch';
import { supabase } from './lib/supabase';
import { fetchModels, chatCompletion, fallbackChain } from './lib/api';
import { DEFAULT_ENGINES } from './lib/engines';
import type {
  Conversation, Message, Source, ModelInfo, Finding,
  ResearchPreset, ActivityLog, SourceRecord,
} from './types';
import { Sidebar } from './components/Sidebar';
import { ChatArea } from './components/ChatArea';
import { InvestigationPanel, type PanelTab } from './components/InvestigationPanel';
import { ModelSelector } from './components/ModelSelector';
import { SettingsModal } from './components/SettingsModal';
import { PresetSelector } from './components/PresetSelector';
import { AuthScreen } from './components/AuthScreen';
import type { Session } from '@supabase/supabase-js';
import { Menu, Settings, Search, Compass, PanelRightClose, PanelRight, Activity, Globe, Shield, Radar, LogOut, Loader2 } from 'lucide-react';

const DEFAULT_MODEL = 'xortron/RESTRICTED-RESEARCH-MODEL';

export default function App() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentConversation, setCurrentConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL);
  const [isStreaming, setIsStreaming] = useState(false);
  const [searchEnabled, setSearchEnabled] = useState(true);
  const [engines, setEngines] = useState<string[]>(DEFAULT_ENGINES);
  /** the in-flight completion; stopping or replacing a run must stop the model too */
  const streamRunRef = useRef<AbortController | null>(null);
  const [useDorks, setUseDorks] = useState(false);
  const [rawSearchOnly, setRawSearchOnly] = useState(false);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [showSearchPanel, setShowSearchPanel] = useState(true);
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
      source_type: r.source_engine === 'arxiv' || r.source_engine === 'openalex' ? 'academic' : 'web',
    }));
    const { data } = await supabase.from('sources').insert(rows).select();
    if (data) setSources((previous) => [...(data as SourceRecord[]), ...previous].slice(0, 50));
  };

  const abortStream = useCallback(() => streamRunRef.current?.abort(), []);

  const {
    results: searchResults,
    isSearching,
    status: searchStatus,
    issues: engineIssues,
    laneYield,
    lastQuery: lastSearchQuery,
    performSearch,
    cancelSearch: cancelSearchRun,
    runLane: handleRunLane,
    runAborted,
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
    const shouldSearch = searchEnabled || options?.forceSearch === true;

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
      // a newer search replaced this one, so this turn has nothing to answer with
      if (runAborted()) return;
    }

    // Build LLM messages
    const llmMessages: { role: string; content: string }[] = [{
      role: 'system',
      content: `You are Fieldwork, a research assistant. You search the open, deep and dark web, weigh the sources and answer with citations.

When search results are provided:
- Open with a 2-4 sentence summary of what the sources collectively show. Lead with the answer, then the strongest caveat.
- Then the detail that matters: findings, numbers, dates, names, each cited as [1], [2]. Never cite a source that does not support the sentence it is attached to.
- Mark what is established versus merely claimed, and say so plainly when sources disagree instead of averaging them.
- If the results are thin, stale or off-topic, say that in one line rather than padding.

End every answer with this section, titled exactly FOLLOW-UPS:

FOLLOW-UPS
- one question a researcher would ask next
- a second question
- a third question

Each question must be answerable by a search. Nothing may follow that section. Keep answers tight: match length to the question, no preamble, no restating the question back.`,
    }];

    if (searchResultsData.length > 0) {
      const searchContext = searchResultsData
        .map((r) => `${r.citation_id ?? ''} ${r.title}\nURL: ${r.url}\nProvider: ${r.source_engine}\nSnippet: ${r.snippet}`)
        .join('\n\n');
      llmMessages.push({
        role: 'system',
        content: `Web search results for "${content}" (ranked by Reciprocal Rank Fusion):\n\n${searchContext}\n\nUse these sources to inform your response. Cite sources by their citation ID. Note the provider and assess source credibility.`,
      });
    }

    for (const msg of messages) {
      llmMessages.push({ role: msg.role, content: msg.content });
    }
    llmMessages.push({ role: 'user', content });

    setIsStreaming(true);
    setStreamingContent('');

    let fullContent = '';
    const assistantMsgId = crypto.randomUUID();
    const assistantMsg: Message = {
      id: assistantMsgId,
      conversation_id: conv.id,
      role: 'assistant',
      content: '',
      model: selectedModel,
      search_enabled: searchEnabled,
      search_results: searchResultsData,
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

    await chatCompletion(selectedModel, llmMessages, {
      onModelSwitch: (from, to, reason) => {
        effectiveModel = to;
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

        const { data: savedMsg } = await supabase.from('messages').insert({
          conversation_id: conv!.id, role: 'assistant', content: finalContent,
          model: effectiveModel, search_enabled: searchEnabled, search_results: searchResultsData,
        }).select().single();

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
      // the stream was stopped on purpose: keep the partial answer visible, mark it as cut off,
      // and do not persist it — a half-sentence is not a source anyone should cite later
      onAbort: (partial) => {
        setIsStreaming(false);
        setStreamingContent('');
        // the abort path may hand back less than onToken already delivered, so trust the longer one
        const kept = (partial.length > fullContent.length ? partial : fullContent).trim();
        const stopped = kept ? `${kept}\n\n_(stopped)_` : '_(stopped)_';
        setMessages((prev) => prev.map((m) => (m.id === assistantMsgId ? { ...m, content: stopped } : m)));
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
    }, undefined, chain, streamController.signal);
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

  const handleSearch = async (query: string) => {
    // a running search does not block a new one: performSearch cancels it, so the newest query wins
    if (!query.trim() || isStreaming) return;
    if (rawSearchOnly) {
      await handleRawSearch(query);
      return;
    }
    await handleSendMessage(query.trim(), { forceSearch: true });
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
              onClick={() => setShowSearchPanel(!showSearchPanel)}
              className={`rounded-lg p-1.5 transition-colors ${
                showSearchPanel ? 'bg-bg-hover text-text-primary' : 'text-text-secondary hover:bg-bg-hover'
              }`}
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
              onSearch={handleSearch}
              onRunLane={handleRunLane}
              onCancelSearch={cancelSearch}
              searchLabel={searchStatus}
              engineIssues={engineIssues}
              laneYield={laneYield}
              rawOnly={rawSearchOnly}
              onRawOnlyChange={setRawSearchOnly}
              engines={engines}
              onEnginesChange={setEngines}
              useDorks={useDorks}
              onUseDorksChange={setUseDorks}
              onRetrySearch={handleRetrySearch}
              onSaveResults={handleSaveResults}
              onFollowUp={handleSendMessage}
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
              tab={panelTab}
              onTabChange={setPanelTab}
              onCollapse={() => setShowSearchPanel(false)}
            />
          ) : (
            <aside className="flex w-11 flex-col items-center gap-1 border-l border-border-subtle bg-bg-deep py-2">
              <button
                onClick={() => setShowSearchPanel(true)}
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
                    setShowSearchPanel(true);
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
          onClose={() => setShowSettings(false)}
          userId={session?.user?.id}
        />
      )}
    </div>
  );
}
