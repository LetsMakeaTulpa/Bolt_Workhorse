/**
 * The schema probes the drift gate runs, derived from the migration files themselves.
 *
 * A hand-written list is a gate with a hole the size of its own maintenance: a migration nobody
 * remembered to add was a migration nobody checked. Reading the SQL closes that hole — the only way
 * to add schema without a probe is to write a construct this file does not recognise, which is
 * reported as unprobed rather than passing silently.
 *
 * "Queryable" is what PostgREST can be asked about with the anon key: tables, views and the columns
 * they gain. Policies, grants, indexes, functions and triggers are not probed; the app never asks
 * the API for them.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIR = fileURLToPath(new URL('../supabase/migrations', import.meta.url));

/** `"quoted name"` or a bare identifier. */
const IDENT = String.raw`(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)`;
/** `name` or `schema.name`, capturing both halves. */
const QUALIFIED = new RegExp(String.raw`^\s*(${IDENT})(?:\s*\.\s*(${IDENT}))?`, 'i');

/** Create kinds that are not queryable: their absence cannot be what breaks the app. */
const NOT_QUERYABLE = new Set([
  'index', 'function', 'procedure', 'trigger', 'policy', 'type', 'sequence', 'extension', 'schema',
  'role', 'rule', 'publication', 'subscription', 'domain', 'aggregate', 'operator', 'cast',
  'collation', 'statistics', 'server', 'constraint', 'database', 'tablespace', 'language',
  'conversion', 'transform', 'access', 'text', 'event', 'user', 'foreign', 'unique',
]);

/** Leading words that may sit between `create` and the object kind. */
const MODIFIERS = new Set(['or', 'replace', 'temp', 'temporary', 'unlogged', 'global', 'local', 'recursive']);

/** `add` clauses that introduce something that is not a column. */
const NOT_A_COLUMN = new Set([
  'constraint', 'primary', 'unique', 'check', 'foreign', 'exclude', 'trigger', 'policy', 'statistics',
]);

const unquote = (name) => name.replace(/^"/, '').replace(/"$/, '').replace(/""/g, '"');

/** An object the anon probe can never reach is a blind spot, whatever adds it. */
const outsidePublic = (migration, subject) => ({
  migration,
  reason: `\`${subject}\` is outside the public schema, so the anon probe can never reach it`,
});

/**
 * Split SQL at top-level semicolons. A `;` inside a string, a quoted identifier or a `$$ … $$` body
 * does not end a statement, so the `create table` after `consume_rate_limit` is still its own.
 */
export function splitStatements(sql) {
  const statements = [];
  let current = '';
  let i = 0;
  let dollarTag = null;

  while (i < sql.length) {
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      current += sql[i++];
      continue;
    }

    const two = sql.slice(i, i + 2);
    if (two === '--') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      current += ' ';
      continue;
    }
    if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      current += ' ';
      continue;
    }

    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      // a string literal (`''` escapes the quote) or a quoted identifier (`""`)
      current += ch;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch && sql[j + 1] === ch) {
          current += ch + ch;
          j += 2;
          continue;
        }
        current += sql[j];
        j++;
        if (sql[j - 1] === ch) break;
      }
      i = j;
      continue;
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (tag) {
        dollarTag = tag[0];
        current += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }
    if (ch === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      i++;
      continue;
    }
    current += ch;
    i++;
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}

/** The object a `create …` statement builds, or null when the statement is not a create. */
function createdObject(statement) {
  // `[\s\S]`, not `.`: every real `create table` is several lines long, and a dot-terminated pattern
  // would classify all of them as "not a create".
  const head = /^create\b([\s\S]*)$/i.exec(statement);
  if (!head) return null;

  const rest = head[1].trim();
  const words = rest.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? [];
  let index = 0;
  while (index < words.length && MODIFIERS.has(words[index])) index++;

  const kindWords = [words[index], words[index + 1]];
  // two-word kinds, before the single-word fallbacks below
  const twoWord = kindWords.join(' ');
  if (twoWord === 'materialized view') return { kind: 'view', rest, skip: index + 2 };
  if (twoWord === 'foreign table') return { kind: 'table', rest, skip: index + 2 };
  if (twoWord === 'foreign data' || twoWord === 'event trigger' || twoWord === 'user mapping' || twoWord === 'text search') {
    return { kind: 'ignore', rest, skip: index + 2 };
  }

  if (kindWords[0] === 'table' || kindWords[0] === 'view') {
    return { kind: kindWords[0], rest, skip: index + 1 };
  }
  if (NOT_QUERYABLE.has(kindWords[0])) return { kind: 'ignore', rest, skip: index + 1 };
  return { kind: 'unknown', rest, skip: index + 1, word: kindWords[0] ?? '' };
}

/**
 * Everything one migration adds that the gate should be able to see: the probes it could name, and
 * separately the statements that add schema but could not be named — a `DO` block that runs
 * `create table`, a kind this file has no rule for, an object outside `public`.
 */
export function probesFromSql(sql, migration = '<sql>') {
  const probes = [];
  const unprobed = [];

  for (const statement of splitStatements(sql)) {
    const created = createdObject(statement);
    if (created) {
      if (created.kind === 'ignore') continue;
      if (created.kind === 'unknown') {
        unprobed.push({
          migration,
          reason: `\`create ${created.word || '…'}\` is not a construct this probe knows, so whatever it adds would go unchecked`,
        });
        continue;
      }
      // drop the words already read, then the optional `if not exists`
      const afterKind = created.rest.trim().split(/\s+/).slice(created.skip).join(' ');
      const target = QUALIFIED.exec(afterKind.replace(/^if\s+not\s+exists\s+/i, ''));
      if (!target) {
        unprobed.push({ migration, reason: `could not read the name a \`create ${created.kind}\` builds` });
        continue;
      }
      const [, first, second] = target;
      const schema = second ? unquote(first) : null;
      const name = unquote(second ?? first);
      if (schema && schema.toLowerCase() !== 'public') {
        unprobed.push(outsidePublic(migration, `${schema}.${name}`));
        continue;
      }
      probes.push({ migration, label: name, table: name });
      continue;
    }

    const altered = new RegExp(String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${IDENT})(?:\s*\.\s*(${IDENT}))?`, 'i').exec(
      statement,
    );
    if (altered) {
      const schema = altered[2] ? unquote(altered[1]) : null;
      const table = unquote(altered[2] ?? altered[1]);
      if (schema && schema.toLowerCase() !== 'public') {
        // a column on a table the anon probe cannot reach is the same hole as an unreadable create
        if (/\badd\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?/i.test(statement)) {
          unprobed.push(outsidePublic(migration, `alter table ${schema}.${table}`));
        }
        continue;
      }
      const addColumn = /\badd\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?("(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)/gi;
      for (const match of statement.matchAll(addColumn)) {
        const column = unquote(match[1]);
        if (NOT_A_COLUMN.has(column.toLowerCase())) continue;
        probes.push({ migration, label: `${table}.${column}`, table, column });
      }
      continue;
    }

    // Dynamic SQL can build anything; naming what it builds would mean running it.
    if (/^do\b/i.test(statement)) {
      if (/\bcreate\s+(?:or\s+replace\s+)?(?:table|view|materialized\s+view)\b|\badd\s+column\b/i.test(statement)) {
        unprobed.push({
          migration,
          reason: 'a `do` block adds objects, which this probe cannot name without executing the migration',
        });
      }
    }
  }

  return { probes, unprobed };
}

/**
 * Every probe the migration set describes, in apply order, with the objects deduplicated by the
 * first migration that created them.
 */
export function migrationProbes(dir = DEFAULT_DIR) {
  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const probes = [];
  const unprobed = [];
  const seen = new Set();

  for (const migration of files) {
    const result = probesFromSql(readFileSync(`${dir}/${migration}`, 'utf8'), migration);
    for (const item of result.unprobed) unprobed.push(item);
    for (const probe of result.probes) {
      const key = probe.column ? `${probe.table}.${probe.column}` : probe.table;
      if (seen.has(key)) continue;
      seen.add(key);
      probes.push(probe);
    }
  }

  return { probes, unprobed, files };
}
