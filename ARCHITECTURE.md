# Architecture

A search-first research console. One query fans out to many engines — some inside a Supabase
edge function, some directly from the browser — and the results are fused, ranked, and handed to
an LLM that summarises them with citations.

Two rules shape most of the code:

1. **Ranking is measured, not guessed.** Every weight in `src/lib/fusion.ts` has a test or an
   experiment behind it. Change a constant, run `npm run smoke`, see what moved.
2. **Nothing silently returns nothing.** An engine that failed, lacked a key, or came back empty
   reports *which* of those happened.

## Request path

```
browser ──supabase-js──> Postgres (RLS, per user)
   │
   ├─ POST /functions/v1/web-search   server engines, per-request user keys
   ├─ fetch (CORS)                    browser engines: Crossref, Europe PMC, Open Library,
   │                                  Internet Archive, HN, Stack Overflow, Lemmy, Wikidata, crt.sh
   └─ POST /functions/v1/llm-proxy/chat   streaming completions via Featherless
```

`src/App.tsx` owns the conversation half: messages, streaming content, panel tab, settings, and the
completion itself. There is no router. Search used to live here too and became the first scaling
wall, so it was extracted into `src/hooks/useSearch.ts` — see the search path below.

## Search path

`src/hooks/useSearch.ts` owns search: the run controller, `results`, `isSearching`, `status`,
`issues`, `lastQuery`, and `performSearch` / `runLane` / `cancelSearch` / `runAborted` /
`clearResults`. App keeps what is not search and injects it — `logActivity`, `ensureConversation`,
`saveSources`, `closeActivity`, `abortStream` — so the hook never touches messages or the model.

One run at a time: a new run aborts the previous controller, and every `setState` is guarded by an
`isCurrent()` check, so a slow engine cannot write over newer results. Cancelling aborts the search
and the completion together, because a stale answer is as wrong as stale sources.

`performSearch` itself:

1. Split the selected engines into server and browser sets.
2. Run both in parallel. Server results arrive with an `engine_status[]` array — one entry per
   requested engine with `status` of `ok | empty | missing_key | error | unknown_engine`, a
   result count, and a human `detail`.
3. Regroup every returned source by its `source_engine` and hand those lists to `fuseResults`.
4. Persist the fused list to `sources` (including `publication_date`), log activity, and pass the
   sources to the LLM as a system message with citation IDs.

Two stages of ranking exist and both matter. `web-search` does a plain reciprocal-rank fusion per
request to trim its own output; the client then re-fuses from the per-engine grouping. The client
therefore only ever sees each engine's top `maxResultsPerEngine`, so a source ranked 12th inside
an engine cannot be recovered later.

## Fusion (`src/lib/fusion.ts`)

Pipeline: canonicalise → IDF relevance → intent-weighted RRF → entity resolution → agreement
boost → per-domain cap → coverage quota → score sort → tail fill.

- **Canonical URL** — lowercased host without `www`, tracking params stripped, `arxiv.org/abs/` →
  `/pdf/`. This is the entity key and the dedupe key.
- **Relevance** — IDF-weighted term coverage of title + snippet (title matches count 1.15×).
  Common words ("postgres") therefore carry little; dork operators are stripped first so
  `site:tesla.com filetype:pdf` is scored on `tesla`.
- **Score** — `weight / (60 + rank + 1) × relevance^1.5 × (1 + 0.6 × recency)`.
- **Intent weights** — `queryIntent()` scores freshness, evergreen-ness, conceptual prose and
  navigational shape (quoted phrase, CVE, IP, domain, `site:`). Exa is weighted up for conceptual
  queries and down for identifiers; Tavily the reverse, plus a recency bonus. All weights clamp
  to 0.25–1.6. A year inside an identifier (`CVE-2024-3094`) does **not** count as freshness.
- **Recency** — only when the query is freshness-seeking. ≤30 days full weight, ≤180 days 0.65,
  ≤2 years 0.35, older 0.12. Undated results get 0: adding nothing is honest, inventing a date is
  not.
- **Entity resolution** — same DOI, same canonical URL, or title token Jaccard ≥ 0.6 means one
  entity. Members contribute their best score, an agreement boost (×1.02 per extra engine, capped
  at 3), and a ×1.15 per duplicate.
- **Coverage then score** — the coverage pass guarantees every contributing engine appears in the
  output even if its best result scores badly; `chosen` is then sorted by score so inclusion does
  not decide position. Without that sort the first engine's result always led.
- **Tail fill** refuses any entity sharing a canonical key with something already placed — the
  tail is resolved a second time and used to re-emit duplicates.

Output carries `source_engine` as the joined engine list (`crossref+wikipedia`), `engines[]`,
`relevance`, `relevance_score`, `published` and a `[n]` citation id.

## Ranking explainability (`src/lib/rankExplain.ts`)

The Sources panel shows a query-level intent chip and a per-result date + multiplier. Both are
computed here by calling the *same* `queryIntent` / `recencyWeight` the ranking used, so a badge
cannot drift from the score it describes.

## Keys

Per-user first, environment second:

1. `user_engine_keys` — a signed-in user pastes `NAME=value` lines in Settings. RLS is owner-only;
   `anon` has no privileges. `web-search` resolves the caller's JWT and loads their rows per
   request, passing them to the engine for that request only.
2. Function environment (`supabase secrets set`) — the deployment's own keys, used when a caller
   has none.
3. Featherless (`llm-proxy`) is not a search key: it lives in `app_config` (service-role only) and
   is read server-side. `app_config_public` exposes only `has_api_key` and `default_model`.

`npm run keys:paste` classifies a raw dump by token shape for the terminal path; `keys:apply` also
pushes secrets and, with a service-role key, writes the Featherless key into `app_config`.

## Data and security

Tables: `conversations`, `messages`, `sources`, `findings`, `evidence`, `activity_logs`,
`research_projects` (owner-scoped, `user_id DEFAULT auth.uid()`), plus `research_presets` and
`search_settings` as shared reference data, `app_config` (service role only),
`request_rate_limits`, and `user_engine_keys`.

All private tables use `user_id = auth.uid()` policies; `anon` was stripped of every privilege.
`llm-proxy` rate-limits per account (30/min, 600/day) and per IP for anonymous callers (4/40),
refusing *before* spending provider credit.

## UI shape

- **Composer** (`SearchBar`) — the primary control. Depth scopes (Recent / Deep / Lost / Dark /
  All) are one-tap engine bundles; engine, dork and raw controls sit beside them.
- **Chat** (`ChatArea` → `MessageBubble`) — summary first, then citations. Each answer carries
  copy / share / save / retry under its source block, and follow-up chips parsed from a trailing
  `FOLLOW-UPS` section by `src/lib/followUps.ts`.
- **Panel** (`InvestigationPanel`) — Map, Activity, Sources, Findings. Sources leads with the
  ranking chip, engine contribution bars, then per-engine groups.

## Testing

`npm run smoke` builds and runs every experiment test. Notable suites:
`fusion-intent` (intent weights, recency, ordering), `rank-badges` (what the UI claims the ranking
did), `ranking-harness` (`node experiments/ranking-harness.mjs` — fixed query set with graded
judgements, before/after nDCG/MRR; `--check` fails on regression). The query set is *contested*:
queries pair results with near-identical term coverage so only engine trust or a date can separate
them. An uncontested set scores the same under any weighting and silently measures nothing.
The `fresh-tie` and `semantic-tie` queries go further: their pair is equal on coverage by
construction, so relevance ties and only the recency bonus or the intent weights can order them.
`--check` verifies that with `termCoverage` rather than taking the fixture's word for it — equal
coverage, no entity merge, and a tie class that still moves by at least 0.05 nDCG.
`ranking-sweep` (`node experiments/ranking-sweep.mjs`) sweeps one constant at a time, ablates each
constant to show what removing it costs (`--ablate`), and checks leave-one-out stability
(`--stability`). It also reports `margin`, the order-free gap between the best answer and the best
lesser result:
nDCG cannot see a weighting that leaves a competing result ten times further behind without
changing which result is first, and that safety is what intent weighting mostly buys., `web-engine-pipeline` (handler
statuses end to end), `provider-keys`, `followups`, plus PGlite suites for RLS and rate limits.

`scripts/verify-engines.mjs` probes the deployed function. `scripts/dev-preview.sh` restarts the
preview server for the current hostname.

## Deploy state (verify before trusting the UI)

The repo can be ahead of the deployment. At the time of writing, migrations
`20261115140000_add_user_auth_rls`, `20261115150000_add_request_rate_limits` and
`20261115160000_user_engine_keys` were **not applied**, and `web-search` was running an older build
that emits no `engine_status` and reads no per-user keys. The app degrades honestly — no
diagnostics chips, no stored-key lookup, the Sources panel shows no dates — but a maintainer
should not read that as "the feature is broken". Apply the migrations and redeploy both functions,
then re-run `npm run engines:verify`.
