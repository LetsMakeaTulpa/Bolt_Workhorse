// v3 fusion experiment: IDF relevance, title-level entity resolution, relative gating,
// intent routing, agreement boost and per-domain diversity.
// Run: node experiments/fusion-v3.mjs "query one" "query two"

const UA = 'Mozilla/5.0 (compatible; FieldworkFusion/3.0)';

function canon(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'fbclid', 'gclid'].forEach((p) => u.searchParams.delete(p));
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    let path = u.pathname.replace(/\/+$/, '');
    if (host === 'arxiv.org' && path.startsWith('/abs/')) path = path.replace('/abs/', '/pdf/');
    const qs = [...u.searchParams].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + '=' + v).join('&');
    return host + path + (qs ? '?' + qs : '');
  } catch {
    return String(url).toLowerCase();
  }
}

const clean = (html = '') =>
  String(html).replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;|&#\d+;/gi, ' ').replace(/\s+/g, ' ').trim();

const STOP = new Set('the a an of in to for and or on with how what why is are was vs my me it that this does do can using use'.split(' '));
const tokens = (s) =>
  String(s).toLowerCase().match(/[a-z0-9][a-z0-9.+#_-]{1,}/g)?.filter((t) => !STOP.has(t)) ?? [];

async function get(url, json = true, ms = 9000, headers = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { 'user-agent': UA, ...headers } });
    const text = await res.text();
    return { ok: res.ok, data: json && text ? JSON.parse(text) : text };
  } catch {
    return { ok: false, data: null };
  } finally {
    clearTimeout(t);
  }
}

const ENGINES = {
  ddg: async (q) => {
    const r = await get('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), false, 9000, { accept: 'text/html' });
    const out = [];
    for (const m of String(r.data ?? '').matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
      let href = m[1];
      const u = href.match(/uddg=([^&]+)/);
      if (u) href = decodeURIComponent(u[1]);
      if (!href.startsWith('http')) continue;
      out.push({ title: clean(m[2]), url: href, snippet: '' });
      if (out.length >= 10) break;
    }
    return out;
  },
  wikipedia: async (q) => {
    const r = await get('https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=' + encodeURIComponent(q) + '&format=json&srlimit=10&origin=*');
    return (r.data?.query?.search ?? []).map((x) => ({
      title: x.title,
      url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(x.title.replace(/ /g, '_')),
      snippet: clean(x.snippet),
    }));
  },
  arxiv: async (q) => {
    const terms = tokens(q).slice(0, 4);
    const expr = terms.length ? 'all:(' + terms.map((t) => 'all:' + t).join(' AND ') + ')' : 'all:' + encodeURIComponent(q);
    const r = await get('https://export.arxiv.org/api/query?search_query=' + encodeURIComponent(expr) + '&max_results=10', false, 6000);
    return [...String(r.data ?? '').matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, b]) => ({
      title: clean((b.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1] ?? ''),
      url: clean((b.match(/<id>([\s\S]*?)<\/id>/) ?? [])[1] ?? ''),
      snippet: clean((b.match(/<summary>([\s\S]*?)<\/summary>/) ?? [])[1] ?? '').slice(0, 240),
    }));
  },
  openalex: async (q) => {
    const r = await get('https://api.openalex.org/works?search=' + encodeURIComponent(q) + '&per_page=10');
    return (r.data?.results ?? []).map((w) => ({
      title: w.display_name ?? '',
      url: w.doi || w.id,
      snippet: (w.primary_location?.source?.display_name ?? '') + ' cited ' + (w.cited_by_count ?? 0),
    }));
  },
  crossref: async (q) => {
    const r = await get('https://api.crossref.org/works?query=' + encodeURIComponent(q) + '&rows=10&select=title,URL,DOI,container-title,issued');
    return (r.data?.message?.items ?? []).map((w) => ({
      title: (w.title ?? [])[0] ?? '',
      url: w.URL ?? (w.DOI ? 'https://doi.org/' + w.DOI : ''),
      snippet: ((w['container-title'] ?? [])[0] ?? '') + ' ' + (w.issued?.['date-parts']?.[0]?.[0] ?? ''),
    }));
  },
  hn: async (q) => {
    const r = await get('https://hn.algolia.com/api/v1/search?query=' + encodeURIComponent(q) + '&hitsPerPage=10');
    return (r.data?.hits ?? []).map((h) => ({
      title: h.title || h.story_title || 'HN ' + h.objectID,
      url: h.url || h.story_url || 'https://news.ycombinator.com/item?id=' + h.objectID,
      snippet: (h.points ?? 0) + ' pts ' + (h.num_comments ?? 0) + ' comments',
    }));
  },
  stackexchange: async (q) => {
    const r = await get('https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=' + encodeURIComponent(q) + '&site=stackoverflow&pagesize=10');
    return (r.data?.items ?? []).map((i) => ({
      title: clean(i.title),
      url: i.link,
      snippet: 'score ' + i.score + ' answers ' + i.answer_count,
    }));
  },
  github: async (q) => {
    const r = await get('https://api.github.com/search/repositories?q=' + encodeURIComponent(q) + '&per_page=10', true, 9000, { accept: 'application/vnd.github+json' });
    return (r.data?.items ?? []).map((i) => ({
      title: i.full_name,
      url: i.html_url,
      snippet: (i.stargazers_count ?? 0) + ' stars ' + clean(i.description ?? ''),
    }));
  },
};

const TECH = ['python', 'rust', 'javascript', 'typescript', 'sql', 'postgres', 'postgresql', 'docker', 'kubernetes', 'api', 'regex', 'library', 'npm', 'pip', 'function', 'bug', 'c++', 'java', 'linux', 'git', 'css', 'react'];
const BIO = ['protein', 'gene', 'cell', 'clinical', 'patient', 'disease', 'drug', 'crispr', 'mrna', 'cancer', 'antibody', 'assay', 'virus'];
const SCHOLAR = ['paper', 'study', 'dataset', 'benchmark', 'thesis', 'journal', 'survey', 'citation', 'doi', 'arxiv', 'literature', 'review', 'algorithm'];
const INTEL = ['cve', 'vulnerability', 'exploit', 'breach', 'leak', 'shodan', 'osint', 'dork', 'subdomain', 'malware', 'ransomware', 'exposed'];

function engineWeights(query) {
  const ql = query.toLowerCase();
  const t = new Set(tokens(query));
  const has = (words) => words.some((w) => ql.includes(w) || t.has(w));
  const w = { ddg: 1.25, wikipedia: 0.75, hn: 0.85, stackexchange: 0.9, github: 0.85, arxiv: 0.8, openalex: 0.7, crossref: 0.7 };
  if (has(TECH)) { w.stackexchange = 1.5; w.github = 1.4; w.hn = 1.15; w.arxiv = 0.95; }
  if (has(BIO)) { w.openalex = 1.0; w.crossref = 0.9; }
  if (has(SCHOLAR)) { w.arxiv = 1.3; w.openalex = 1.25; w.crossref = 1.15; }
  if (has(INTEL)) { w.ddg = 1.4; w.github = 1.25; w.hn = 1.05; }
  return w;
}

function buildDf(items) {
  const df = new Map();
  for (const it of items) {
    for (const t of new Set(tokens(it.title + ' ' + it.snippet))) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return df;
}

function relevanceIdf(query, item, df, N) {
  const qt = tokens(query);
  if (!qt.length) return 0.5;
  const idf = (t) => Math.log(1 + N / (1 + (df.get(t) ?? 0)));
  let got = 0;
  let total = 0;
  const title = String(item.title).toLowerCase();
  const hay = title + ' ' + String(item.snippet).toLowerCase();
  for (const t of qt) {
    const w = idf(t);
    total += w;
    if (hay.includes(t)) got += w * (title.includes(t) ? 1.15 : 0.85);
  }
  return total ? Math.min(1, got / total) : 0;
}

// title-level entity resolution: the same paper/discussion from 3 engines is one source
function groupByEntity(items) {
  const groups = [];
  for (const item of items) {
    const set = new Set(tokens(item.title).filter((t) => t.length > 2));
    if (set.size < 3) {
      groups.push({ rep: item, members: [item], engines: new Set([item.engine]), keys: new Set([item.key]), doi: item.doi });
      continue;
    }
    let placed = false;
    for (const g of groups) {
      const sameDoi = item.doi && g.doi && item.doi === g.doi;
      if (sameDoi || (g.set && jaccard(set, g.set) >= 0.6)) {
        g.members.push(item);
        g.engines.add(item.engine);
        g.keys.add(item.key);
        g.doi = g.doi ?? item.doi;
        placed = true;
        break;
      }
    }
    if (!placed) groups.push({ rep: item, members: [item], engines: new Set([item.engine]), keys: new Set([item.key]), set, doi: item.doi });
  }
  return groups;
}

const doiOf = (url) => {
  const m = String(url).match(/10\.\d{4,9}\/[^\s?#&]+/i);
  return m ? m[0].toLowerCase().replace(/[.,;]$/, '') : null;
};

function jaccard(a, b) {
  const inter = [...a].filter((x) => b.has(x)).length;
  const uni = new Set([...a, ...b]).size || 1;
  return inter / uni;
}

function fuse(query, lists, { k = 60, limit = 40, perDomain = 2, agreement = 0.02, relativeGate = 0.35 } = {}) {
  const weights = engineWeights(query);
  const all = [];
  for (const [engine, items] of Object.entries(lists)) {
    items.forEach((item, i) => {
      const key = canon(item.url);
      if (!key) return;
      all.push({ ...item, engine, key, doi: doiOf(item.url), rank: i, w: weights[engine] ?? 0.7 });
    });
  }
  if (!all.length) return [];
  const N = all.length;
  const df = buildDf(all);

  // score: RRF rank contribution x engine weight x relevance
  for (const it of all) {
    it.rel = relevanceIdf(query, it, df, N);
    it.score = (it.w / (k + it.rank + 1)) * Math.pow(it.rel, 1.5);
  }
  const best = Math.max(...all.map((i) => i.rel));
  const kept = all.filter((i) => i.rel >= Math.max(0.1, relativeGate * best));
  // strong pool (relevant enough to lead) vs tail (fills only if quotas need it)
  const strong = kept.filter((i) => i.rel >= 0.5);
  const tail = kept.filter((i) => i.rel < 0.5);

  // entity resolution, then agreement boost
  const groups = groupByEntity(strong.length >= 6 ? strong : kept);
  for (const g of groups) {
    const base = Math.max(...g.members.map((m) => m.score));
    const agree = Math.min(3, g.engines.size);
    g.score = base * (1 + agreement * (agree - 1)) * (1 + 0.15 * (g.members.length - 1));
    g.rel = Math.max(...g.members.map((m) => m.rel));
  }
  const ranked = groups.sort((a, b) => b.score - a.score);

  // coverage then diversity
  const out = [];
  const usedDomains = new Map();
  const took = new Set();
  const take = (g) => {
    const domain = g.rep.key.split('/')[0];
    const n = usedDomains.get(domain) ?? 0;
    if (n >= perDomain) return false;
    usedDomains.set(domain, n + 1);
    took.add(g);
    out.push(g);
    return true;
  };
  for (const engine of Object.keys(lists)) {
    const g = ranked.find((x) => !took.has(x) && x.engines.has(engine));
    if (g) take(g);
    if (out.length >= limit) return out;
  }
  for (const g of ranked) {
    if (out.length >= limit) break;
    if (!took.has(g)) take(g);
  }
  if (out.length < limit && tail.length) {
    for (const g of groupByEntity(tail).sort((a, b) => b.rel - a.rel)) {
      if (out.length >= limit) break;
      if (!took.has(g)) take(g);
    }
  }
  return out;
}

const queries = process.argv.slice(2).length ? process.argv.slice(2) : ['postgres index bloat'];

for (const q of queries) {
  console.log('\n================ ' + q);
  const lists = {};
  await Promise.all(
    Object.entries(ENGINES).map(async ([name, fn]) => {
      const t0 = Date.now();
      let items = [];
      try { items = await fn(q); } catch { items = []; }
      console.log('  ' + name.padEnd(14) + String(items.length).padStart(3) + ' results  ' + (Date.now() - t0) + 'ms');
      if (items.length) lists[name] = items;
    }),
  );

  const plain = [];
  for (const [engine, items] of Object.entries(lists)) items.forEach((it, i) => plain.push({ ...it, engine, rank: i }));
  const plainScored = plain
    .map((it) => ({ ...it, key: canon(it.url), s: 1 / (60 + it.rank + 1) }))
    .sort((a, b) => b.s - a.s);
  const plainUniq = [];
  const seen = new Set();
  for (const it of plainScored) { if (!seen.has(it.key)) { seen.add(it.key); plainUniq.push(it); } }

  const fused = fuse(q, lists);
  const topPlain = plainUniq.slice(0, 10);
  const topFused = fused.slice(0, 10);

  const offPlain = topPlain.filter((it) => it.rel === undefined).length;
  const multiFused = topFused.filter((g) => g.engines.size > 1).length;
  const enginesFused = new Set(topFused.flatMap((g) => [...g.engines])).size;

  console.log('\nPLAIN RRF: ' + plainUniq.length + ' unique, engines in top10: ' + new Set(topPlain.map((i) => i.engine)).size + ' (offtopic untracked=' + offPlain + ')');
  topPlain.slice(0, 8).forEach((it, i) => console.log('  ' + (i + 1) + '. [' + it.engine + '] ' + it.title.slice(0, 68)));
  console.log('\nFUSED v3: ' + fused.length + ' unique, ' + multiFused + '/10 multi-engine, ' + enginesFused + ' engines in top10');
  topFused.slice(0, 8).forEach((g, i) =>
    console.log('  ' + (i + 1) + '. [' + [...g.engines].join('+') + '] rel=' + g.rel.toFixed(2) + ' ' + g.rep.title.slice(0, 60)),
  );
}
