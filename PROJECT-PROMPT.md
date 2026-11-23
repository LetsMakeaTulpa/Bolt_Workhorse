# Fieldwork — build specification

Fieldwork is a single-page research console: you ask a question, it fans out to many search
engines, fuses and ranks what comes back, reads the top pages, and answers with citations. The
answer, the sources and the machinery behind both are all inspectable.

---

## 0. How to use this document

**Task.** Inspect the current repository and bring it into compliance with this specification.
Preserve the existing architecture unless a requirement cannot be met within it. Treat this document
as authoritative for **product behaviour**; treat the repository as authoritative for its **current
implementation and deployment state**. Where they disagree, report the disagreement and resolve it
in favour of this specification.

**Before changing files.** List the requirements that are not met and the files you expect to
change. Do not start with a rewrite of something that already satisfies a requirement.

**Done means.** Every requirement in §1–§5 is implemented; the repository's prescribed checks pass
(`npm run smoke`, plus the ranking sub-gate in §6); no secret appears in the client bundle, a log, a
commit or a report; and the final report lists the changes made, the checks run with their real
output, and any deployment work that could not be completed.

**How to read the rest.** §1–§6 are stable requirements: they stay true as the implementation
changes. §7 is a build order, useful but not binding. **Appendix A is a dated snapshot, not a
requirement** — file lists, migration state and deployment state go stale by design, and nothing in
it should be implemented as though it were a rule.

---

## 1. Product rules

1. **Nothing silently returns nothing.** Every search reports, per engine, whether it answered, was
   empty, lacked a key, or failed — with a human-readable detail. A blank panel is a bug.
2. **An answer is never presented as sourced when it is not.** The transcript labels unsourced
   answers, the model is told what it does and does not have, and the UI never invents a citation.
3. **The app may reformat an answer; it may never extend one.** Follow-up chips, subject queries and
   ledger rows are parsed from the answer's own text. Nothing is generated at render time, so the UI
   cannot hallucinate.
4. **Chat is the product; search is the bonus.** A thin or empty search informs the answer, it does
   not replace it. The single exception is a turn the user stopped or replaced, which must say so
   rather than answer something nobody is waiting for.
5. **Ranking is measured, not guessed.** A constant that cannot be shown to move a metric over the
   contested fixture is a constant nobody can defend.
6. **Degrade honestly, never silently.** A stale deployment, a missing column, a rejected key or an
   empty engine changes what the UI *says*, never what it *claims*.

---

## 2. Functional requirements

### 2.1 Accounts and access

- The app requires a Supabase Auth account (email + password). Signed-out visitors see the gate and
  nothing else.
- Every private row is scoped to `auth.uid()` by row-level security. Two accounts on one deployment
  never see each other's conversations, sources, findings or provider keys.
- Inserts must not send `user_id`; the column defaults to the caller.

### 2.2 A turn

1. The question is appended to the transcript and saved before any search runs.
2. If search is on, engines are queried (§2.3). If it is off, the model answers from its own
   knowledge, and the transcript does not badge that answer as unverified — the user chose not to
   search.
3. The model streams; tokens are visible as they arrive, and the partial can be stopped.
4. The finished answer is saved with: its model, the exact system prompt used, the sources it was
   given, its gaps, the queries that produced those sources (`queries_used`) and the model's own
   searches with what each added (`tool_searches`, `tool_search_yields`). The reader's verdict is
   written to the same row when it is pressed (§2.8).
5. A stop during streaming persists the partial, labelled as partial. A stop during **search** is a
   different state and is covered in §2.7.

### 2.3 Search fan-out

- Engines split into **server** engines (run inside the `web-search` edge function) and **browser**
  engines (keyless, CORS-open APIs called from the page). Both run in parallel.
- One run at a time: starting a new run aborts the previous one, and every state write is guarded by
  an identity check, so a slow engine cannot overwrite newer results.
- Cancelling cancels search **and** generation: a stale answer is as wrong as stale sources.
- Results are regrouped per engine and fused (§4), then persisted with publication dates.
- The model runs its own searches through two tools. `search_web` takes a plain query;
  `search_dorks` takes one carrying an operator (`site:`, `inurl:`, `intitle:`, `filetype:`, `ext:`,
  a quoted phrase) and refuses anything else with a sentence saying so, because a dork with no
  operator is a plain search pretending to be one. A dork skips the query compiler — the operator
  *is* the request — and runs only on the engines that parse operators, so it never spends a slot
  where `site:` would be read as text. Both tools spend the same extra-search budget.
- Each extra search records `found` and `added`, where `added: 0` says the query returned only pages
  this answer already held — a different outcome from one that added five, never rendered the same.
- Every run is recorded as it ran: one `search_runs` row with the per-lane lists (lane, engine,
  query, ordered canonical urls) and a `lanes_hash` fingerprint that stays stable across runs with
  identical lanes, whatever order the engines answered in. Fusion collapses the lanes, so this is
  the only record from which two runs can be compared, and it is written whether or not the run
  produced a source, because the zeros are part of the comparison.

**Engine status is a contract.** Each requested engine reports exactly one of:

| status | meaning | counted as answered | UI severity |
| --- | --- | --- | --- |
| `ok` | answered with ≥1 result | yes | hidden |
| `empty` | **answered successfully with zero results** — a valid response, not a failure | yes | informational |
| `missing_key` | no key for this account and none on the deployment | no | warning |
| `error` | the provider refused or failed; `detail` carries the upstream code | no | warning |
| `unknown_engine` | the deployment does not know this engine | no | warning |
| `key_fallback` | the caller's key was rejected (401/403) and the **deployment's key answered** | yes | informational |

`key_fallback` is neither `ok` nor `error`: results are real, and the rejection must still be shown,
because a personal key that silently stopped working is the thing this status exists to reveal.
A missing or failed engine never empties the response — the others still answer.

### 2.4 The answer contract

The system prompt is versioned and saved with each answer. Its requirements:

- **Budget**: 150 words for a factual lookup, 300 for an explanation, 500 for a comparison or
  survey; **never more than 600, ledger and follow-ups included**. No preamble, no restating the
  question.
- **Shape**: a 2–4 sentence lead (what the sources collectively show — answer first, then the
  strongest caveat) → the detail that matters (numbers, dates, names) → claim ledger → FOLLOW-UPS,
  and nothing after it.
- **Citations**: every factual sentence carries at least one `[n]` drawn from the IDs supplied with
  the sources. Never invent, never renumber, never cite a source that does not support the sentence;
  several sources for one claim are written together (`[2][5]`). A sentence resting on nothing is
  marked as the model's own reasoning or deleted.
- **Claim ledger**: heading exactly `CLAIM LEDGER`, at most six lines, each
  `- [n] claim — established | claimed | contested`. `established` = several independent sources or
  a primary document; `claimed` = one source, nothing corroborating; `contested` = sources disagree,
  naming who says what. No prose restatement.
- **The ledger is audited, not taken at its word.** Every row the model calls `established` must cite
  a source this answer has, and every figure or name in that row must appear in the part of the page
  the prompt carried. A row whose number is in no cited page stops reading as settled and names the
  figure and the pages checked; a citation the answer does not have says so; a snippet-only source is
  `unchecked` — not wrong, because the figure may be below where the snippet stopped. `claimed` and
  `contested` rows are still audited, but their verdict is never overturned.
- **Disagreement**: both positions with citations, and never a midpoint no source reports.
- **Thin evidence**: say so in one line and answer only what is supported.
- **FOLLOW-UPS**: exactly three questions a researcher would ask next, each answerable by a search,
  heading exactly `FOLLOW-UPS`, bullets only. They count toward the 600-word cap — a model that is
  running out of budget shortens the detail, never drops a citation to make room.

The client tolerates drift rather than trusting the contract: a missing follow-up section, a
pipe-delimited ledger or a decorated heading must render sensibly, never as raw markup dumped into
the answer.

### 2.5 Zero usable sources — one behaviour

This was previously specified two ways. The rule is:

> **A search that collects nothing still ends in an answer, and that answer is labelled as
> unsourced.** The gaps are disclosed in the Sources panel and the activity trail, not in place of
> the answer.

Precisely:

- The model is called with an explicit instruction that the run produced no usable sources, that it
  is answering from its own knowledge, and that it must not invent URLs, titles or citation IDs.
- The transcript shows the answer with an **`Unverified — no sources retrieved`** badge. It carries
  no citation chips, no claim ledger and no grounding verdict — there is nothing to audit.
- Under that answer the transcript lists the turn's **gaps**, the same lines the panel carries:
  which engine failed and why, which lane came back empty, which lane the relevance gate emptied.
  The panel can be collapsed; the reason a search found nothing must not be. The lines are recorded
  with the answer, so a reload still shows them.
- With the **require-disclosure** preference on (the default), the answer's own text must state that
  it is not backed by retrieved sources. With it off, the statement is the model's choice. The badge
  and the gap list are unaffected either way: a turn that collected nothing always records its gaps
  and always shows them, because the preference is about the answer's prose, not about disclosure.
- The **Sources panel** renders `NoSourcesCard`: the query, the gaps (which engine failed and why,
  which lane came back empty, which lane the relevance gate emptied), and the two next moves —
  a broadened query and a dork lane. It is never a blank page.
- A stored message that begins `**No sources.**` is rendered as a gap report — its gaps as a list,
  its next moves as buttons — because historical rows and hand-written ones exist. The app must not
  generate one as a substitute for an answer.

Citations: an `[n]` that maps to no delivered source is rendered as written and flagged by the
grounding strip; it is never silently stripped, because a deleted marker hides a fabricated claim.

### 2.6 Next actions after an answer

- **Model follow-ups first.** If the answer ended with a valid `FOLLOW-UPS` section, those questions
  are the chips. They are searchable, so pressing one sends a new turn.
- **Derived questions second.** When the model wrote none, the answer's own lead supplies a subject:
  the longest run of adjacent content words in the lead, capped at five, with a trailing acronym that
  merely repeats the phrase dropped. The subject must be **substantive** — carry a capitalised word,
  a digit, or a term of six letters or more — or no questions are derived, so an answer cannot spawn
  the same three stock questions forever.
- **A subject query chip** offers that phrase as a search, and is omitted when it is the same query
  as one the model already ran itself (that one is already offered under "Searched again").
- Every search-only control says so in its label, not only in a tooltip: the post's source row action
  is "Search only", the subject chip carries a "Search" tag, and the model's own queries sit under
  "Searched again · search only". None of them rewrites the post it sits on; the whole-turn control
  is "Ask again", and is the only one that does.
  The post reports the run instead: how many sources came back, how many this answer did not have,
  and one control that answers again from them without querying an engine.
- Chips never appear on gap reports, stopped/replaced notes, `Error:` posts, or a mid-stream answer.

### 2.7 Stops, replacement and retry

| situation | what the turn does |
| --- | --- |
| search not interrupted | answer |
| a newer question replaced this one | leave a note saying it was replaced, not answered |
| the user pressed stop during search | leave a note saying it was stopped, not answered |
| search interrupted for any other reason | answer anyway; chat is the point |

- Both notes are exact, fixed strings; recognising them by exact text keeps an answer that merely
  mentions a stopped search from being mistaken for one.
- Either note, and any answer beginning `Error:`, offers a **Retry** that re-asks the whole question
  as a fresh turn — not just the search — because those states say nothing was answered.
- The note is persisted. A reload must not put the question back on screen with nothing under it,
  and must not take its Retry away.
- A retry records which attempt it replaced (`messages.retry_of`), so a reload can still link the
  two. The link is written only to a row the database accepted: the foreign key would reject an id
  that was never saved, and take the new question with it.

### 2.8 Rating an answer

Every finished answer carries one press — **Did this answer the question?** yes / no — stored as
`messages.useful`: `true` answered, `false` missed, `null` nobody said. A row nobody rated is not a
miss.

- The verdict is about the whole turn — its queries, the pages the prompt carried, the terms that
  ranked them — not about one sentence of it.
- One press is the whole interaction; pressing the same answer again does not toggle it off.
- The write is optimistic: the row changes at once and rolls back when the database refuses. A
  refusal caused by the missing column says so, instead of blaming the reader.

---

## 3. Security and data contracts

### 3.1 Keys

Resolution order per request: the caller's `user_engine_keys` row → the function's environment
secrets → (for inference only) the service-role-only `app_config` row.

- A secret never reaches the browser, a log line, a commit or a report. Reports name keys, never
  values.
- The browser holds exactly two public values: `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
- A rejected personal key falls back once to the deployment key and reports `key_fallback` (§2.3).
- Secret names: `EXA_API_KEY`, `TAVILY_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_CSE_ID`, `SEARXNG_URL`,
  `FIRECRAWL_API_KEY`, `SHODAN_API_KEY`, `URLSCAN_API_KEY`, `GREPAPP_BASE_URL`, `GREPAPP_COOKIE`.

### 3.2 Data

Thirteen tables, all private ones owner-scoped by RLS: `conversations`, `messages`, `sources`,
`findings`, `evidence`, `activity_logs`, `research_projects`, plus shared reference data
(`research_presets`, `search_settings`), service-role-only `app_config` with an authenticated
`app_config_public` view, client-inaccessible `request_rate_limits`, and owner-only
`user_engine_keys` and `search_runs`. `anon` holds no privilege on any private table.

A schema that lags the code is tolerable, silently losing data is not: an insert naming a column the
database does not have drops that column, saves the rest, and says so once per session.

### 3.3 Rate limits

Enforced in `llm-proxy` **before** the key is read or credit is spent:

| caller | per minute | per day |
| --- | --- | --- |
| signed-in account | 30 | 600 |
| anonymous (by IP) | 4 | 40 |

Buckets are SHA-256 hashes of the user id, or of the client IP when no valid session is presented;
counters live where no client role can read or write them and increment atomically. A refusal is
HTTP 429 with `Retry-After`, shown verbatim and never retried as if it were model capacity. If the
counter itself errors the request is allowed and the failure logged — an availability choice, stated
as such.

The proxy also enforces a model allowlist and reports the model that actually served the answer when
it differs from the one requested.

### 3.4 Search limits and the query compiler

`web-search` is deployed with `verify_jwt = false`, so the public anon key reaches it. One request
fans a query across the selected engines — spending the deployment's provider keys — and pays for a
model call compiling the queries before any engine answers. The same atomic counter gates it,
checked before the body is even parsed:

| caller | per minute | per day |
| --- | --- | --- |
| signed-in account | 60 | 600 |
| anonymous (by IP) | 20 | 100 |

Buckets are namespaced `web-search:user:<hash>` and `web-search:anonymous:<hash>`, so a search never
consumes an inference budget; the refusal is HTTP 429 with `Retry-After` and a human `message` the
composer shows verbatim. A broken counter allows the search and logs it, the same availability
trade the proxy makes.

The compiler is bounded on every axis: one attempt, `max_tokens` 220, an abort after 12s
(`SEARCH_COMPILER_TIMEOUT_MS`), at most five queries capped at 160 characters, de-duplicated, with
list markers and lead-in lines stripped. It is no longer hidden: every response carries
`compilation` — `model`, `ran`, `reason` (`ok`, `disabled`, `no_key`, `timeout`, `error`, `empty`),
the queries used, duration and provider-reported tokens — and the activity trail writes one
`compile` row from it. The model is `Qwen/Qwen2.5-7B-Instruct` unless `SEARCH_COMPILER_MODEL` names
another. A search never silently spends on a rewrite it does not show.

---

## 4. Ranking specification

Pipeline: **canonicalise → IDF relevance → intent-weighted RRF → entity resolution → agreement
boost → per-domain cap → coverage quota → score sort → tail fill.**

The constants below are the specification; each is paired with the outcome that makes it
observable, and each is gated by the benchmark in §6.

| stage | rule | observable outcome |
| --- | --- | --- |
| Canonical URL | lowercase host, no `www`, tracking params dropped, `arxiv.org/abs/` → `/pdf/` | the same page from two engines is one entity |
| Relevance | IDF-weighted term coverage of title + snippet, title matches ×1.15; dork operators stripped first | `site:tesla.com filetype:pdf` is scored on `tesla`, not on its operators |
| Score | `weight / (60 + rank + 1) × relevance^1.5 × (1 + 0.6 × recency)` | a result that only matches common words cannot lead |
| Intent weights | engine trust adjusted by query character (freshness, evergreen, conceptual, navigational); clamped 0.25–1.6 | a conceptual query ranks Exa's result higher than Tavily's, and an identifier query reverses that |
| Identifier rule | a year inside an identifier (`CVE-2024-3094`) is not freshness | an identifier query gets no recency bonus |
| Recency | only for freshness-seeking queries: ≤30d 1.0, ≤180d 0.65, ≤2y 0.35, older 0.12; undated = 0 | an undated source never outranks a comparable dated one on a freshness query |
| Entity resolution | same DOI, same canonical URL, or title-token Jaccard ≥ 0.6 → one entity | duplicated coverage from three engines is one row, not three |
| Agreement | best score wins, ×1.02 per extra engine (cap 3), ×1.15 per duplicate | a corroborated result leads, and its row names every engine |
| Coverage quota | every contributing engine appears in the output; then the list is sorted by score | a weak engine's best result is present but not promoted |
| Tail fill | refuses any entity sharing a canonical key with something already placed | no duplicate URL anywhere in the output |

Output carries: the joined engine list, per-engine `engines[]`, `relevance` and `relevance_score`,
`published`, a `[n]` citation id, and per-engine lane yield (`returned` / `kept` / `fused`). A
source's page text, when the function read it, travels with it.

Sources are handed to the model in rank order: every fused source, with each page's text capped
(4,000 characters; 3,000 in the model's own search loop, which is limited to the top 8).

---

## 5. UI requirements

- **Composer** — the primary control: depth scopes (Recent / Deep / Lost / Dark / All), an engine
  picker grouped by surface, dork playbooks, and a raw query. One-tap scopes are engine bundles, not
  a separate mode.
- **Attachments** — a paperclip in the composer adds files to the question. Each file becomes a chip
  with its own preview of the text that will be sent; the text is read in the browser, long files are
  truncated with the cut marked, and the attachment rides into the turn as labelled blocks ahead of
  the question. Nothing is uploaded on attach, so a file only leaves the browser as part of a turn.
  The files go into the **message**, never into the **search**: the engines are asked the question,
  and a file is context the answer reads, not a query string to hand a crawler.
- **Transcript** — answer-first prose; citations as markers that toggle a highlight — pressing a
  marker or its source row lights up every sentence citing that id, both directions from the mapping
  the grounding pass already builds, with nothing new stored for it; the claim ledger as a table; a grounding
  strip that reports what it checked and what it could not; a machine strip naming the pages read in
  full — each entry opens the exact page text the prompt carried, with how many characters it read
  and which extractor read it — the queries the model ran itself, each saying what it found and how
  much of it this answer did not already have, with a `search_dorks` call marked as a dork and
  re-runnable as written — and — when a run stored more fused sources than the prompt
  carried — how many of them the prompt carried against the total, and the publication-date window those
  sources cover, flagged when a recency-seeking query is answered by material older than the ranking's
  own aging tier; actions (copy / share / save / retry-the-search); a
  **Retry** row for unanswered turns — after a failure whose search already stored sources, the retry
  regenerates from those sources and queries no engine, so it is fast, cheap and reproducible; a
  **Keep digging** row with the subject chip and next questions; and, under every finished answer,
  the usefulness press (§2.8).
- **Panel** — Map, Activity, Sources, Findings. Sources leads with the intent chip, then engine
  contribution, then per-engine groups; each row shows rank, engine badges, date and recency
  multiplier computed by the same functions that did the ranking. An empty Sources panel after a run
  explains itself (§2.5).
- **Sidebar** — conversations, new chat, delete, account, sign-out.
- **Gate** — email + password, confirmation-aware copy.
- **Empty state** — example questions and surfaces; never a blank page.

Dark, dense, metadata in monospace-adjacent type, one accent colour, no decorative imagery. Panels
collapse and remember it.

---

## 6. Acceptance checks

```bash
npm run smoke            # typecheck + build + every check, no network
npm run smoke -- --live  # + read-only probes against the hosted project
```

- **Green means every check that ran passed, 0 failed.** The expected count is the number stated in
  `CONTRIBUTING.md` — that file is the source of truth, not this one.
- **A skip is not a pass.** A missing test-only package is reported as SKIPPED and is a red run.
- **No check may be weakened to get green.** No dropped assertions, no widened tolerances, no
  stderr suppression around a failing command.
- **Every suite bundles the real source** and imports it, so a check cannot drift from what ships.
- **Portability**: the gate runs on Windows, Linux and macOS. No harness spawns `npx`, and none names
  a literal `/tmp`.

Ranking has its own sub-gate, and a ranking change ships only with its measured effect:

```bash
node experiments/ranking-harness.mjs --check              # fails on nDCG or margin regression
node experiments/ranking-harness.mjs --compare spec.json  # score your own weights
node experiments/ranking-sweep.mjs --ablate               # what each constant buys
node experiments/ranking-sweep.mjs --assert-separation    # fails when a constant stops separating
node experiments/ranking-sweep.mjs --stability            # leave-one-out across queries
```

The fixture is contested on purpose: each query pairs two results with near-identical coverage, so
only engine trust or a date can separate them, and `--check` verifies that property rather than
trusting the fixture. A shrinking margin fails too — it is the leading edge of the next reorder.

---

## 7. Build order

1. Schema, RLS, service-role `app_config`; nothing private readable by `anon`.
2. Auth gate, conversations, messages.
3. `web-search` with the status contract, the rate gate and the reported compiler; browser engines;
   fusion.
4. The search controller with abort and supersession guards.
5. `llm-proxy`: allowlist, rate limit, streaming, tool calls.
6. Answer post-processing: follow-ups, ledger, grounding, machine trace.
7. Turn notes, retry, persistence that tolerates a lagging schema.
8. Zero-source disclosure and the panel card.
9. Subject queries and derived questions.
10. Ranking harness and the contested fixture; wire it all into the gate.
11. Per-lane run records, so two runs can be compared after fusion has collapsed them.
12. The reader's verdict on an answer; the outcome the weights are scored against.
13. The deploy runbook; apply migrations, redeploy functions, verify against the live deployment.

---

## Appendix A — repository snapshot (2026-11-23), not a requirement

Sizes, file lists and deployment state are recorded here so a reader can orient, not so they can be
reproduced. Re-read the repository instead of trusting this table.

### Shape

| area | files | what it holds |
| --- | --- | --- |
| `src/` | 58 | `App.tsx` (conversation and turn lifecycle), `hooks/useSearch.ts` (the run controller), `lib/` (34: fusion, api, engines, grounding, claim audit, ledger, follow-ups, machine trace, tool search, run record, turns), `components/` (17, including `SearchBar.tsx` with its attachment chips) |
| `supabase/functions/` | 6 in 2 | `web-search` (engines, per-request keys, status, extraction, rate limit, reported compiler), `llm-proxy` (rate limit, allowlist, streaming), each with its own `rateLimit.ts` |
| `supabase/migrations/` | 17 | schema, grants, `app_config` lockdown, RLS, rate limits, user keys, `system_prompt`, `tool_searches`, `gaps`, `retry_of`, `tool_search_yields`, `queries_used`, `useful`, `search_runs` |
| `scripts/` | 12 | the gate runner, key importer, engine and migration verification, migration runner, preview helper, the probe trio and their shared exit contract (`probe-anon`, `probe-functions`, `probeExit`), `migrationProbes`, `supabaseEnv` |
| `experiments/` | 59 | 53 suites at the top level, plus `lib/` (`build.mjs`, `mock-fetch.mjs`) and the fixtures |

### Deployment state at the snapshot (measured 2026-11-18)

Hosted project `mhfsggpnnjyxsnshqatf` is **eleven migrations behind**: everything from
`20261115140000_add_user_auth_rls.sql` onward — user RLS, rate limits, user engine keys,
`system_prompt`, `tool_searches`, `gaps`, `retry_of`, `tool_search_yields`, `queries_used`, `useful`
and `search_runs`. Until `…140000` runs, every private table is still readable with the public anon
key. Both functions are stale, measured with the anon key alone: `GET /functions/v1/web-search`
returns 500 (`Unexpected end of JSON input`), its `POST` answers without `engine_status` or
`compilation`, and six invalid-body posts to `llm-proxy/chat` return 400 six times — no 429, no
`X-RateLimit-*`. The commands that fix this need `SUPABASE_ACCESS_TOKEN`, which was not present;
`npm run migrations:check` prints the authoritative list, and `DEPLOY.md` carries the procedure and
the measured evidence.

What the drift costs: a retry reloads without its link, an extra search cannot say it added nothing,
a usefulness press is refused, the lanes behind a run are unrecorded, and both public functions
still answer unlimited calls from anyone holding the anon key.

### Known deltas between this specification and the snapshot

These are the disagreements a builder should expect to find, and fix:

1. The transcript's gap-report renderer, including its broaden and lane buttons, is reachable only
   through stored or hand-written `**No sources.**` messages today; it is kept for those, not
   generated. A zero-source run puts its gaps under its answer instead (§2.5), never in place of it.
2. `search_runs` is written on every run and read by nothing yet: the comparison view is still to
   build.
3. The usefulness verdict is stored per answer and aggregated nowhere: scoring the weights against it
   needs a harness that does not exist yet.
