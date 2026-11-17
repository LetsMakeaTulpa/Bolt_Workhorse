/**
 * The search-tool loop: the model may ask for another search mid-answer.
 *
 * One-shot retrieval assumes the first query was the right one. When it was not — the specific paper
 * was never reached, the term was spelled differently, the first pass was thin — the model had no way
 * to say so and answered around the gap. Here it can call `search_web`, the loop runs the same
 * engines the app uses, hands the results back as a tool message, and lets it answer again.
 *
 * The loop is bounded on purpose: every call costs four engines' worth of quota, and a model that
 * can search indefinitely will keep searching instead of writing. `maxSearches` is the budget after
 * the first pass, and once it is spent the next turn is asked without tools, so it has to answer.
 */
import type { ChatTool, ToolCall } from './api';

/** A message in the OpenAI shape the proxy forwards: tool turns carry ids, not just prose. */
export interface ToolMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** assistant turns that asked for tools carry the calls, in the provider's shape */
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  /** tool turns answer one call */
  tool_call_id?: string;
  name?: string;
}

export interface TurnOutput {
  ok: boolean;
  content: string;
  toolCalls: ToolCall[];
  error?: string;
  aborted?: boolean;
}

export interface SearchOutcome {
  count: number;
  /** what the model is shown: a compact result block, or why there is none */
  text: string;
}

export interface SearchToolLoopOptions {
  messages: ToolMessage[];
  tools: ChatTool[];
  /** one model turn; tokens are already delivered through the caller's callbacks */
  stream: (messages: ToolMessage[], tools: ChatTool[]) => Promise<TurnOutput>;
  /** runs the real search for one query */
  runSearch: (query: string) => Promise<SearchOutcome>;
  /** extra searches allowed beyond the first pass */
  maxSearches?: number;
  /** called as each tool search starts, so the UI can log it */
  onSearch?: (query: string, index: number) => void;
}

export interface SearchToolRun {
  content: string;
  searches: string[];
  stoppedBy: 'done' | 'limit' | 'aborted' | 'error';
  error?: string;
  /** every turn as the provider saw it, which is how the call/tool pairing is asserted */
  transcript: ToolMessage[];
}

/** The query a call asked for, or '' when the arguments are not a usable query. */
export function queryFromToolCall(args: string): string {
  const raw = String(args ?? '').trim();
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as { query?: unknown };
    const query = typeof parsed?.query === 'string' ? parsed.query.trim() : '';
    if (query) return query;
  } catch {
    // a model that wrote a bare query instead of JSON is still asking for that search
  }
  // only fall back to the raw text when it is a sentence, not half a JSON object or a quoted string
  const bare = raw.replace(/^["']+|["']+$/g, '').trim();
  return bare.startsWith('{') || bare.startsWith('[') ? '' : bare.slice(0, 300);
}

const asProviderCall = (call: ToolCall) => ({
  id: call.id || `call_${Math.random().toString(36).slice(2, 10)}`,
  type: 'function' as const,
  function: { name: call.name, arguments: call.arguments || '{}' },
});

export async function runSearchToolLoop({
  messages,
  tools,
  stream,
  runSearch,
  maxSearches = 2,
  onSearch,
}: SearchToolLoopOptions): Promise<SearchToolRun> {
  const transcript: ToolMessage[] = [...messages];
  const searches: string[] = [];
  let lastContent = '';

  // one turn per search plus the ones that answer; the guard is the budget, not the count
  for (let round = 0; round <= maxSearches + 1; round += 1) {
    const allowTools = searches.length < maxSearches;
    const turn = await stream(transcript, allowTools ? tools : []);

    if (turn.aborted) {
      return { content: turn.content, searches, stoppedBy: 'aborted', transcript };
    }
    if (!turn.ok) {
      return { content: turn.content || lastContent, searches, stoppedBy: 'error', error: turn.error, transcript };
    }

    lastContent = turn.content;
    if (turn.toolCalls.length === 0) {
      transcript.push({ role: 'assistant', content: turn.content });
      return { content: turn.content, searches, stoppedBy: 'done', transcript };
    }

    // The turn that asked is part of the conversation, and its tool answers must carry the same call
    // id it used. Building the provider calls once means a model that omitted ids still gets a tool
    // message that answers the id in the assistant turn, instead of a second invented one.
    const calls = turn.toolCalls.map(asProviderCall);
    transcript.push({ role: 'assistant', content: turn.content, tool_calls: calls });

    for (const call of calls) {
      const callId = call.id;
      const name = call.function.name;
      if (name !== 'search_web') {
        transcript.push({
          role: 'tool',
          tool_call_id: callId,
          name,
          content: `No tool named ${name}. The only tool is search_web.`,
        });
        continue;
      }
      if (searches.length >= maxSearches) {
        transcript.push({
          role: 'tool',
          tool_call_id: callId,
          name: 'search_web',
          content: `Search budget spent (${maxSearches} extra searches). Answer with the sources you already have.`,
        });
        continue;
      }
      const query = queryFromToolCall(call.function.arguments);
      if (!query) {
        transcript.push({
          role: 'tool',
          tool_call_id: callId,
          name: 'search_web',
          content: 'search_web needs a "query" string. Call it again with {"query": "..."}.',
        });
        continue;
      }
      searches.push(query);
      onSearch?.(query, searches.length);
      const outcome = await runSearch(query);
      transcript.push({ role: 'tool', tool_call_id: callId, name: 'search_web', content: outcome.text });
    }
  }

  // only reachable if the model keeps asking without the budget allowing it
  return { content: lastContent, searches, stoppedBy: 'limit', transcript };
}
