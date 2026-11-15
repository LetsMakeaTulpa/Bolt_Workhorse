// Fusion lab: exercises keyless engines on real queries and compares ranking strategies.
// Run with: node experiments/fusion-lab.mjs "query one" "query two"

const UA = 'Mozilla/5.0 (compatible; FieldworkFusionLab/1.0)';

const canon = (url) => {
  try {
    const u = new URL(url);
    u.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'fbclid', 'gclid'].forEach((p) =>
      u.searchParams.delete(p),
    );
    let host = u.hostname.replace(/^www\./, '').toLowerCase();
    let path = u.pathname.replace(/\/+$/, '');
    if (host === 'arxiv.org' && path.startsWith('/abs/')) path = path.replace('/abs/', '/pdf/');
    if (host === 'doi.org') path = path.toLowerCase();
    return `${host}${path}${u.search ? `?${[...u.searchParams].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&')}` : ''}`;
  } catch {
    return url.toLowerCase();
  }
};

const clean = (html = '') =>
  String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

async function get(url, { json = true, headers = {} } = {}, ms = 9000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { 'user-agent': UA, ...headers } });
    const text = await res.text();
    return { ok: res.ok, status: res.status, ms: Date.now() - started, data: json && text ? JSON.parse(text) : text };
  } catch (err) {
    return { ok: false, status: 0, ms: Date.now() - started, error: String(err).slice(0, 60), data: null };
  } finally {
    clearTimeout(t);
  }
}

const ENGINES = {
  wikipedia: async (q) => {
    const r = await get(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&srlimit=10&origin=*`,
    );
    return (r.data?.query?.search ?? []).map((x) => ({
      title: x.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(x.title.replace(/ /g, '_'))}`,
      snippet: clean(x.snippet),
      rank: 0,
    }));
  },
  arxiv: async (q) => {
    const r = await get(`https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q)}&max_results=10`, { json: false }, 5000);
    const xml = r.data ?? '';
    const entries = [...String(xml).matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
    return entries.map(([, body]) => {
      const title = clean((body.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1] ?? '');
      const link = (body.match(/<id>([\s\S]*?)<\/id>/) ?? [])[1] ?? '';
      const summary = clean((body.match(/<summary>([\s\S]*?)<\/summary>/) ?? [])[1] ?? '');
      return { title, url: link.trim(), snippet: summary.slice(0, 240), rank: 0 };
    });
  },
  openalex: async (q) => {
    const r = await get(`https://api.openalex.org/works?search=${encodeURIComponent(q)}&per_page=10`);
    return (r.data?.results ?? []).map((w) => ({
      title: w.display_name ?? w.title ?? '',
      url: w.doi || w.id,
      snippet: `${w.primary_location?.source?.display_name ?? ''} · cited ${w.cited_by_count ?? 0}`,
      rank: 0,
    }));
  },
  crossref: async (q) => {
    const r = await get(`https://api.crossref.org/works?query=${encodeURIComponent(q)}&rows=10&select=title,URL,DOI,container-title,issued`);
    return (r.data?.message?.items ?? []).map((w) => ({
      title: (w.title ?? [])[0] ?? '',
      url: w.URL ?? (w.DOI ? `https://doi.org/${w.DOI}` : ''),
      snippet: `${(w['container-title'] ?? [])[0] ?? ''} ${w.issued?.['date-parts']?.[0]?.[0] ?? ''}`.trim(),
      rank: 0,
    }));
  },
  semanticscholar: async (q) => {
    const r = await get(
      `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q)}&limit=10&fields=title,abstract,url,venue,year`,
    );
    return (r.data?.data ?? []).map((p) => ({
      title: p.title ?? '',
      url: p.url ?? '',
      snippet: `${p.venue ?? ''} ${p.year ?? ''} ${clean(p.abstract ?? '').slice(0, 160)}`.trim(),
      rank: 0,
    }));
  },
  europepmc: async (q) => {
    const r = await get(
      `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(q)}&format=json&pageSize=10`,
    );
    return (r.data?.resultList?.result ?? []).map((p) => ({
      title: p.title ?? '',
      url: p.doi ? `https://doi.org/${p.doi}` : `https://europepmc.org/article/${p.source}/${p.id}`,
      snippet: `${p.journalTitle ?? ''} ${p.pubYear ?? ''}`.trim(),
      rank: 0,
    }));
  },
  hn: async (q) => {
    const r = await get(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&hitsPerPage=10`);
    return (r.data?.hits ?? []).map((h) => ({
      title: h.title || h.story_title || `HN ${h.objectID}`,
      url: h.url || h.story_url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      snippet: `${h.points ?? 0} pts · ${h.num_comments ?? 0} comments`,
      rank: 0,
    }));
  },
  stackexchange: async (q) => {
    const r = await get(
      `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(q)}&site=stackoverflow&pagesize=10`,
    );
    return (r.data?.items ?? []).map((i) => ({
      title: clean(i.title),
      url: i.link,
      snippet: `score ${i.score} · ${i.answer_count} answers`,
      rank: 0,
    }));
  },
  github: async (q) => {
    const r = await get(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=10`, {
      headers: { accept: 'application/vnd.github+json' },
    });
    return (r.data?.items ?? []).map((i) => ({
      title: i.full_name,
      url: i.html_url,
      snippet: `${i.stargazers_count ?? 0}★ ${clean(i.description ?? '')}`.slice(0, 200),
      rank: 0,
    }));
  },
  lobsters: async (q) => {
    const r = await get(`https://lobste.rs/search.json?q=${encodeURIComponent(q)}&what=stories&order=relevance`, { json: false });
    try {
      const arr = JSON.parse(r.data ?? '[]');
      return arr.slice(0, 10).map((s) => ({ title: s.title, url: s.url || `https://lobste.rs/s/${s.short_id}`, snippet: clean(s.description ?? ''), rank: 0 }));
    } catch {
      return [];
    }
  },
  ddg: async (q) => {
    const r = await get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
      json: false,
      headers: { accept: 'text/html' },
    });
    const html = String(r.data ?? '');
    const out = [];
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    for (const m of html.matchAll(re)) {
      let href = m[1];
      const uddg = href.match(/uddg=([^&]+)/);
      if (uddg) href = decodeURIComponent(uddg[1]);
      if (!href.startsWith('http')) continue;
      out.push({ title: clean(m[2]), url: href, snippet: '', rank: 0 });
      if (out.length >= 10) break;
    }
    return out;
  },
  wayback: async (q) => {
    const r = await get(
      `http://web.archive.org/cdx/search/cdx?url=*${encodeURIComponent(q.split(' ')[0])}*&output=json&limit=10&filter=statuscode:200&collapse=urlkey`,
      {},
      4000,
    );
    const rows = Array.isArray(r.data) ? r.data.slice(1) : [];
    return rows.map((row) => ({
      title: `Archived: ${row[2] ?? ''}`,
      url: `https://web.archive.org/web/${row[1]}/${row[2] ?? ''}`,
      snippet: `${row[4] ?? ''} · ${row[5] ?? ''}`,
      rank: 0,
    }));
  },
};

// ---------- v2: intent routing, relevance gating, coverage quota ----------
const STOP = new Set(
  'the a an of in to for and or on with how what why is are was vs my me it that this does do can'.split(' '),
);
const tokens = (s) =>
  String(s)
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9.+#_-]{1,}/g)
    ?.filter((t) => !STOP.has(t)) ?? [];

const TECH = ['python', 'rust', 'javascript', 'typescript', 'sql', 'postgres', 'postgresql', 'docker', 'kubernetes', 'api', 'regex', 'library', 'npm', 'pip', 'function', 'bug', 'c++', 'java', 'linux', 'git', 'css', 'react'];
const BIO = ['protein', 'gene', 'cell', 'clinical', 'patient', 'disease', 'drug', 'crispr', 'mrna', 'cancer', 'antibody', 'assay', 'virus'];
const SCHOLAR = ['paper', 'study', 'dataset', 'benchmark', 'thesis', 'journal', 'survey', 'citation', 'doi', 'arxiv', 'literature', 'review', 'algorithm'];
const INTEL = ['cve', 'vulnerability', 'exploit', 'breach', 'leak', 'shodan', 'osint', 'dork', 'subdomain', 'malware', 'ransomware', 'exposed'];

function engineWeights(query) {
  const ql = query.toLowerCase();
  const t = new Set(tokens(query));
  const has = (words) => words.some((w) => ql.includes(w) || t.has(w));
  const w = { ddg: 1.25, wikipedia: 0.9, hn: 0.85, stackexchange: 0.9, github: 0.85, arxiv: 0.8, openalex: 0.7, crossref: 0.7, europepmc: 0.6, semanticscholar: 0.7, lobsters: 0.6 };
  if (has(TECH)) { w.stackexchange = 1.5; w.github = 1.4; w.hn = 1.15; w.arxiv = 0.95; }
  if (has(BIO)) { w.europepmc = 1.5; w.openalex = 1.0; }
  if (has(SCHOLAR)) { w.arxiv = 1.3; w.openalex = 1.25; w.crossref = 1.15; w.semanticscholar = 1.1; }
  if (has(INTEL)) { w.ddg = 1.4; w.github = 1.25; w.hn = 1.05; }
  return w;
}

function relevance(query, item) {
  const qt = tokens(query);
  if (qt.length === 0) return 1;
  const title = String(item.title).toLowerCase();
  const hay = `${title} ${String(item.snippet).toLowerCase()}`;
  const hits = qt.filter((t) => hay.includes(t));
  if (hits.length === 0) return 0;
  const coverage = hits.length / qt.length;
  return coverage * (qt.some((t) => title.includes(t)) ? 1 : 0.7);
}

const GATE = 0.34;

function fuseV2(query, lists, { limit = 30, k = 60, agreement = 0.004, perDomain = 2, coverage = 1 } = {}) {
  const weights = engineWeights(query);
  const gated = {};
  for (const [engine, items] of Object.entries(lists)) {
    gated[engine] = items.filter((i) => relevance(query, i) >= GATE).slice(0, 8);
  }
  const ranked = rrf(gated, { k, weights, agreement });

  // coverage pass: guarantee each contributing engine is represented, then fill by score
  const picked = [];
  const seen = new Set();
  const domainUsed = new Map();
  const take = (item) => {
    const domain = item.key.split('/')[0];
    const n = domainUsed.get(domain) ?? 0;
    if (n >= perDomain) return false;
    domainUsed.set(domain, n + 1);
    seen.add(item.key);
    picked.push(item);
    return true;
  };
  for (let slot = 0; slot < coverage; slot++) {
    for (const engine of Object.keys(gated)) {
      const item = ranked.find((r) => !seen.has(r.key) && r.engines.includes(engine));
      if (item) take(item);
      if (picked.length >= limit) return picked;
    }
  }
  for (const item of ranked) {
    if (picked.length >= limit) break;
    if (!seen.has(item.key)) take(item);
  }
  return picked;
}

// ---------- fusion strategies ----------
function rrf(lists, { k = 60, weights = {}, agreement = 0 } = {}) {
  const scores = new Map();
  const meta = new Map();
  const hits = new Map();
  for (const [engine, items] of Object.entries(lists)) {
    const w = weights[engine] ?? 1;
    items.forEach((item, i) => {
      const key = canon(item.url);
      if (!key) return;
      scores.set(key, (scores.get(key) ?? 0) + w / (k + i + 1));
      hits.set(key, (hits.get(key) ?? 0) + 1);
      if (!meta.has(key)) meta.set(key, { ...item, engines: new Set() });
      meta.get(key).engines.add(engine);
    });
  }
  for (const [key, count] of hits) {
    if (count > 1) scores.set(key, scores.get(key) + agreement * (count - 1));
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, score]) => ({ ...meta.get(key), key, score, engines: [...meta.get(key).engines] }));
}

function diversify(ranked, perDomain = 2, limit = 30) {
  const used = new Map();
  const out = [];
  for (const item of ranked) {
    const domain = item.key.split('/')[0];
    const n = used.get(domain) ?? 0;
    if (n >= perDomain) continue;
    used.set(domain, n + 1);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------- run ----------
const queries = process.argv.slice(2);
if (queries.length === 0) queries.push('point in polygon ray casting', 'postgres index bloat');

const report = {};
for (const q of queries) {
  console.log(`\n================ QUERY: ${q}`);
  const lists = {};
  const stats = {};
  const jobs = Object.entries(ENGINES).map(async ([name, fn]) => {
    const t0 = Date.now();
    let items = [];
    try {
      items = await fn(q);
    } catch (e) {
      items = [];
    }
    const ms = Date.now() - t0;
    stats[name] = { n: items.length, ms };
    if (items.length) lists[name] = items;
  });
  await Promise.all(jobs);

  console.log('\nengine           results   ms');
  for (const [name, s] of Object.entries(stats).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`${name.padEnd(16)} ${String(s.n).padStart(5)}  ${String(s.ms).padStart(5)}`);
  }

  // overlap matrix (jaccard on canonical urls)
  const names = Object.keys(lists);
  console.log('\npairwise overlap (jaccard, %):');
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = new Set(lists[names[i]].map((x) => canon(x.url)));
      const b = new Set(lists[names[j]].map((x) => canon(x.url)));
      const inter = [...a].filter((x) => b.has(x)).length;
      const uni = new Set([...a, ...b]).size;
      if (inter > 0) console.log(`  ${names[i]} ∩ ${names[j]} = ${((100 * inter) / uni).toFixed(0)}% (${inter})`);
    }
  }

  const strategies = {
    'plain RRF': diversify(rrf(lists)),
    'gated + intent weights': fuseV2(q, lists),
    'gated + intent + coverage': fuseV2(q, lists, { coverage: 2 }),
  };

  for (const [label, ranked] of Object.entries(strategies)) {
    const top = ranked.slice(0, 10);
    const multi = top.filter((r) => r.engines.length > 1).length;
    const offTopic = top.filter((r) => relevance(q, r) < GATE).length;
    const enginesSharing = new Set(top.flatMap((r) => r.engines)).size;
    console.log(
      `\n--- ${label}: ${ranked.length} unique | ${multi}/10 multi-engine | ${offTopic}/10 off-topic | ${enginesSharing} engines represented`,
    );
    ranked.slice(0, 8).forEach((r, i) => {
      console.log(`  ${i + 1}. [${r.engines.join('+')}] ${r.title.slice(0, 70)} :: ${r.key.slice(0, 60)}`);
    });
  }
  report[q] = { stats, ranked: strategies['gated + intent + coverage'].slice(0, 10).map((r) => ({ t: r.title, e: r.engines })) };
}

console.log('\n\nDONE', JSON.stringify(Object.keys(report)));
