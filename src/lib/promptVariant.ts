/**
 * A swappable system prompt, stored per account on this device.
 *
 * The prompt is behaviour — budget, claim ledger, citation rules — so testing a variant means
 * changing it without a build or a deploy. It is deliberately *not* stored in Supabase: this is a
 * local authoring knob, and a variant that turns out to be worse should not follow the account onto
 * another machine. Empty or whitespace-only means "use the built-in prompt", so the default can
 * never be lost by saving an empty box.
 */
import { FIELDWORK_SYSTEM_PROMPT } from './systemPrompt';

/** The ceiling the prompt states, exported so the UI can flag a variant that exceeds it. */
export const ANSWER_BUDGET_WORDS = 600;

export interface PromptStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

const PREFIX = 'fieldwork:prompt:';

/** localStorage, or null when there is none (tests, SSR) — never throws. */
function defaultStorage(): PromptStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function promptStorageKey(userId?: string): string {
  return `${PREFIX}${userId ?? 'anonymous'}`;
}

/** The saved variant, or null when this account has none (or only blank text). */
export function readPromptVariant(userId?: string, storage: PromptStorage | null = defaultStorage()): string | null {
  if (!storage) return null;
  try {
    const text = storage.getItem(promptStorageKey(userId));
    return text && text.trim() ? text : null;
  } catch {
    return null;
  }
}

/** Save a variant; blank text clears it and restores the built-in prompt. */
export function savePromptVariant(
  userId: string | undefined,
  text: string,
  storage: PromptStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    if (!text.trim()) storage.removeItem(promptStorageKey(userId));
    else storage.setItem(promptStorageKey(userId), text);
  } catch {
    // a full or blocked storage must not break sending a message; the built-in prompt still works
  }
}

export function clearPromptVariant(userId?: string, storage: PromptStorage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(promptStorageKey(userId));
  } catch {
    // ignore
  }
}

/** What this account actually answers with. */
export function systemPromptFor(userId?: string, storage: PromptStorage | null = defaultStorage()): string {
  return readPromptVariant(userId, storage) ?? FIELDWORK_SYSTEM_PROMPT;
}

export function promptWordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export interface PromptVariantStatus {
  /** which prompt the next turn will send */
  source: 'default' | 'variant';
  words: number;
  /** a variant longer than the ceiling contradicts the budget it is supposed to enforce */
  overBudget: boolean;
}

export function describePromptVariant(variant: string | null): PromptVariantStatus {
  if (!variant) {
    return { source: 'default', words: promptWordCount(FIELDWORK_SYSTEM_PROMPT), overBudget: false };
  }
  const words = promptWordCount(variant);
  return { source: 'variant', words, overBudget: words > ANSWER_BUDGET_WORDS };
}
