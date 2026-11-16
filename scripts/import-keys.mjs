#!/usr/bin/env node
// Sorts a pasted pile of API keys into the places this app can actually use.
//
// Dump keys into `keys.txt` (gitignored) in whatever shape you like — labelled lines, bare
// tokens, several per line, `NAME=value`, `export NAME=value` — and this works out what each
// one is and writes `.env.functions` in the exact names the edge functions read.
// Values are never printed: the report shows providers, counts and destination names only.
//
//   npm run keys:import              # classify, write .env.functions, send nothing
//   npm run keys:apply               # + push to Supabase and redeploy web-search
//   node scripts/import-keys.mjs other.txt --out-dir ./tmp-keys
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const PROJECT_REF = 'mhfsggpnnjyxsnshqatf';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const outDirFlag = args.indexOf('--out-dir');
const OUT_DIR = outDirFlag >= 0 ? args[outDirFlag + 1] : '.';
const FILE = args.find((a, i) => !a.startsWith('-') && (outDirFlag < 0 || i !== outDirFlag + 1)) ?? 'keys.txt';

const USE_STDIN = args.includes('--stdin');
if (!USE_STDIN && !existsSync(FILE)) {
  console.error(`No key dump found at ${FILE}.`);
  console.error('Paste your keys into that file (one per line, labels welcome), then run this again.');
  console.error('Or paste them straight into the terminal:  npm run keys:paste');
  process.exit(1);
}

/** Providers this app can actually use, and the secret name its edge function reads. */
const WIRED = {
  exa: 'EXA_API_KEY',
  tavily: 'TAVILY_API_KEY',
  firecrawl: 'FIRECRAWL_API_KEY',
  google: 'GOOGLE_API_KEY',
  'google cse': 'GOOGLE_CSE_ID',
  shodan: 'SHODAN_API_KEY',
  urlscan: 'URLSCAN_API_KEY',
  searxng: 'SEARXNG_URL',
  grepapp: 'GREPAPP_COOKIE',
  'grep mirror': 'GREPAPP_BASE_URL',
};

/** Recognised, but nothing in this app reads them — reported so you can revoke them. */
const UNWIRED = new Set([
  'openai', 'anthropic', 'openrouter', 'mistral', 'you.com', 'kimi', 'parallel', 'jina',
  'felo', 'groq', 'kaggle', 'kilo', 'venice', 'ollama', 'fal.ai', 'serper', 'openai like',
]);

const LABELS = [
  [/you[\s._-]?com/i, 'you.com'],
  [/\bkimi\b|moonshot/i, 'kimi'],
  [/parallel/i, 'parallel'],
  [/codex/i, 'openai'],
  [/open\s*_?router/i, 'openrouter'],
  [/open\s*_?ai/i, 'openai'],
  [/anthropic|claude/i, 'anthropic'],
  [/\bexa\b/i, 'exa'],
  [/firecrawl/i, 'firecrawl'],
  [/tavily/i, 'tavily'],
  [/mistral/i, 'mistral'],
  [/jina/i, 'jina'],
  [/felo/i, 'felo'],
  [/venice/i, 'venice'],
  [/\bgroq\b/i, 'groq'],
  [/kaggle/i, 'kaggle'],
  [/\bkilo\b/i, 'kilo'],
  [/ollama/i, 'ollama'],
  [/fal\.?ai|fai\.ia/i, 'fal.ai'],
  [/serper/i, 'serper'],
  [/featherless|aviary/i, 'featherless'],
  [/shodan/i, 'shodan'],
  [/urlscan/i, 'urlscan'],
  [/searxng/i, 'searxng'],
  // the CSE id and the mirror must be matched before the bare provider names
  [/cse[\s_-]?id|\bprogrammable search\b/i, 'google cse'],
  [/grep\.?app.*(mirror|base)|\bgrep mirror\b/i, 'grep mirror'],
  [/grep\.?app/i, 'grepapp'],
  [/\bgoogle\b|\bcse\b/i, 'google'],
];

/** Shape detection, most specific first. Unanchored so keys stuck to a label are still found. */
const SHAPES = [
  [/rc_[0-9a-f]{32,}/i, 'featherless'],
  [/sk-or-v1-[A-Za-z0-9]{20,}/, 'openrouter'],
  [/sk-ant-[A-Za-z0-9_-]{20,}/, 'anthropic'],
  [/sk-proj-[A-Za-z0-9_-]{20,}/, 'openai'],
  [/tvly-[A-Za-z0-9-]{10,}/i, 'tavily'],
  [/fc-[0-9a-f]{16,}/i, 'firecrawl'],
  [/ydc-sk-[A-Za-z0-9_-]{10,}/, 'you.com'],
  [/gsk_[A-Za-z0-9]{20,}/, 'groq'],
  [/KGAT_[0-9a-f]+/i, 'kaggle'],
  [/jina_[A-Za-z0-9]{20,}/i, 'jina'],
  [/fk-[A-Za-z0-9]{20,}/, 'felo'],
  [/eyJ[A-Za-z0-9_.-]{40,}/, 'kilo'],
  [/VENICE[-_][A-Za-z0-9_-]{10,}/i, 'venice'],
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{20,}/i, 'fal.ai'],
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, 'exa'],
  [/[0-9a-f]{32}\.[A-Za-z0-9]{10,}/i, 'ollama'],
  [/sk-[A-Za-z0-9_-]{40,}/, 'openai like'],
  [/[0-9a-f]{40}/i, 'serper'],
  [/[0-9a-f]{32}/i, 'mistral'],
  [/[A-Za-z0-9]{28,40}/, 'parallel'],
];

const GENERIC = new Set(['parallel', 'openai like', 'mistral', 'serper']);

const labelFor = (text) => LABELS.find(([re]) => re.test(text))?.[1] ?? null;

/** Returns { provider, value } when the token contains a key, else null. */
function classify(token) {
  if (token.length < 16) return null;
  for (const [re, provider] of SHAPES) {
    const match = token.match(re);
    if (match && match[0] === token) return { provider, value: token };
  }
  for (const [re, provider] of SHAPES) {
    const match = token.match(re);
    if (match && match[0].length >= 16) return { provider, value: match[0] };
  }
  return null;
}

const isSeparator = (line) => line.length === 0 || /^[=\-_*~#]{3,}$/.test(line.replace(/\s/g, ''));

const entries = [];
let context = '';

const sourceText = USE_STDIN ? readFileSync(0, 'utf8') : readFileSync(FILE, 'utf8');

for (const raw of sourceText.split(/\r?\n/)) {
  // strip shell noise people paste along with keys
  const line = raw.trim().replace(/^set:\s*/i, '').replace(/^export\s+/i, '');
  if (isSeparator(line)) continue;

  const explicit = line.match(/^([A-Z][A-Z0-9_]{2,})\s*[=:]\s*(\S.*)$/);
  if (explicit) {
    const [, name, value] = explicit;
    // an env-style name has no word boundaries (`EXA_API_KEY_1`), so try it as words too
    const provider = labelFor(name) ?? labelFor(name.replace(/[_.-]+/g, ' ')) ?? 'unknown';
    entries.push({ value: value.trim(), provider, name, how: 'named' });
    continue;
  }

  const tokens = line.split(/[\s,]+/).filter(Boolean);
  const keys = tokens.map(classify).filter(Boolean);
  if (keys.length) {
    const labelText = tokens.filter((t) => !classify(t)).join(' ') || context;
    const label = labelFor(labelText);
    for (const key of keys) {
      // a provider label beats a generic shape guess, e.g. a 32-hex Mistral key
      const provider = label && (GENERIC.has(key.provider) || key.provider === 'unknown') ? label : key.provider;
      entries.push({ value: key.value, provider, name: null, how: 'shape' });
    }
    continue;
  }

  if (line.length <= 40) context = line;
}

const grouped = new Map();
for (const entry of entries) {
  const list = grouped.get(entry.provider) ?? [];
  list.push(entry);
  grouped.set(entry.provider, list);
}

const wiredLines = [];
const wiredReport = [];
const featherlessCount = entries.filter((e) => e.provider === 'featherless').length;
const unwired = [];
const unknown = [];

for (const [provider, list] of [...grouped].sort()) {
  if (provider === 'featherless') continue;
  const envName = WIRED[provider] ?? (list[0].name && /^(EXA|TAVILY|FIRECRAWL|GOOGLE|SHODAN|URLSCAN|SEARXNG)_/.test(list[0].name) ? list[0].name : null);
  if (envName) {
    wiredLines.push(`${envName}=${list[0].value}`);
    wiredReport.push(`${envName} — ${list.length === 1 ? '1 key' : `${list.length} keys, kept the first`}`);
  } else if (UNWIRED.has(provider)) {
    unwired.push(`${provider} (${list.length})`);
  } else {
    unknown.push(`${provider} (${list.length})`);
  }
}

mkdirSync(OUT_DIR, { recursive: true });
const envPath = join(OUT_DIR, '.env.functions');
if (wiredLines.length) {
  writeFileSync(envPath, `${wiredLines.join('\n')}\n`, { mode: 0o600 });
  try { chmodSync(envPath, 0o600); } catch { /* best effort on odd filesystems */ }
}

console.log(`read ${USE_STDIN ? 'pasted input' : FILE}: ${entries.length} key(s)\n`);
if (wiredReport.length) {
  console.log(`WIRED — written to ${envPath}`);
  for (const line of wiredReport) console.log(`  ${line}`);
} else {
  console.log('WIRED — none found');
}
console.log(
  featherlessCount
    ? `\nFEATHERLESS — ${featherlessCount} key(s). Not an env var; store it in the database:\n  UPDATE app_config SET featherless_api_key = '<key>' WHERE id = 1;`
    : '\nFEATHERLESS — none found',
);
if (unwired.length) console.log(`\nRECOGNISED BUT UNUSED HERE (revoke or wire later): ${unwired.join(', ')}`);
if (unknown.length) console.log(`\nUNRECOGNISED: ${unknown.join(', ')}`);

if (!APPLY) {
  console.log('\nDry run — nothing sent anywhere. Re-run with --apply to push to Supabase.');
  process.exit(0);
}

if (!wiredLines.length) {
  console.error('\n--apply needs at least one wired key.');
  process.exit(1);
}
if (!process.env.SUPABASE_ACCESS_TOKEN) {
  console.error('\nSUPABASE_ACCESS_TOKEN is not set, so the push cannot happen from here.');
  console.error('Add it under Settings → Project settings → Secrets, then re-run. Or do it yourself:');
  console.error(`  supabase secrets set --env-file ${envPath} --project-ref ${PROJECT_REF}`);
  console.error(`  supabase functions deploy web-search --project-ref ${PROJECT_REF}`);
  process.exit(1);
}

try {
  const run = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { stdio: 'inherit', env: process.env });
  console.log('\npushing secrets…');
  run('supabase', ['secrets', 'set', '--env-file', envPath, '--project-ref', PROJECT_REF]);
  console.log('redeploying web-search…');
  run('supabase', ['functions', 'deploy', 'web-search', '--project-ref', PROJECT_REF]);

  // The Featherless key is not an env var: it lives in app_config and llm-proxy reads it there.
  const featherless = entries.filter((entry) => entry.provider === 'featherless').at(-1)?.value;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (featherless) {
    if (serviceRole) {
      console.log('storing the Featherless key in app_config…');
      const resp = await fetch(`${process.env.SUPABASE_URL ?? `https://${PROJECT_REF}.supabase.co`}/rest/v1/app_config?id=eq.1`, {
        method: 'PATCH',
        headers: {
          apikey: serviceRole,
          Authorization: `Bearer ${serviceRole}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ featherless_api_key: featherless }),
      });
      if (!resp.ok) console.error(`  app_config update failed (HTTP ${resp.status}); set it in the SQL editor instead.`);
      else console.log('  stored');
    } else {
      console.log('Featherless key found but SUPABASE_SERVICE_ROLE_KEY is not set — run in the SQL editor:');
      console.log("  UPDATE app_config SET featherless_api_key = '<key>' WHERE id = 1;");
    }
  }

  console.log('done.');
} catch (error) {
  console.error(`\nSupabase CLI failed: ${error.message}`);
  process.exit(1);
}
