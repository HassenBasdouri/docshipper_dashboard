# Deluge reference sources

These `.dg` files are **reference source for Zoho CRM Deluge functions** — Deluge only runs
inside Zoho (Setup → Developer Space → Functions), there's no local runner, so these are kept
here for version control and code review, then pasted into the Zoho function editor.

Field/module API names (`Deals`, `What_Id`, `Outgoing_Call_Status`, the user ids in
`../app/js/config.js`, etc.) come straight from the v24.1 policy doc (`../Instructions.txt`)
and were confirmed there via live `getUsers`/COQL checks on 26/08 — reuse them as-is, but
re-verify anything that looks org-specific if the schema has moved on since.

## Files

- **`digest_collect.dg`** — nightly step 1. Runs first, does all the CRM reading: bulk COQL
  pulls (Tasks/Calls owned by Alexis, Initial deals, B2B Lost deals, chat tails, supervision
  candidates), and the *deterministic* classification that doesn't need an LLM (owner-id
  checks, Gold detection, weekday-date math, D1–D8 routing into voie1/voie2/voie3 buckets).
  Output: one Deluge Map matching the JSON shape in `../ANALYSIS.md` §4, minus note text.
- **`digest_generate.dg`** — nightly step 2, runs right after step 1. Sends the Map from step 1
  to Claude with a **cached system prompt** (the static v24.1 house-rules block) and gets back
  the note text / heat ratings / "où ça en est" lines. Merges that into the final JSON, uploads
  it to WorkDrive, and updates the `Digest_url` org variable the widget reads.
- **`digest_actions.dg`** — the functions the widget's buttons call directly
  (`ZOHO.CRM.FUNCTIONS.execute`, see `../app/js/config.js` → `ACTION_FUNCTIONS`). Each one does
  exactly the write the button represents (owner change, note post, reschedule, delete,
  compensation email) — no LLM call, since the note text already came from step 2 the night
  before and travels in through the button's params.

## Deployment checklist

1. Create the `Digest_url` org variable (Setup → Developer Space → Variables).
2. Paste `digest_collect.dg` and `digest_generate.dg` in as two separate scheduled functions,
   chained (collect → generate), scheduled daily ~07:00 — matching the digest's current cadence.
3. Paste each function in `digest_actions.dg` in as its own **Custom Function**, and note its
   exact function name — it must match `ACTION_FUNCTIONS` in `../app/js/config.js`.
4. Set up: an Anthropic API key (Connections or a secure custom variable), a WorkDrive
   destination folder + upload credentials, and — for the A7 compensation email — a Gmail
   Connection authorized as Alexis (see `../ANALYSIS.md` §6, still open).
