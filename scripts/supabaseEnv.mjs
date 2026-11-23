/**
 * Where the probe scripts find the project and the one credential they may use.
 *
 * The anon key is public by design: it is the same key the browser ships, row-level security is what
 * protects the data, and every probe here asks only what an anonymous caller could ask. `.env` is
 * read without ever printing a value, and no probe script may read a service-role key.
 */
import { existsSync, readFileSync } from 'node:fs';

const DEFAULT_PROJECT_REF = 'mhfsggpnnjyxsnshqatf';

function readEnvFile(path) {
  const values = {};
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = line.match(/^(?:export\s+)?([A-Z0-9_]+)\s*=(.*)$/);
    if (match) values[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return values;
}

const dotenv = { ...readEnvFile('.env'), ...readEnvFile('.env.local') };

export const url = process.env.VITE_SUPABASE_URL ?? dotenv.VITE_SUPABASE_URL ?? '';
export const anonKey = process.env.VITE_SUPABASE_ANON_KEY ?? dotenv.VITE_SUPABASE_ANON_KEY ?? '';
export const projectRef =
  process.env.SUPABASE_PROJECT_REF ??
  /^https:\/\/([a-z0-9]+)\.supabase\.co/i.exec(url)?.[1] ??
  DEFAULT_PROJECT_REF;
