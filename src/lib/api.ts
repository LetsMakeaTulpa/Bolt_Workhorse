import type { ModelInfo, SearchResponse, Source } from '../types';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

const headers = {
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json',
  'X-Client-Info': 'fieldwork',
};

export async function fetchModels(): Promise<{ models: ModelInfo[]; default_model: string }> {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/llm-proxy/models`, { headers });
  if (!resp.ok) throw new Error(`Failed to fetch models: ${resp.status}`);
  const data = await resp.json();
  return { models: data.models ?? [], default_model: data.default_model ?? 'Qwen/Qwen2.5-7B-Instruct' };
}

export interface ChatStreamCallbacks {
  onToken: (token: string) => void;
  onDone: (fullContent: string) => void;
  onError: (error: string) => void;
}

export async function chatCompletion(
  model: string,
  messages: { role: string; content: string }[],
  callbacks: ChatStreamCallbacks,
  temperature?: number,
) {
  try {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/llm-proxy/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages, stream: true, temperature }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      callbacks.onError(`Chat failed (${resp.status}): ${errText}`);
      return;
    }

    const reader = resp.body?.getReader();
    if (!reader) {
      callbacks.onError('No response stream available');
      return;
    }

    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';

    while (true) {
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
          callbacks.onDone(fullContent);
          return;
        }
        try {
          const parsed = JSON.parse(dataStr);
          const token = parsed?.choices?.[0]?.delta?.content ?? '';
          if (token) {
            fullContent += token;
            callbacks.onToken(token);
          }
        } catch {
          // Skip malformed JSON
        }
      }
    }
    callbacks.onDone(fullContent);
  } catch (err) {
    callbacks.onError(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function webSearch(
  query: string,
  engines: string[],
  maxResultsPerEngine: number,
  useDorks: boolean,
  preset: string,
): Promise<SearchResponse> {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/web-search`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query,
      engines,
      maxResultsPerEngine,
      useDorks,
      preset,
      compileQueries: true,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Search failed (${resp.status}): ${errText}`);
  }

  return resp.json();
}

export type { Source };
