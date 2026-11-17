export interface Conversation {
  id: string;
  /** owner; set by the database from the signed-in session */
  user_id?: string | null;
  title: string;
  model: string;
  project_id: string | null;
  preset: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model?: string | null;
  search_enabled: boolean;
  search_results: Source[];
  created_at: string;
  /**
   * The exact system prompt sent with this turn, so the answer can be traced to the prompt that
   * produced it. Null on rows written before it was recorded — unknown, not "built-in".
   */
  system_prompt?: string | null;
  /** extra searches the model ran on its own during this turn, oldest first */
  tool_searches?: string[];
}

export interface Source {
  title: string;
  url: string;
  snippet: string;
  source_engine: string;
  /** ISO date (YYYY-MM-DD) when the engine reports one; used for freshness ranking */
  published?: string;
  relevance_score?: number;
  citation_id?: string;
  /** every engine that independently returned this source (corroboration) */
  engines?: string[];
  /** IDF-weighted query coverage, 0-1 */
  relevance?: number;
  /** full page text, when this source was among the top results the function read */
  content?: string;
  /** which extractor read the page: 'fetch' or 'firecrawl' */
  content_source?: string;
  /**
   * whether this source was put in front of the model at all. A run keeps every fused source for
   * the panel but only the first eight of a follow-up search reach the prompt, so without this the
   * transcript cannot tell "the model ignored it" from "the model never saw it". Absent on rows
   * written before it was recorded — unknown, not "not shown".
   */
  in_prompt?: boolean;
}

export interface SourceRecord {
  id: string;
  conversation_id: string | null;
  message_id: string | null;
  title: string;
  url: string;
  publisher: string;
  author: string;
  publication_date: string;
  source_type: string;
  provider: string;
  original_query: string;
  relevance_score: number;
  citation_id: string;
  extraction_status: string;
  metadata: Record<string, unknown>;
  snippet: string;
  created_at: string;
}

export interface Evidence {
  id: string;
  conversation_id: string | null;
  source_id: string | null;
  claim: string;
  evidence_type: 'direct' | 'indirect' | 'supporting' | 'contradictory' | 'unverified' | 'missing';
  confidence: 'high' | 'medium' | 'low';
  corroborated_by: string[];
  contradicted_by: string[];
  status: 'active' | 'resolved' | 'unresolved';
  created_at: string;
}

export interface ActivityLog {
  id: string;
  conversation_id: string | null;
  activity_type: 'search' | 'analyze' | 'synthesize' | 'plan' | 'followup' | 'compile' | 'rank' | 'deduplicate';
  description: string;
  details: Record<string, unknown>;
  status: 'running' | 'completed' | 'failed';
  created_at: string;
}

export interface Finding {
  id: string;
  conversation_id: string | null;
  message_id: string | null;
  query: string;
  title: string;
  url: string;
  snippet: string;
  source_engine: string;
  status: 'saved' | 'shared' | 'discarded';
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface ResearchProject {
  id: string;
  name: string;
  description: string;
  objectives: string[];
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface ResearchPreset {
  id: string;
  name: string;
  category: string;
  description: string;
  config: PresetConfig;
  is_legacy: boolean;
}

export interface PresetConfig {
  engines: string[];
  max_iterations: number;
  max_results: number;
  evidence_required: boolean;
  use_dorks: boolean;
  contradiction_hunt?: boolean;
  domain_preference?: string[];
  is_legacy?: boolean;
  shodan_enabled?: boolean;
}

export interface SearchSettings {
  id: string;
  use_dorks: boolean;
  engines_enabled: string[];
  max_results_per_engine: number;
  auto_search: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  context_length: number;
  max_completion_tokens: number;
  /** Models pulled from the refusal-free lane (XORTRON, uncensored, abliterated, heretic families). */
  lane?: 'refusal-free';
}

/** What the search function reports about each engine it was asked to run. */
export interface EngineStatus {
  engine: string;
  /** ok | empty | missing_key | error | unknown_engine — kept loose so new reasons still render */
  status: string;
  results: number;
  detail?: string;
}

export interface SearchResponse {
  query: string;
  queries_used: string[];
  total_results: number;
  engines_used: string[];
  preset: string;
  /** absent on functions deployed before per-engine diagnostics existed */
  engine_status?: EngineStatus[];
  /** what the fetch-and-extract stage did; absent on functions deployed before it existed */
  extraction?: {
    limit: number;
    requested: number;
    extracted: number;
    chars: number;
    failures: { url: string; error: string }[];
  } | null;
  results: Source[];
}
