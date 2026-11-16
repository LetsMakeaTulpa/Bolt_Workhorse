# patches

Artefacts kept for other checkouts. Nothing in this directory is applied to this repository, and
nothing in the gate exercises it.

## `xortron-all-models.patch`

Model discovery for the **`fieldwork-search`** app — a FastAPI backend with a static frontend that
lives in its own directory and branch of the Tinkering repository, not in this one. It touches three
files there:

- `backend/main.py` — `_matches_xortron` and `_rank_models`: list every XORTRON model the connected
  Featherless account can see, with the configured preferred and agent models pinned to the top.
- `backend/static/app.js` — `modelLabel` and `renderModelOptions`: show the ids as `XORTRON …` and add
  the returned models to the picker without losing the current selection.
- `README.md` — one line describing that behaviour.

Apply it from the root of that checkout (the one that contains `fieldwork-search/`):

```bash
git apply /path/to/Bolt_Workhorse/patches/xortron-all-models.patch
```

It is vendored here so the change survives in this repository's history and can be re-applied after
that other checkout is reset. It is not referenced by any script on purpose: the paths it patches do
not exist here, so wiring it into the build or the smoke gate would only produce a check that cannot
run.
