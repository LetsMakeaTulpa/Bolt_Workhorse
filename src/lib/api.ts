import type { ModelInfo, SearchResponse, Source } from '../types';
import { supabase } from './supabase';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

const headers = {
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json',
  'X-Client-Info': 'fieldwork',
};

/**
 * Inference calls carry the signed-in user's token when there is one: the proxy bills and rate
 * limits by account, so sending only the public anon key would land every user in the anonymous
 * bucket. Reads the session locally — no network round trip.
 */
async function proxyHeaders(): Promise<Record<string, string>> {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) return { ...headers, Authorization: `Bearer ${token}` };
  } catch {
    // fall back to the anon key; the proxy will treat the call as anonymous
  }
  return headers;
}

const FEATHERLESS_CATALOG = 'https://api.featherless.ai/v1/models';
const DEFAULT_MODEL = 'xortron/RESTRICTED-RESEARCH-MODEL';

function mapModel(m: Record<string, unknown>): ModelInfo {
  return {
    id: String(m.id ?? ''),
    name: String(m.name ?? m.id ?? ''),
    context_length: Number(m.context_length ?? 8192),
    max_completion_tokens: Number(m.max_completion_tokens ?? 4096),
  };
}

/** Refusal-free families: the XORTRON line plus Featherless' uncensored/abliterated/heretic catalogues. */
const REFUSAL_FREE_QUERIES = ['xortron', 'uncensored', 'abliterated', 'heretic'];
const REFUSAL_FREE_LIMIT = 120;

/** XORTRON is the house line (official `xortron/` plus community XORTRON builds): always pinned first. */
const isXortron = (id: string) => /xortron/i.test(id);

/**
 * The proxy only returns Featherless' 50 most trending models, so the entire refusal-free
 * lane is invisible to it. The public catalogue endpoint needs no key and allows any
 * origin, so those families are fetched directly and pinned to the top of the picker.
 */
async function fetchRefusalFreeModels(): Promise<ModelInfo[]> {
  const results = await Promise.all(
    REFUSAL_FREE_QUERIES.map(async (query) => {
      try {
        const resp = await fetch(`${FEATHERLESS_CATALOG}?q=${query}&all=true`);
        if (!resp.ok) return [];
        const data = await resp.json();
        const items = Array.isArray(data.data) ? (data.data as Record<string, unknown>[]) : [];
        return items.map(mapModel).filter((m) => m.id);
      } catch {
        return [];
      }
    }),
  );

  const seen = new Set<string>();
  const lane: ModelInfo[] = [];
  for (const list of results) {
    for (const model of list) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      lane.push({ ...model, lane: 'refusal-free' as const });
    }
  }
  const ordered = [...lane.filter((model) => isXortron(model.id)), ...lane.filter((model) => !isXortron(model.id))];
  return ordered.slice(0, REFUSAL_FREE_LIMIT);
}

/**
 * The proxy's own limiter answers 429 with a JSON body. That is not a capacity error, so it must
 * never trigger a model switch or a retry — it surfaces as a plain message instead.
 */
async function readRateLimit(resp: Response): Promise<string | null> {
  if (resp.status !== 429) return null;
  try {
    const body = await resp.clone().json();
    if (body?.error === 'rate_limited' && typeof body.message === 'string') return body.message;
  } catch {
    return null;
  }
  return null;
}

export async function fetchModels(): Promise<{ models: ModelInfo[]; default_model: string }> {
  const [resp, refusalFree] = await Promise.all([
    proxyHeaders().then((h) => fetch(`${SUPABASE_URL}/functions/v1/llm-proxy/models`, { headers: h })),
    fetchRefusalFreeModels(),
  ]);
  if (!resp.ok) {
    throw new Error((await readRateLimit(resp)) ?? `Failed to fetch models: ${resp.status}`);
  }
  const data = await resp.json();
  const catalog: ModelInfo[] = (Array.isArray(data.models) ? data.models : []).map(mapModel);

  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  for (const model of [...refusalFree, ...catalog]) {
    if (!model.id || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(isXortron(model.id) ? { ...model, lane: 'refusal-free' as const } : model);
  }

  // pin the XORTRON line to the top of every view, including the "All" lane
  const pinned = [...models.filter((model) => isXortron(model.id)), ...models.filter((model) => !isXortron(model.id))];
  return { models: pinned, default_model: data.default_model ?? DEFAULT_MODEL };
}

/** Featherless nests its real message inside a JSON string, e.g. plan limits and capacity errors. */
async function readChatError(resp: Response): Promise<string> {
  const text = await resp.text();
  try {
    const parsed = JSON.parse(text);
    const details = parsed?.details;
    if (typeof details === 'string') {
      try {
        const nested = JSON.parse(details);
        const message = nested?.error?.message;
        if (typeof message === 'string' && message) return message;
      } catch {
        // details was not JSON; fall through
      }
    }
    if (typeof parsed?.error === 'string' && parsed.error) return parsed.error;
  } catch {
    // not JSON; fall through
  }
  return text.slice(0, 300) || `Chat failed (${resp.status})`;
}

export interface ChatStreamCallbacks {
  onToken: (token: string) => void;
  onDone: (fullContent: string, toolCalls?: ToolCall[]) => void;
  onError: (error: string) => void;
  /** Fired when the primary model could not answer and the next candidate took over. */
  onModelSwitch?: (from: string, to: string, reason: string) => void;
  /**
   * Fired once per attempt when the provider's own `model` field names something other than the
   * model that was requested — the answer is not from the model the UI says it is.
   */
  onModelServed?: (requested: string, served: string) => void;
  /** Fired instead of onDone/onError when the caller aborted: `partial` is what had streamed. */
  onAbort?: (partial: string) => void;
}

/**
 * A capacity-limited backend answers with a nested Featherless error. Those are worth retrying
 * on another model; auth problems, bad requests and the plan's switch rate limit are not —
 * switching models again would just consume another switch and fail the same way.
 */
/**
 * The plan's switch limit, in every wording we have actually seen from the provider:
 * `model_switching_limit_exceeded`, and the sentence "only allows you to switch models 4 times
 * per minute". Missing the prose form made a 429 look like capacity and triggered exactly the
 * extra switch the limit forbids — observed live, not hypothetically.
 */
const SWITCH_LIMIT = /model_switching_limit_exceeded|switching limit|switche?s?\s+models?|models?\s+switch|\d+\s*times?\s+per\s+minute/i;

export function isRetryableModelError(message: string): boolean {
  if (SWITCH_LIMIT.test(message)) return false;
  return /capacity|overloaded|temporarily unavailable|no available|at capacity|rate.?limit|too many requests|empty response|\b(429|502|503|504)\b|HTTP 5\d\d/i.test(
    message,
  );
}

/** Friendly wording for the plan limit, which otherwise surfaces as raw nested JSON. */
function describeChatError(message: string): string {
  if (SWITCH_LIMIT.test(message)) {
    return 'Featherless is limiting model switches (4 per minute). Wait a few seconds and retry.';
  }
  return message;
}

/**
 * Model reliability, learned from actual completions. A model that just answered goes to the
 * front of the next fallback chain; one that just failed at capacity goes to the back, so a
 * burst of provider trouble is not re-discovered on every request.
 */
const HEALTH_STORAGE_KEY = 'fieldwork.model-health.v1';
const RECENT_FAILURE_MS = 10 * 60 * 1000;

export interface ModelHealth {
  ok: number;
  fail: number;
  lastOk: number;
  lastFail: number;
}

function readHealth(): Record<string, ModelHealth> {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(HEALTH_STORAGE_KEY) : null;
    return raw ? (JSON.parse(raw) as Record<string, ModelHealth>) : {};
  } catch {
    return {};
  }
}

function writeHealth(health: Record<string, ModelHealth>) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(HEALTH_STORAGE_KEY, JSON.stringify(health));
  } catch {
    // storage unavailable or full: reliability is a nicety, never a hard dependency
  }
}

/** Called after every attempt: successes lift a model, capacity failures demote it. */
export function recordModelResult(model: string, ok: boolean, now = Date.now()): void {
  if (!model) return;
  const health = readHealth();
  const entry = health[model] ?? { ok: 0, fail: 0, lastOk: 0, lastFail: 0 };
  if (ok) {
    entry.ok += 1;
    entry.lastOk = now;
  } else {
    entry.fail += 1;
    entry.lastFail = now;
  }
  health[model] = entry;
  writeHealth(health);
}

/** Higher is better. A failure inside the last 10 minutes is a strong demotion. */
function reliability(health: Record<string, ModelHealth>, model: string, now: number): number {
  const entry = health[model];
  if (!entry) return 0;
  const justFailed = entry.lastFail && now - entry.lastFail < RECENT_FAILURE_MS ? -5 : 0;
  return entry.ok - entry.fail * 1.5 + justFailed;
}

/** Public read for tests and diagnostics. */
export function modelReliability(model: string): number {
  return reliability(readHealth(), model, Date.now());
}

/** Snapshot of what has been learned, for display in the picker. */
export function getModelHealth(): Record<string, ModelHealth> {
  return readHealth();
}

/** How many models currently carry a reliability record. */
export function modelHealthCount(): number {
  return Object.keys(readHealth()).length;
}

/** Forget everything learned about model reliability — the chain falls back to lane order. */
export function clearModelHealth(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(HEALTH_STORAGE_KEY);
  } catch {
    // nothing to do: if storage is unavailable there was no history to clear
  }
}

/**
 * Fallback order for a capacity-limited primary: the rest of the XORTRON line first, then the
 * other refusal-free builds, then the general catalogue — each tier sorted by what has actually
 * answered recently.
 */
export function fallbackChain(primary: string, models: ModelInfo[], size = 3): string[] {
  const health = readHealth();
  const now = Date.now();
  const byReliability = (a: ModelInfo, b: ModelInfo) =>
    reliability(health, b.id, now) - reliability(health, a.id, now);

  const candidates = models.filter((model) => model.id && model.id !== primary);
  const lane = [...candidates.filter((model) => model.lane === 'refusal-free')].sort((a, b) => {
    // a model that has actually answered outranks an untried one, whatever the family
    const diff = byReliability(a, b);
    if (diff !== 0) return diff;
    return Number(isXortron(b.id)) - Number(isXortron(a.id));
  });
  const rest = candidates.filter((model) => model.lane !== 'refusal-free').sort(byReliability);

  const seen = new Set<string>();
  return [...lane, ...rest]
    .map((model) => model.id)
    .filter((id) => (seen.has(id) ? false : (seen.add(id), true)))
    .slice(0, size);
}

interface AttemptResult {
  ok: boolean;
  error: string;
  tokens: number;
  content: string;
  retryable: boolean;
  /** the caller cancelled: not a failure, so it must not trigger a fallback or an error toast */
  aborted?: boolean;
  /** tools the model asked to call this turn, in the order the stream carried them */
  toolCalls?: ToolCall[];
}

const wasAborted = (signal?: AbortSignal, error?: unknown): boolean =>
  Boolean(signal?.aborted) || (error instanceof DOMException && error.name === 'AbortError');

/** A tool the model may call, in the OpenAI shape the proxy forwards untouched. */
export interface ChatTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** One call the model asked for, reassembled from the streamed deltas. */
export interface ToolCall {
  id: string;
  name: string;
  /** the arguments as the model wrote them, still a JSON string */
  arguments: string;
}

/**
 * The tool itself: the model may search again when the sources it was handed do not answer.
 *
 * One shot retrieval assumes the first query is the right one. It often is not — the answer needs a
 * paper the fusion list did not reach, or a term the first pass spelled differently — and the model
 * has no way to say so. This gives it that way, with the same engines the app uses.
 */
export const SEARCH_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: 'search_web',
    description:
      'Search the web again. Use it when the sources already provided do not answer the question, are too few, or miss the specific thing asked for. Each call runs the real search engines and returns fresh results.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query. Be specific; operators are allowed.' },
      },
      required: ['query'],
    },
  },
};

/**
 * Whether a stream chunk's `model` names a different model than the one requested.
 *
 * The OpenAI-shaped stream repeats `model` on every chunk, but nothing obliges the provider to echo
 * back the id it was given: an alias, a queue fallback under load, or a capability downgrade can all
 * answer as a different model. Comparison is on the trimmed, case-folded id, because the field is a
 * provider's own spelling of it; an empty or missing field claims nothing and is not a mismatch.
 */
export function servedModelMismatch(requested: string, served: string | null | undefined): boolean {
  const asked = String(requested ?? '').trim();
  const got = String(served ?? '').trim();
  if (!asked || !got) return false;
  return got.toLowerCase() !== asked.toLowerCase();
}

/** One model, one stream. Never reports failure itself — the caller decides whether to fall back. */
async function streamAttempt(
  model: string,
  messages: { role: string; content: string }[],
  callbacks: ChatStreamCallbacks,
  temperature?: number,
  signal?: AbortSignal,
  tools?: ChatTool[],
): Promise<AttemptResult> {
  // declared outside the try so a cancel can hand back what already streamed
  let content = '';
  let tokens = 0;
  // one warning per attempt: every chunk repeats the model, and a per-chunk warning is noise
  let servedWarned = false;
  // tool calls arrive as deltas keyed by index: the name and id come once, the arguments in pieces
  const pendingCalls = new Map();
  try {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/llm-proxy/chat`, {
      method: 'POST',
      headers: await proxyHeaders(),
      body: JSON.stringify({ model, messages, stream: true, temperature, ...(tools && tools.length ? { tools } : {}) }),
      signal,
    });

    if (!resp.ok) {
      const limited = await readRateLimit(resp);
      if (limited) return { ok: false, error: limited, tokens: 0, content: '', retryable: false };

      const raw = await readChatError(resp);
      // classify the provider's own wording, before it is rewritten for display
      const retryable = isRetryableModelError(`${raw} (HTTP ${resp.status})`);
      return {
        ok: false,
        error: `${describeChatError(raw)} (HTTP ${resp.status})`,
        tokens: 0,
        content: '',
        retryable,
      };
    }

    const reader = resp.body?.getReader();
    if (!reader) {
      return { ok: false, error: 'No response stream available', tokens: 0, content: '', retryable: true };
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      // stop as soon as the caller cancels, without waiting for the next token to arrive
      if (signal?.aborted) {
        void reader.cancel().catch(() => {});
        return { ok: false, error: 'Stopped', tokens, content, retryable: false, aborted: true };
      }
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') {
          buffer = '';
          break;
        }
        try {
          const parsed = JSON.parse(dataStr);
          // the provider names the model it actually ran; say so once if it is not the one asked for
          if (!servedWarned && servedModelMismatch(model, parsed?.model)) {
            servedWarned = true;
            console.warn(`llm-proxy served ${parsed.model} for requested ${model}`);
            callbacks.onModelServed?.(model, String(parsed.model).trim());
          }
          for (const delta of parsed?.choices?.[0]?.delta?.tool_calls ?? []) {
            const index = Number(delta?.index ?? 0);
            const call = pendingCalls.get(index) ?? { id: '', name: '', arguments: '' };
            if (delta?.id) call.id = String(delta.id);
            if (delta?.function?.name) call.name = String(delta.function.name);
            if (delta?.function?.arguments) call.arguments += String(delta.function.arguments);
            pendingCalls.set(index, call);
          }
          const token = parsed?.choices?.[0]?.delta?.content ?? '';
          if (token) {
            content += token;
            tokens += 1;
            callbacks.onToken(token);
          }
        } catch {
          // Skip malformed JSON
        }
      }
    }

    const toolCalls = [...pendingCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => call)
      .filter((call) => call.name);

    // a turn that ends in a tool call has no prose yet, and that is not an empty response
    if (!content.trim() && toolCalls.length === 0) {
      return {
        ok: false,
        error: `${model} returned an empty response (likely at capacity)`,
        tokens: 0,
        content: '',
        retryable: true,
      };
    }
    return { ok: true, error: '', tokens, content, retryable: false, toolCalls };
  } catch (err) {
    if (wasAborted(signal, err)) {
      return { ok: false, error: 'Stopped', tokens, content, retryable: false, aborted: true };
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, error: message, tokens: 0, content: '', retryable: true };
  }
}

/** What one model turn produced: prose, tool calls, or a failure worth reporting. */
export interface TurnResult {
  ok: boolean;
  content: string;
  toolCalls: ToolCall[];
  error: string;
  aborted: boolean;
}

/**
 * One model turn as a value rather than a callback stream.
 *
 * The search-tool loop makes several turns in a row and has to read each one before it can decide
 * what the next should contain, so `onDone` is the wrong shape for it. Tokens still arrive through
 * the same callbacks, so the UI streams exactly as it did before.
 */
export async function streamTurn(
  model: string,
  messages: { role: string; content: string }[],
  callbacks: Pick<ChatStreamCallbacks, 'onToken' | 'onModelSwitch' | 'onModelServed'>,
  options: { temperature?: number; fallbacks?: string[]; signal?: AbortSignal; tools?: ChatTool[] } = {},
): Promise<TurnResult> {
  let content = '';
  let toolCalls: ToolCall[] = [];
  let error = '';
  let aborted = false;
  await chatCompletion(
    model,
    messages,
    {
      onToken: callbacks.onToken,
      onModelSwitch: callbacks.onModelSwitch,
      onModelServed: callbacks.onModelServed,
      onDone: (fullContent, calls) => {
        content = fullContent;
        toolCalls = calls ?? [];
      },
      onError: (message) => {
        error = message;
      },
      onAbort: (partial) => {
        aborted = true;
        content = partial;
      },
    },
    options.temperature,
    options.fallbacks ?? [],
    options.signal,
    { tools: options.tools },
  );
  return { ok: !error && !aborted, content, toolCalls, error, aborted };
}

/**
 * Stream a completion, degrading through `fallbacks` when the chosen model is capacity-limited.
 * A model that already streamed tokens never triggers a fallback — the answer would be spliced
 * together from two models.
 */
export async function chatCompletion(
  model: string,
  messages: { role: string; content: string }[],
  callbacks: ChatStreamCallbacks,
  temperature?: number,
  fallbacks: string[] = [],
  signal?: AbortSignal,
  options: { tools?: ChatTool[] } = {},
) {
  const chain = [model, ...fallbacks.filter((candidate) => candidate && candidate !== model)];
  let lastError = `${model} is unavailable`;

  for (const [index, current] of chain.entries()) {
    if (signal?.aborted) {
      callbacks.onAbort?.('');
      return;
    }
    const attempt = await streamAttempt(current, messages, callbacks, temperature, signal, options.tools);
    // a cancelled run owns no answer: no fallback, no error, no onDone
    if (attempt.aborted) {
      callbacks.onAbort?.(attempt.content);
      return;
    }
    if (attempt.ok) {
      recordModelResult(current, true);
      callbacks.onDone(attempt.content, attempt.toolCalls ?? []);
      return;
    }

    // only provider-side trouble says anything about the model's reliability
    if (attempt.retryable) recordModelResult(current, false);

    lastError = attempt.error;
    const next = chain[index + 1];
    const canFallBack = attempt.retryable && attempt.tokens === 0 && Boolean(next);
    if (!canFallBack) break;

    callbacks.onModelSwitch?.(current, next, attempt.error);
    // give the provider a moment between attempts instead of hammering it
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  callbacks.onError(lastError);
}

export async function webSearch(
  query: string,
  engines: string[],
  maxResultsPerEngine: number,
  useDorks: boolean,
  preset: string,
  compileQueries = true,
  /** lets the caller cancel a run that a newer search has superseded */
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/web-search`, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      query,
      engines,
      maxResultsPerEngine,
      useDorks,
      preset,
      compileQueries,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Search failed (${resp.status}): ${errText}`);
  }

  return resp.json();
}

/**
 * Which secrets the deployed function holds. Names only, never values.
 *
 * `null` means the question could not be answered — an older deployment without the probe, offline,
 * or a non-200 — and the composer must keep saying "unknown" rather than claiming the engine is
 * unconfigured, which it cannot know.
 */
export async function fetchConfiguredSecrets(): Promise<string[] | null> {
  try {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/web-search`, { method: 'GET', headers });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { configured?: unknown };
    if (!Array.isArray(data.configured)) return null;
    return data.configured.filter((name): name is string => typeof name === 'string');
  } catch {
    return null;
  }
}

export type { Source };
