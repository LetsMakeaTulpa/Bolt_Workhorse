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

/**
 * What one of the model's own extra searches brought in, recorded with the turn.
 *
 * Without it a strip that lists the queries it ran says nothing about whether running them was
 * worth it: the search that found five new pages and the one that found the same three again look
 * identical, and only one of them earned the budget.
 */
export interface ToolSearchYield {
  query: string;
  /** results the search returned at all */
  found: number;
  /** those this answer did not already have; 0 means the search was redundant */
  added: number;
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
  /** what each of those searches added; absent on rows written before it was recorded */
  tool_search_yields?: ToolSearchYield[];
  /**
   * The message this turn retries, when it is a second attempt at a question that ended without an
   * answer. Asking again appends a new question and answer, so without this the retry reads as an
   * unrelated turn beside the stopped one. Null or absent on a first attempt.
   */
  retry_of?: string | null;
  /**
   * Why the search behind this answer came back empty, when it did: the same lines the Sources panel
   * carries. Recorded with the answer so the transcript can still name the gaps after a reload — a
   * collapsed panel must not be the only place the reason exists. Empty on an answer with sources.
   */
  gaps?: string[];
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
   * How many characters of `content` this turn's prompt actually carried, since the prompt caps page
   * text. Without it a reader cannot tell whether a figure near the end of a page was ever read.
   * Absent on rows written before it was recorded — unknown, not "the whole page".
   */
  prompt_chars?: number;
  /**
   * whether this source was put in front of the model at all. A run keeps every fused source for
   * the panel but only the first eight of a follow-up search reach the prompt, so without this the
   * transcript cannot tell "the model ignored it" from "the model never saw it". Absent on rows
   * written before it was recorded — unknown, not "not shown".
   */
  in_prompt?: boolean;
  /**
   * Why, not just whether. Two sources can both be out of the prompt for different reasons — a
   * follow-up search overflowed its eight-source offer, or the turn built no prompt at all — and a
   * source that is in can still have had its page text cut at the cap. Absent on rows that predate
   * the record, and then only the boolean is known.
   */
  prompt_reason?: PromptReason;
}

/** Why a source is in this turn's prompt, or why it stayed in the panel. */
export type PromptReason =
  /** in the prompt, with all the page text the cap allows */
  | 'given'
  /** in the prompt, but the page's text was cut at the character cap */
  | 'trimmed'
  /** left out: a follow-up search offers the model only its first eight sources */
  | 'capped'
  /** left out: this turn never built a prompt of its sources */
  | 'no-prompt';

/** What a saved answer recorded about one url, and the reason when it recorded one. */
export interface PromptCoverage {
  inPrompt: boolean;
  /** null on a row written before the reason was recorded: the verdict is known, the cause is not */
  reason: PromptReason | null;
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

/**
 * What the function's query compiler did on this search. The compiler is a model call made on the
 * deployment's account before any engine runs, so it travels with the response instead of
 * disappearing into the function: which model, whether it ran, and what it cost.
 */
export interface CompilationReport {
  model: string;
  /** false when the compiler never reached the provider (disabled, or no key configured) */
  ran: boolean;
  reason: 'ok' | 'disabled' | 'no_key' | 'timeout' | 'error' | 'empty';
  queries: string[];
  duration_ms: number;
  /** provider-reported tokens for this call, when it reported any */
  tokens?: number;
  detail?: string;
}

export interface SearchResponse {
  query: string;
  queries_used: string[];
  /** absent on functions deployed before the compiler reported itself */
  compilation?: CompilationReport | null;
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
