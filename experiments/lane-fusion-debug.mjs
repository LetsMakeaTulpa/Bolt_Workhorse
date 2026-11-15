// Runs a dork lane against the deployed web-search function, then pushes the raw responses
// through the real fusion code so the loss at each stage is visible.
// Run: . ./.env && node experiments/lane-fusion-debug.mjs tesla.com "Exposed files"

const URL_BASE = process.env.VITE_SUPABASE_URL;
const KEY = process.env.VITE_SUPABASE_ANON_KEY;
const target = process.argv[2] ?? 'tesla.com';
const lane = process.argv[3] ?? 'Exposed files';

const { fuseResults, stripDorkOperators, tokens } = await import(
  process.env.FUSION_MODULE ?? '/tmp/fusion.mjs'
);

const TEMPLATES = [
  'site:{target} filetype:pdf',
  'site:{target} (filetype:xls OR filetype:xlsx OR filetype:csv)',
  'site:{target} (filetype:doc OR filetype:docx OR filetype:zip OR filetype:rar)',
  'site:{target} ext:log',
  'site:{target} intitle:"index of"',
  'site:{target} intitle:"index of" backup',
];

const queries = TEMPLATES.map((pattern) => pattern.replace(/{target}/g, target));
const engines = ['duckduckgo', 'wikipedia', 'arxiv', 'github'];

const perEngineQuery = {};
let raw = 0;

for (const [index, query] of queries.entries()) {
  const resp = await fetch(`${URL_BASE}/functions/v1/web-search`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      engines,
      maxResultsPerEngine: 5,
      useDorks: true,
      preset: 'general',
      compileQueries: false,
    }),
  });
  const data = await resp.json();
  const results = data.results ?? [];
  raw += results.length;
  console.log(`${String(results.length).padStart(2)} results | ${query}`);
  for (const item of results) {
    const key = `${item.source_engine || 'unknown'}·q${index}`;
    (perEngineQuery[key] ??= []).push(item);
  }
}

const kept = fuseResults(target, perEngineQuery, { limit: 60 });
const uniqueUrls = new Set(Object.values(perEngineQuery).flat().map((item) => item.url));

console.log('\n--- lane:', lane, '| target:', target);
console.log('stripped relevance query:', JSON.stringify(stripDorkOperators(`${queries[0]}`)), '| tokens:', tokens(stripDorkOperators(queries[0])));
console.log('raw results:', raw, '| unique urls:', uniqueUrls.size, '| after fusion:', kept.length);
console.log('\ntop fused:');
kept.slice(0, 10).forEach((item, i) =>
  console.log(`  ${i + 1}. [${(item.engines ?? []).join('+')}] rel=${item.relevance} ${String(item.title).slice(0, 70)}`),
);

const domains = {};
for (const url of uniqueUrls) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    domains[host] = (domains[host] ?? 0) + 1;
  } catch {}
}
console.log('\nunique urls by domain:', domains);
