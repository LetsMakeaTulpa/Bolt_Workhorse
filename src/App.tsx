import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from './lib/supabase';
import { fetchModels, chatCompletion, webSearch } from './lib/api';
import type {
  Conversation, Message, Source, ModelInfo, Finding,
  ResearchPreset, ActivityLog, SourceRecord,
} from './types';
import { Sidebar } from './components/Sidebar';
import { ChatArea } from './components/ChatArea';
import { InvestigationPanel } from './components/InvestigationPanel';
import { ModelSelector } from './components/ModelSelector';
import { SettingsModal } from './components/SettingsModal';
import { PresetSelector } from './components/PresetSelector';
import { Menu, Settings, Search, Compass, PanelRightClose, PanelRight } from 'lucide-react';

const DEFAULT_MODEL = 'Qwen/Qwen2.5-7B-Instruct';

export default function App() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentConversation, setCurrentConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL);
  const [isStreaming, setIsStreaming] = useState(false);
  const [searchEnabled, setSearchEnabled] = useState(true);
  const [searchResults, setSearchResults] = useState<Source[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [showSearchPanel, setShowSearchPanel] = useState(true);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [presets, setPresets] = useState<ResearchPreset[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<string>('general');
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [streamingContent, setStreamingContent] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load initial data
  useEffect(() => {
    loadConversations();
    loadPresets();
    loadFindings();
  }, []);

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
      setSearchResults([]);
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
    setSearchResults([]);
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

  const performSearch = async (query: string, convId: string): Promise<Source[]> => {
    setIsSearching(true);
    const preset = presets.find((p) => p.name === selectedPreset);
    const engines = preset?.config.engines ?? ['duckduckgo', 'wikipedia', 'arxiv', 'github'];
    const maxResults = preset?.config.max_results ?? 5;
    const useDorks = preset?.config.use_dorks ?? false;

    await logActivity(convId, 'plan', `Compiling search strategy for: "${query}"`, { preset: selectedPreset, engines });
    await logActivity(convId, 'search', `Searching across ${engines.length} engines`, { engines, useDorks }, 'running');

    try {
      const result = await webSearch(query, engines, maxResults, useDorks, selectedPreset);
      setSearchResults(result.results);

      await logActivity(convId, 'rank', `Reciprocal Rank Fusion applied to ${result.total_results} results`, {
        engines_used: result.engines_used,
        queries_used: result.queries_used,
      });
      await logActivity(convId, 'deduplicate', `Deduplicated and scored ${result.results.length} unique sources`);

      // Save sources to DB
      if (result.results.length > 0) {
        const sourcesToInsert = result.results.map((r, i) => ({
          conversation_id: convId,
          title: r.title,
          url: r.url,
          snippet: r.snippet,
          provider: r.source_engine,
          original_query: query,
          relevance_score: r.relevance_score ?? 0,
          citation_id: r.citation_id ?? `[${i + 1}]`,
          source_type: r.source_engine === 'arxiv' || r.source_engine === 'openalex' ? 'academic' : 'web',
        }));
        const { data: savedSources } = await supabase.from('sources').insert(sourcesToInsert).select();
        if (savedSources) setSources((prev) => [...(savedSources as SourceRecord[]), ...prev].slice(0, 50));
      }

      // Update the search activity to completed
      setActivityLogs((prev) => prev.map((a) =>
        a.activity_type === 'search' && a.status === 'running'
          ? { ...a, status: 'completed' }
          : a
      ));

      return result.results;
    } catch (err) {
      console.error('Search error:', err);
      setSearchResults([]);
      await logActivity(convId, 'search', `Search failed: ${err instanceof Error ? err.message : 'unknown'}`, {}, 'failed');
      return [];
    } finally {
      setIsSearching(false);
    }
  };

  const handleSendMessage = async (content: string) => {
    if (!content.trim() || isStreaming) return;

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
      search_enabled: searchEnabled,
      search_results: [],
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);

    await supabase.from('messages').insert({
      conversation_id: conv.id, role: 'user', content, search_enabled: searchEnabled,
    });

    if (messages.length === 0) {
      const title = content.substring(0, 50) + (content.length > 50 ? '...' : '');
      await supabase.from('conversations').update({ title, updated_at: new Date().toISOString() }).eq('id', conv.id);
      setConversations((prev) => prev.map((c) => (c.id === conv!.id ? { ...c, title } : c)));
    }

    let searchResultsData: Source[] = [];
    if (searchEnabled) {
      searchResultsData = await performSearch(content, conv.id);
    }

    // Build LLM messages
    const llmMessages: { role: string; content: string }[] = [{
      role: 'system',
      content: `You are Fieldwork, a research intelligence assistant. You conduct investigations by searching the web, analyzing sources, and synthesizing findings with citations. When search results are provided, cite sources using their citation IDs (e.g. [1], [2]). Be thorough, precise, and analytical. Distinguish between established facts and claims. Note contradictions when present. Structure your responses with clear sections when appropriate.`,
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

    await logActivity(conv.id, 'synthesize', 'Synthesizing response from gathered sources', { model: selectedModel }, 'running');

    await chatCompletion(selectedModel, llmMessages, {
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
          model: selectedModel, search_enabled: searchEnabled, search_results: searchResultsData,
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
    });
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

  const currentPreset = presets.find((p) => p.name === selectedPreset);

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
            />
          </div>

          {showSearchPanel && (
            <InvestigationPanel
              searchResults={searchResults}
              isSearching={isSearching}
              findings={findings}
              onUpdateFindingStatus={handleUpdateFindingStatus}
              onRetrySearch={handleRetrySearch}
              activityLogs={activityLogs}
              sources={sources}
            />
          )}
        </div>
      </div>

      {showSettings && (
        <SettingsModal
          presets={presets}
          selectedPreset={selectedPreset}
          onSelectPreset={setSelectedPreset}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
