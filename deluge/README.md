# Deluge reference sources

These `.dg` files are **reference source for Zoho CRM Deluge functions** — Deluge only runs
inside Zoho (Setup → Developer Space → Functions), there's no local runner, so these are kept
here for version control and code review, then pasted into the Zoho function editor.

Field/module API names (`Deals`, `What_Id`, `Outgoing_Call_Status`, the user ids in
`../app/js/config.js`, etc.) come straight from the v24.1 policy doc (`../Instructions.txt`)
and were confirmed there via live `getUsers`/COQL checks on 26/08 — reuse them as-is, but
re-verify anything that looks org-specific if the schema has moved on since.

Every user gets their own digest, gated by their native CRM Profile — see `../CLAUDE.md`'s
"Adding a new profile" section for how the collect/generate split below is per-profile.

## Files

- **`digest_collect.dg`** — nightly step 1 router: looks up each user's live CRM Profile and
  calls that profile's collector.
  - **`digest_collect_sales_manager.dg`** — the original Sales Manager (Alexis) logic,
    parameterized by `userId`: bulk COQL pulls (Tasks/Calls, Initial deals, B2B Lost deals,
    supervision candidates), and the *deterministic* classification that doesn't need an LLM
    (owner-id checks, Gold detection, weekday-date math, D1–D8 routing into voie1/voie2/voie3
    buckets).
  - **`digest_collect_004_sales.dg`** — individual sales rep: own Tasks/Calls, own Initial deals
    (same Gold classification, no dispatch queue), own B2B Lost deals (no piloted/redispatch
    split).
  - **`digest_collect_stub.dg`** — floor for any profile without real rules yet: just the common
    "own Tasks/Calls" bundle.
  - Output: one Deluge Map matching the envelope shape in `../ANALYSIS.md` §4, minus note text.
- **`digest_generate.dg`** — nightly step 2, runs right after step 1: loops over
  `Digest_active_users`, calls `digest_collect` per user, and branches to that user's
  `digest_generate_<profile>.dg`.
  - **`digest_generate_sales_manager.dg`** / **`digest_generate_004_sales.dg`** — send that
    profile's collected facts to Claude with a **cached, profile-specific system prompt**
    (`Digest_house_rules_sales_manager` / `Digest_house_rules_004_sales`) and get back the note
    text / heat ratings / "où ça en est" lines. Merges that into the final envelope JSON.
  - **`digest_generate_stub.dg`** — no Claude call; only the common "Tasks personnelles" section.
  - All three upload to WorkDrive (filename now `digest_run_<date>_<userId>.json`, user-qualified)
    and update that user's entry in the shared `Digest_registry` org variable.
- **`digest_actions.dg`** — the functions the widget's buttons call directly
  (`ZOHO.CRM.FUNCTIONS.execute`, see `../app/js/config.js` → `ACTION_FUNCTIONS`). Each one does
  exactly the write the button represents (owner change, note post, reschedule, delete,
  compensation email) — no LLM call, since the note text already came from step 2 the night
  before and travels in through the button's params. The acting user is always resolved from
  Deluge's own `zoho.loginuserid`, never a client-supplied id (see the file's header comment and
  `resolveActor()`) — the one exception is Hassen's test/admin "view as" override.

## Deployment checklist

1. Create the `Digest_registry` org variable (JSON map, replaces the old single-user
   `Digest_url`) and the `Digest_active_users` org variable (hand-maintained JSON array
   `[{"id": "...", "name": "..."}]` of everyone who should get a nightly digest) — both under
   Setup → Developer Space → Variables.
2. For each *real* (non-stub) profile, create its own `Digest_house_rules_<profile>` org
   variable with that profile's house-rules text (e.g. `Digest_house_rules_sales_manager` for
   the existing v24.1 doc). Stub profiles need none.
3. Paste `digest_collect.dg` + its per-profile `digest_collect_*.dg` files, and
   `digest_generate.dg` + its per-profile `digest_generate_*.dg` files, in as Deluge functions,
   chained (collect router → generate loop), scheduled daily ~07:00 — matching the digest's
   current cadence. Each per-profile file's function must be callable from its router/loop (a
   plain function-to-function call within the same scheduled-function scope, or split across
   scheduled functions if this org's Deluge plan requires it — see the TODOs inline).
4. Paste each function in `digest_actions.dg` in as its own **Custom Function**, and note its
   exact function name — it must match `ACTION_FUNCTIONS` in `../app/js/config.js`.
5. Set up: an Anthropic API key (Connections or a secure custom variable), a WorkDrive
   destination folder + upload credentials, and — for the A7 compensation email — a Gmail
   Connection authorized per acting user (see `../ANALYSIS.md` §6, still open).
6. Adding a new profile later? See `../CLAUDE.md`'s "Adding a new profile" section — no changes
   needed to this deployment checklist beyond adding that profile's files/org variable.
