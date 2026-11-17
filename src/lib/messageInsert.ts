/**
 * Saving an assistant message has to survive a database that is a migration behind.
 *
 * The hosted project has no `messages.system_prompt` column yet, and PostgREST answers an insert
 * that names it with a 400. The answer then exists only in React state: it streams fine, and it is
 * gone on reload — a chat that forgets every reply. Until the migration is applied, drop the column
 * the server says it does not have, save the answer, and record what was dropped rather than
 * pretending the row is complete.
 *
 * Only a missing-column error is retried. A rejected row (RLS, bad FK, a constraint) is returned as
 * it is, because retrying it without a column would hide the real failure.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface MessageInsertOutcome<T> {
  data: T | null;
  error: { message?: string } | null;
  /** columns the server does not have, dropped so the rest of the row could be saved */
  dropped: string[];
}

/** The column PostgREST names in a "does not exist" / schema-cache error, if it is one. */
export function missingColumnFrom(error: unknown, table = 'messages'): string | null {
  const message =
    typeof error === 'string' ? error : ((error as { message?: string } | null)?.message ?? '');
  if (!message) return null;
  const postgres = new RegExp(`column\\s+(?:\\w+\\.)?${table}\\.([a-z_][a-z0-9_]*)\\s+does not exist`, 'i').exec(message);
  if (postgres) return postgres[1];
  const schemaCache = /could not find the '([a-z_][a-z0-9_]*)' column/i.exec(message);
  if (schemaCache) return schemaCache[1];
  return null;
}

/**
 * Columns this session already learned the database does not have.
 *
 * Without this, every single answer pays a guaranteed 400 before the retry — the row saves, but the
 * console shows a failed request for every message and looks like the save is still broken. Learnt
 * per session with an expiry, so applying the migration and reloading picks the column back up.
 */
const learnt = new Map<string, number>();
const RELEARN_AFTER_MS = 10 * 60 * 1000;
const keyFor = (table: string, column: string) => `${table}.${column}`;

/** Forget what earlier inserts learnt (tests, and a manual retry after applying a migration). */
export function resetLearntColumns(): void {
  learnt.clear();
}

/**
 * Insert one row into a table, retrying without any column the server reports as missing.
 * Returns the saved row (when `select` is asked for) and the names of anything dropped.
 */
export async function insertRowTolerant<T>(
  client: SupabaseClient,
  table: string,
  row: Record<string, unknown>,
  { select = true, maxDrops = 4 }: { select?: boolean; maxDrops?: number } = {},
): Promise<MessageInsertOutcome<T>> {
  const payload: Record<string, unknown> = { ...row };
  const dropped: string[] = [];

  for (const column of Object.keys(payload)) {
    const learntAt = learnt.get(keyFor(table, column));
    if (learntAt && Date.now() - learntAt < RELEARN_AFTER_MS) {
      delete payload[column];
      dropped.push(column);
    }
  }

  for (let attempt = 0; attempt <= maxDrops; attempt += 1) {
    const query = client.from(table).insert(payload);
    const { data, error } = select
      ? await query.select().single()
      : await query;
    if (!error) return { data: (data as T) ?? null, error: null, dropped };

    const missing = missingColumnFrom(error, table);
    if (!missing || !(missing in payload)) return { data: null, error, dropped };
    delete payload[missing];
    dropped.push(missing);
    learnt.set(keyFor(table, missing), Date.now());
  }

  return { data: null, error: { message: `could not save the row: ${dropped.join(', ')} rejected` }, dropped };
}

const noted = new Set<string>();

/**
 * Say once per session, and once in the trail, that a row was saved without some of its columns.
 * Silent column-dropping would turn a schema gap into an invisible provenance gap.
 */
export async function noteDroppedColumns(
  dropped: string[],
  log?: (message: string, detail: Record<string, unknown>) => Promise<unknown> | void,
): Promise<void> {
  if (dropped.length === 0) return;
  const key = [...dropped].sort().join(',');
  if (noted.has(key)) return;
  noted.add(key);
  const message = `Saved without ${dropped.join(', ')}: that column is not in the database yet (apply the pending migration)`;
  console.warn(`[fieldwork] ${message}`);
  if (log) await log(message, { dropped_columns: dropped });
}

/** Reset the once-per-session warning (tests). */
export function resetDroppedColumnNotices(): void {
  noted.clear();
}
