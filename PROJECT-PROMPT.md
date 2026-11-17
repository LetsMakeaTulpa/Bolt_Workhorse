# Fieldwork — complete build prompt

> Restatement of this repository as a specification detailed enough to rebuild it from nothing.
> Every number, rule and file named here exists in the code at the commit that added this file.
> Read `ARCHITECTURE.md` for the narrative version, `DEPLOY.md` for the hosted-state runbook.

---

## 1. What you are building

**Fieldwork** is a single-page research console. A user signs in, asks a question, and the app fans
that question out to up to 24 search engines across the surface web, the deep web, code and
infrastructure surfaces. Results are canonicalised, de-duplicated, fused with an intent-weighted
reciprocal-rank score, filtered, persisted, and handed to a streaming LLM together with the text of
the top pages. The model answers with `[n]` citations, a claim ledger, and three follow-up
questions. The transcript never leaves a question unanswered, never shows an empty results page
without explaining which engines failed and why, and never invents a citation.

Two product rules dominate every decision:

1. **Nothing silently returns nothing.** Every engine reports one of `ok | empty | missing_key |
   error | unknown_engine | key_fallback`, with a human `detail`. A blank panel is a bug.
2. **Ranking is measured, not guessed.** Every weight in the fusion layer is covered by a test or a
   benchmark over a deliberately *contested* fixture. A constant change must show up as a movement
   in nDCG or margin, or it is not a change.

A third rule applies to everything written by the model: **the app may reformat the answer, never
extend it.** Derived follow-up chips and BLUF queries are built only from words already in the
answer, so nothing can be hallucinated by the UI layer.

---

## 2. Stack and hard constraints

| Concern | Decision |
| --- | --- |
| UI | React 18 + TypeScript, Vite 5, Tailwind 3, `lucide-react` icons |
| Markdown | `react-markdown` + `remark-gfm` |
| Backend | Supabase (Postgres + RLS, Auth, Edge Functions on Deno) |
| Inference | Featherless, OpenAI-compatible, streamed through `llm-proxy` |
| State | no router, no state library — one `App` owns the conversation, one hook owns search |
| Tests | plain Node scripts, `node:assert/strict`, esbuild from `vite` run under `node` |
| Platform | must run on Windows as well as Linux/macOS |

Non-negotiable constraints:

- **No secret ever reaches the browser.** Provider keys live in edge-function secrets or the
  service-role-only `app_config` table. The browser only ever holds `VITE_SUPABASE_URL` and
  `VITE_SUPABASE_ANON_KEY`.
- **No secret is ever printed.** Reports name keys, never values.
- **No `npx` inside a test harness.** `npx` goes through `cmd.exe`, which strips the quotes out of
  `--define` and produces invalid JSON. Build with `node node_modules/esbuild/bin/esbuild`.
- **No literal `/tmp` at runtime.** `/tmp` is `C:\tmp` to Node but not to native binaries. Use
  `os.tmpdir()` via `experiments/lib/build.mjs`.
- **Never weaken a check to get green.** No dropped assertions, no widened tolerances, no
  `2>/dev/null` around a failing command.
- **`main` stays linear and green.** No force-push.

---

## 3. Repository layout (every file, as it exists)

```
package.json  index.html  vite.config.ts  vite.preview.config.mjs  tsconfig.json
tsconfig.node.json  tailwind.config.js  postcss.config.js
README.md  ARCHITECTURE.md  CONTRIBUTING.md  DEPLOY.md  PROJECT-PROMPT.md
.env (public Supabase URL + anon key only)  .env.functions (gitignored)
.github/  patches/  public/favicon.svg
```

### `src/` — 49 files, ~9,170 lines

| File | Lines | Responsibility |
| --- | --- | --- |
| `App.tsx` | 901 | conversation state, streaming completion, turn lifecycle, persistence, panel tab, settings |
| `index.css` | 212 | Tailwind layers, typography, scrollbars, markdown styles |
| `types/index.ts` | 181 | `Conversation`, `Message`, `Source`, `SourceRecord`, `Evidence`, `ActivityLog`, `Finding`, `ResearchProject`, `ResearchPreset`, `SearchSettings`, `ModelInfo`, `EngineStatus`, `SearchResponse` |
| `lib/api.ts` | 635 | `fetchModels`, `streamTurn`, `chatCompletion`, `webSearch`, `fetchConfiguredSecrets`, tool-call streaming, `fallbackChain`, model health, `servedModelMismatch`, `SEARCH_TOOL` |
| `lib/fusion.ts` | 630 | the ranking pipeline and `termCoverage` |
| `lib/clientEngines.ts` | 375 | browser-side keyless engines: Crossref, Europe PMC, Hacker News, Stack Overflow, Lemmy, Wikidata, Open Library, Internet Archive, crt.sh |
| `lib/grounding.ts` | 309 | verifies that every `[n]` in an answer maps to a delivered source; produces the grounding strip |
| `lib/engines.ts` | 290 | 24-engine catalogue, 5 surfaces, 5 depth scopes, keyless fallback list, issue summarisation |
| `lib/searchTool.ts` | 160 | the model-initiated search tool loop (max rounds, dedupe, abort) |
| `lib/rankExplain.ts` | 158 | intent chip and per-row date/multiplier badges, computed from the same functions the ranking used |
| `lib/providerKeys.ts` | 150 | parse `NAME=value` blocks, classify by token shape, never echo values |
| `lib/blufQuery.ts` | 133 | bottom-line-of-the-answer → search query + derived follow-up questions |
| `lib/engineKeyStatus.ts` | 132 | which engines are configured, from stored names + function probe |
| `lib/emptyResult.ts` | 120 | the gap report for a search that returned nothing, and `broadenQuery` |
| `lib/messageInsert.ts` | 110 | tolerant inserts: drop a column the DB does not have yet, retry, learn it for the session |
| `lib/claimLedger.ts` | 105 | parses the trailing `CLAIM LEDGER` section into rows |
| `lib/dorks.ts` | 104 | dork playbooks grouped by intent, with `{target}` substitution |
| `lib/promptVariant.ts` | 96 | stores which system-prompt variant produced an answer |
| `lib/machineTrace.ts` | 88 | "read in full" sources and the model's own extra searches, from the stored row |
| `lib/turnDecision.ts` | 57 | `decideAfterSearch`, both transcript notes, `unansweredKind` |
| `lib/sourceContext.ts` | 56 | the citation-ID system message handed to the model |
| `lib/runGuard.ts` | 55 | `isCurrent()` identity guard for async work |
| `lib/followUps.ts` | 54 | splits a trailing `FOLLOW-UPS` bullet list off an answer |
| `lib/systemPrompt.ts` | 48 | `FIELDWORK_SYSTEM_PROMPT` |
| `lib/emptyResultPref.ts` | 42 | remembers the "show gap report" preference |
| `lib/panelPref.ts` | 36 | remembers the panel tab/collapse state |
| `lib/supabase.ts` | 6 | the single `createClient` |
| `lib/verification.ts` | 37 | client-side verification block |
| `hooks/useSearch.ts` | 471 | run controller: `performSearch`, `runLane`, `cancelSearch`, `runAborted`, `runCancelled`, `clearResults`, `isSearching`, `status`, `issues`, `lastQuery` |
| `hooks/useEngineKeys.ts` | 50 | loads/saves the signed-in user's provider keys |
| `components/MessageBubble.tsx` | 471 | markdown answer, citations, grounding strip, machine strip, claim ledger, action row, retry row, "Keep digging" row |
| `components/SettingsModal.tsx` | 464 | model, prompt variant, provider keys, preferences |
| `components/SearchBar.tsx` | 454 | composer: depth scopes, engine picker, dorks, raw query |
| `components/InvestigationPanel.tsx` | 362 | Map / Activity / Sources / Findings |
| `components/SearchMap.tsx` | 334 | lane-yield visualisation of a run |
| `components/ChatArea.tsx` | 193 | transcript, streaming bubble, error bubble |
| `components/ModelSelector.tsx` | 157 | model list, reliability dots, refusal-free lane grouping |
| `components/Sidebar.tsx` | 146 | conversations, new chat, delete, account |
| `components/AuthScreen.tsx` | 144 | email + password gate |
| `components/EngineKeyRow.tsx` | 106 | one provider-key row with status |
| `components/SourceCard.tsx` | 97 | one source: rank, badge, engines, date, snippet |
| `components/LaneYieldRow.tsx` | 92 | one lane's returned/kept/fused bar |
| `components/WelcomeScreen.tsx` | 78 | empty-state entry points |
| `components/NoSourcesCard.tsx` | 77 | explains a zero-source run and offers a next move |
| `components/PresetSelector.tsx` | 71 | research presets |
| `components/ModelNotice.tsx` | 57 | "you asked for X, the server served Y" |
| `components/ClaimLedgerTable.tsx` | 46 | ledger rows with verdict styling |

### `supabase/` — 19 files, ~2,718 lines

| File | Lines | Responsibility |
| --- | --- | --- |
| `functions/web-search/index.ts` | 935 | server engines, per-request user keys, `engine_status`, fetch-and-extract, `GET` config probe, RRF pre-trim |
| `functions/web-search/extract.ts` | 331 | page text extraction: plain fetch, optional Firecrawl render, size caps |
| `functions/web-search/parsers.ts` | 161 | per-engine response parsers (HTML/JSON) |
| `functions/llm-proxy/index.ts` | 239 | auth, rate limit, model allowlist, streaming passthrough, usage |
| `functions/llm-proxy/rateLimit.ts` | 68 | `consume_rate_limit` RPC wrapper, bucket hashing, failure policy |
| `migrations/*.sql` | 11 files | schema, RLS, grants, app_config lockdown, rate limits, user keys, `system_prompt`, `tool_searches` |
| `config.toml` | 7 | both functions `verify_jwt = false` |

Migrations, in apply order:

1. `20261111182132_create_workhorse_schema.sql` — conversations, messages, findings, search_settings
2. `20261111193222_fieldwork_schema_expansion.sql` — sources, evidence, activity_logs, projects, presets
3. `20261112192624_create_app_config.sql`
4. `20261112192634_grant_service_role_config.sql`
5. `20261115120000_lock_app_config_service_role.sql` — plus `app_config_public` view
6. `20261115130000_tighten_anon_write_grants.sql`
7. `20261115140000_add_user_auth_rls.sql` — `user_id DEFAULT auth.uid()` + policies, anon stripped
8. `20261115150000_add_request_rate_limits.sql` — table + atomic `consume_rate_limit()`
9. `20261115160000_user_engine_keys.sql` — owner-only provider keys
10. `20261116170000_add_message_system_prompt.sql`
11. `20261117120000_add_message_tool_searches.sql` — jsonb array of the model's own queries

### `scripts/` — 7 files, ~1,300 lines

`smoke.mjs` (the gate runner), `smoke.sh`, `import-keys.mjs`, `verify-engines.mjs`,
`verify-migrations.mjs`, `apply-migrations.mjs` (`--check` / `--plan` / apply), `dev-preview.sh`.

### `experiments/` — 44 files, ~7,000 lines

33 `*.test.mjs` suites plus harnesses (`ranking-harness.mjs`, `ranking-sweep.mjs`,
`ranking-compare.mjs`, `fusion-lab.mjs`, `fusion-v3.mjs`, `lane-fusion-debug.mjs`),
`lib/build.mjs`, `rls-probe.sh`, and `fixtures/` (ranking queries, weight experiments, key samples,
engine payloads).

---

## 4. Data model

12 tables, 54 policies, one SQL function:

| Table | Purpose | Access |
| --- | --- | --- |
| `conversations` | one thread: title, model, project, preset | owner RLS |
| `messages` | role, content, model, `search_enabled`, `search_results` jsonb, `system_prompt`, `tool_searches` jsonb | owner RLS |
| `sources` | persisted fused sources incl. `publication_date`, `citation_id`, `relevance_score` | owner RLS |
| `findings` | saved/shared/discarded single results | owner RLS |
| `evidence` | claim + evidence type + confidence + corroboration | owner RLS |
| `activity_logs` | running/completed/failed run log | owner RLS |
| `research_projects` | named projects with objectives | owner RLS |
| `research_presets`, `search_settings` | shared reference data | read for authenticated |
| `app_config` | Featherless key + default model | **service role only** |
| `app_config_public` (view) | `has_api_key`, `default_model` | authenticated read |
| `request_rate_limits` | hashed bucket counters | no client privileges |
| `user_engine_keys` | per-account provider keys | owner RLS, no anon grant |

Rules: every private table has `user_id uuid DEFAULT auth.uid()`; inserts never send `user_id`;
`anon` holds no privilege on any private table; service-role grants live in their own migration.

---

## 5. Search path

`useSearch` owns one run at a time. A new run aborts the previous `AbortController`, and every
`setState` is guarded by an `isCurrent()` identity check, so a slow engine cannot write over newer
results. Cancelling aborts search **and** completion together.

`performSearch`:

1. Split the engine selection into server (`web-search`) and browser (`clientEngines`) sets.
2. Run both in parallel. Server results arrive with `engine_status[]`; browser engines report their
   own statuses locally.
3. Regroup each returned source by `source_engine`; hand those per-engine lists to `fuseResults`.
4. Persist the fused list to `sources` (with `publication_date`), log activity, close the activity
   row, and build the citation system message.

If every selected engine reports failure or emptiness, **do not call the model**. Emit the gap
report instead (see §9).

### Engine catalogue (24)

Server (17): duckduckgo, brave, google*, exa*, searxng*, tavily*, firecrawl*, arxiv, openalex,
wikipedia, github, grepapp*, ahmia*, shodan*, urlscan*.
Browser (9): crossref, europepmc, hn, stackexchange, lemmy, wikidata, openlibrary, archiveorg, crtsh.

`*` = `needsSetup` (requires a key or a self-hosted URL). Keyless fallback set:
`duckduckgo, wikipedia, arxiv, github, hn, crossref, europepmc` — a search that returns nothing
retries on these, so a missing key thins the ranking instead of blanking the page.

Surfaces (5): surface web, deep web, dark web (Ahmia), code & repos, infrastructure.
Depth scopes (5): Recent, Deep, Lost, Dark, All — each a one-tap engine bundle; `matchScope`
reports which scope the current manual selection equals, or `null`.

Dorks: ~30 playbooks across Exposed files, Secrets & credentials, Databases & backups,
Infrastructure & fingerprints, with `{target}` substitution. Only engines that actually parse dork
syntax join a dork lane (`duckduckgo, brave, google, exa, searxng, tavily, firecrawl, ahmia`).

---

## 6. Fusion — `src/lib/fusion.ts`

Pipeline: **canonicalise → IDF relevance → intent-weighted RRF → entity resolution → agreement
boost → per-domain cap → coverage quota → score sort → tail fill.**

- **Canonical URL**: lowercase host, strip `www`, drop tracking params, `arxiv.org/abs/` →
  `/pdf/`. Entity key and dedupe key.
- **Relevance**: IDF-weighted term coverage of title + snippet; title matches count 1.15×. Dork
  operators are stripped first, so `site:tesla.com filetype:pdf` is scored on `tesla`.
- **Score**: `weight / (60 + rank + 1) × relevance^1.5 × (1 + 0.6 × recency)`.
- **Intent weights**: `queryIntent()` scores freshness, evergreen-ness, conceptual prose and
  navigational shape (quoted phrase, CVE, IP, domain, `site:`). Exa up for conceptual, down for
  identifiers; Tavily the reverse plus a recency bonus. Clamp 0.25–1.6. A year inside an identifier
  (`CVE-2024-3094`) is not freshness.
- **Recency**: only for freshness-seeking queries. ≤30d 1.0, ≤180d 0.65, ≤2y 0.35, older 0.12.
  Undated sources score 0 — adding nothing is honest; inventing a date is not.
- **Entity resolution**: same DOI, same canonical URL, or title-token Jaccard ≥ 0.6 → one entity.
  Best score wins; `×1.02` per extra engine (cap 3); `×1.15` per duplicate.
- **Coverage quota then score sort**: every contributing engine appears in the output even if its
  best result scores badly — then `chosen` is sorted by score so inclusion does not decide position.
- **Tail fill**: refuses any entity sharing a canonical key with something already placed.
- **Output**: `source_engine` becomes the joined engine list (`crossref+wikipedia`), plus `engines[]`,
  `relevance`, `relevance_score`, `published`, `[n]` citation id, and `laneYield` per engine
  (`returned` / `kept` / `fused`).

`termsCoverage` is exported so the benchmark fixture can prove its tie pairs are *exactly* equal on
coverage rather than asserting it in prose.

---

## 7. Answer pipeline

`FIELDWORK_SYSTEM_PROMPT` (verbatim requirements):

- **Answer budget**: 150 words factual, 300 explanation, 500 comparison/survey, never >600
  including ledger and follow-ups. No preamble, no restating.
- **Shape**: 2-4 sentence lead (what the sources collectively show, answer first, then the strongest
  caveat) → detail with numbers/dates/names → claim ledger → FOLLOW-UPS and nothing after.
- **Citations**: every factual sentence carries `[n]` from delivered IDs. Never invent, never
  renumber, never cite a source that does not support the sentence. Multiple: `[2][5]`.
- **Claim ledger**: heading exactly `CLAIM LEDGER`, ≤6 lines, `- [n] claim — established | claimed |
  contested`. `established` = several independent sources or a primary document; `claimed` = one
  source, nothing corroborating; `contested` = sources disagree, name who says what.
- **Disagreement**: both positions with citations, never average conflicting numbers.
- **Thin evidence**: say so in one line, answer only what is supported.
- **No sources**: answer from general knowledge, say once that nothing is cited, skip the ledger.
- **FOLLOW-UPS**: exactly three searchable questions, heading exactly `FOLLOW-UPS`, bullets only.

Client-side post-processing, in order:

1. `splitFollowUps` removes the trailing section **only** when the heading is followed exclusively by
   bullets; otherwise the text stays. Max 4 questions, ≤200 chars each.
2. `splitClaimLedger` parses the ledger into rows for `ClaimLedgerTable`.
3. `grounding` maps every `[n]` to a delivered source and reports unmapped markers (never silently
   dropping them).
4. `blufQuery.blufOf` takes the lead sentences (citations, links and markdown stripped, max 3
   sentences / 400 chars), extracts up to 8 distinctive terms — filtering both stop words and
   meta-vocabulary ("sources suggest", "evidence indicates") — and returns:
   - `query`: the terms verbatim, no operators, so nothing can be restricted;
   - `followUps`: three fixed frames around those terms —
     `What is the strongest primary source on {topic}?`,
     `What evidence contradicts {topic}?`,
     `What changed about {topic} in the past year?`.
   Fewer than two terms → no query and no derived questions (a chip searching "sources suggest" is
   worse than no chip).
5. Derived chips are suppressed for gap reports, stopped/superseded notes, `Error:` posts, mid-stream
   answers, and when the model supplied its own FOLLOW-UPS — the model's questions win.

---

## 8. Chat reliability rules

`decideAfterSearch({ aborted, cancelled, superseded })`:

| State | Action |
| --- | --- |
| not aborted | `answer` — search is a bonus, chat is the point |
| aborted + superseded | `superseded-note` |
| aborted + cancelled | `stopped-note` |
| aborted, neither | `answer` |

Exact note texts:

```
_(Search stopped — nothing was answered. Send the question again, or switch Search off to just talk.)_
_(Search replaced by a newer question — this one was not answered. Ask it again if you still want it.)_
```

`unansweredKind(content)` compares the **trimmed exact text**, so an answer that merely mentions a
stopped search is not mistaken for one. The transcript renders a **Retry** button next to either
note and next to any answer starting with `Error:`. Retry re-asks the whole question through
`handleSendMessage` with a fresh turn — not just the search — because those states say *nothing* was
answered.

Persistence uses `insertRowTolerant`: attempt the insert; on a Postgres `PGRST204` / missing-column
error, strip that column, retry once, and remember the omission for the session so later rows skip it
silently. Applied to `system_prompt` and `tool_searches`, which may not exist on an older database.

---

## 9. Empty and failed results

`buildGapReport({ query, engines, issues, laneYield, queries })` produces:

```
**No sources.** A search for “<query>” across <engines> finished without a usable source, so there
is no answer to give.

**Gaps**
- <engine> — <failure label> (<detail>)
- <Engine> answered with nothing
- <Engine> returned 6 results and the relevance gate kept none of them

No answer is given because nothing collected here supports one. Widen the query, add an engine with
a working key, or run a lane, then ask again.
```

An engine that already failed is not blamed twice for an empty lane. `isGapReport` recognises the
opening `**No sources.**` so the bubble can style it and suppress follow-up chips.
`broadenQuery` removes restricting operators and quotes first; if none were present it drops the last
word of a >3-word query.

`NoSourcesCard` covers the case where the panel has no sources but the run is over: it names the
engines, the failures and the next move, and never shows a bare empty list.

---

## 10. Keys, limits, proxy

Key resolution, per request, in `web-search`:

1. `user_engine_keys` — the caller's own row (JWT-resolved, RLS owner-only).
2. Function environment secrets.
3. `app_config` (service role) for Featherless — never a search key.

If a caller's key is rejected (401/403), the engine retries once on the deployment secret and reports
`key_fallback` with `your <NAME> was rejected (http 401); used the function's own key`. A stale
personal key must neither break a working deployment nor disappear silently.

Secret names: `EXA_API_KEY`, `TAVILY_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_CSE_ID`, `SEARXNG_URL`,
`FIRECRAWL_API_KEY`, `SHODAN_API_KEY`, `URLSCAN_API_KEY`, `GREPAPP_BASE_URL`, `GREPAPP_COOKIE`.

Rate limits, enforced in `llm-proxy` **before** reading the key or spending credit:

| caller | per minute | per day |
| --- | --- | --- |
| signed-in account | 30 | 600 |
| anonymous (IP) | 4 | 40 |

Bucket = SHA-256 of the auth user id, or of `cf-connecting-ip` / first `x-forwarded-for` hop.
Counters live in `request_rate_limits` (no client grants) and increment atomically through
`consume_rate_limit()`. Refusal is HTTP 429 with `Retry-After` and a `rate_limited` body, shown
verbatim by the client and never retried as model capacity. If the counter itself errors, the request
is allowed and the failure logged — an availability choice, stated as such.

`llm-proxy` also enforces a model allowlist, records the served model, and surfaces a mismatch
(`ModelNotice`) rather than silently substituting.

---

## 11. UI surface

- **Composer** (`SearchBar`): depth scopes, engine picker grouped by surface, dork playbooks, raw
  query. This is the primary control, not a side panel.
- **Transcript** (`ChatArea` → `MessageBubble`): lead formatted as answer-first prose; citations as
  superscript chips; a grounding strip; the claim ledger; a machine strip reading "read in full" and
  "searched again" from the stored row; an action row (copy / share / save / retry); a **Retry** row
  for unanswered turns; a **Keep digging** row with the BLUF query chip plus the model's own
  follow-up questions (or derived ones).
- **Panel** (`InvestigationPanel`): Map, Activity, Sources, Findings. Sources leads with the ranking
  intent chip, then engine contribution bars, then per-engine groups; each row shows rank, engine
  badges, date and recency multiplier computed from the same functions the ranking used.
- **Sidebar**: conversations, new chat, delete, account, sign-out.
- **Gate** (`AuthScreen`): email + password; confirmation-aware copy.
- **Empty state** (`WelcomeScreen`): example queries and surfaces, never a blank page.

Visual language: dark, dense, monospace-adjacent metadata, one accent colour, no decorative imagery.
Panels are collapsible and the choice persists.

---

## 12. The gate

```bash
npm run smoke            # build (tsc -b && vite build) + all checks, no network
npm run smoke -- --live  # + read-only probes against the hosted project
```

36 checks on a full install (32 always, 4 PGlite database checks). Exit non-zero on any failure.
`SKIP` is not a pass: it means `@electric-sql/pglite` or `react-test-renderer` is missing.

Every suite bundles the **real** source through `experiments/lib/build.mjs` and imports it, so a test
cannot drift from what ships. That helper provides `tmpPath` (uses `os.tmpdir()`), `bundle` (esbuild
under node), `bundleSync`, `asUrl` (`file://` URL for `import()`), and `installWebSocketStub` (Node
20 needs a stub because supabase-js constructs a realtime client at import).

Component tests render with `react-test-renderer` or `renderToStaticMarkup`, bundling with
`--jsx=automatic --external:react --external:react-dom` **into `node_modules/.cache/fieldwork/`** (an
external `react` must resolve from the project's own `node_modules`).

Ranking has its own sub-gate:

```bash
node experiments/ranking-harness.mjs --check              # fails on nDCG or margin regression
node experiments/ranking-harness.mjs --compare spec.json  # score your own weights
node experiments/ranking-sweep.mjs --ablate               # what each constant buys
node experiments/ranking-sweep.mjs --assert-separation    # fails if a constant stops separating
node experiments/ranking-sweep.mjs --stability            # leave-one-out across queries
```

The fixture is **contested on purpose**: each query pairs two results with near-identical term
coverage, so only engine trust or a date can separate them. Title-token Jaccard stays below 0.6 so
entity resolution does not merge the pair. `--check` verifies equal coverage, no merge, and that each
`*-tie` class still moves ≥0.05 nDCG. Margin gates: overall mean down >0.02 or class mean down >0.05
fails, because a shrinking lead is the leading edge of the next reorder.

Commit convention: Conventional Commits scoped by area (`feat(search)`, `fix(fusion)`,
`test(ranking)`, `docs`), imperative subject, body explaining *why* and the measured effect.
`tsconfig.tsbuildinfo` is tracked and regenerated by every build — restore it before committing.

---

## 13. Current state (what is finished, what is not)

Repo: complete and green. Hosted project: **behind the repo**.

Pending on the deployment (`mhfsggpnnjyxsnshqatf`):

- 5 migrations unapplied: user RLS, rate limits, user engine keys, `system_prompt`, `tool_searches`.
- `web-search` deployed at a pre-`engine_status` build (no diagnostics, no per-user keys).
- `llm-proxy` deployed without the limiter.
- Both need `SUPABASE_ACCESS_TOKEN`, which is not in the environment.

Consequences, all of which degrade honestly: the machine strip's "read in full" and "searched again"
stay empty (the function never returns extracted text), `Searched again` is never observed, and
answers save without `system_prompt` until migration 10 runs.

Everything else — chat reliability, retry, gap reports, grounding, BLUF chips, derived follow-ups,
fusion, ranking benchmarks, RLS, rate limiting, key precedence — is implemented, tested and green.

---

## 14. Build order

1. Schema + RLS + service-role `app_config`; nothing private readable by `anon`.
2. Supabase client, auth gate, conversations/messages CRUD.
3. Server `web-search` with `engine_status`; browser engines; `fuseResults`.
4. `useSearch` controller with abort/supersede guards.
5. `llm-proxy`: allowlist, rate limit, streaming; `streamTurn` with tool-call support.
6. Answer post-processing: follow-ups, ledger, grounding, machine trace.
7. Turn decision + notes + retry + tolerant inserts.
8. Gap reports, `NoSourcesCard`, `broadenQuery`.
9. BLUF query + derived chips.
10. Ranking harness, sweep, contested fixture; wire everything into `npm run smoke`.
11. `DEPLOY.md` runbook; apply migrations and redeploy functions.
