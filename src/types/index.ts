export interface Conversation {
  id: string;
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
}

export interface Source {
  title: string;
  url: string;
  snippet: string;
  source_engine: string;
  relevance_score?: number;
  citation_id?: string;
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
}

export interface SearchResponse {
  query: string;
  queries_used: string[];
  total_results: number;
  engines_used: string[];
  preset: string;
  results: Source[];
}
