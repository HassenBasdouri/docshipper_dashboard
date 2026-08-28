# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Zoho CRM widget rendering a daily pipeline digest for any CRM user, with the sections/actions
shown gated by that user's native CRM Profile (see `ANALYSIS.md` for the full analysis this repo
is based on — read it first if you're new here). Alexis M. (Profile "Sales Manager") is the
original, fully-specified prototype; "004-SALES" (individual sales rep) is the second fully
implemented profile; every other profile (Customer Service Manager, Customer Service, Sourcing
Manager, Operations Manager, 005-OPS as of this writing) is a defined stub extension point with
no invented business rules — see "Adding a new profile" below.

The widget replaces a previous design where a Claude Project agent re-derived everything from a
live CRM/Gmail/Drive conversation every morning; that pattern burned both Zoho API credits
(dozens of small per-deal COQL calls) and LLM tokens (a 632-line policy doc reloaded every run,
sub-agents, ~565 lines of hand-written HTML/CSS/JS regenerated daily). This repo's design
confines the expensive parts to **one nightly batch job outside the widget** and makes the
widget itself a pure, static-template renderer that reads one pre-computed JSON file per user.

## Architecture

```
Deluge (nightly, ~07:00)                          Zoho CRM Widget (opens instantly, no COQL)
┌──────────────────────────┐  per-user facts    ┌──────────────────────────┐
│ digest_generate.dg loop    │ ─────────────────▶ │ digest_generate_<profile> │
│ (Digest_active_users)      │                     │  .dg — one cached Claude  │
│  for each user:             │                    │  call (skipped for stub   │
│   digest_collect(userId)    │◀───────────────────│  profiles), writes the    │
│   → routes to               │                     │  envelope JSON            │
│   digest_collect_<profile>  │                     └────────────┬──────────────┘
│   .dg (Sales Manager /      │                                  │ uploads JSON
│   004-SALES / stub)         │                                  ▼
└──────────────────────────┘                              WorkDrive file
                                                     (one entry per user in
                                                      Digest_registry org var)
                                                                  │ one fetch on open,
                                                                  │ keyed by the logged-in
                                                                  │ user's own id
                                                                  ▼
                                                    app/widget.html + app.js
                                                    renders sections listed in
                                                    the digest's own `sections`
                                                    array (app/js/render.js),
                                                    buttons call digest_actions.dg
```

- **`deluge/digest_collect.dg`** — thin profile router: looks up the user's live CRM Profile and
  calls that profile's collector (`digest_collect_sales_manager.dg`, `digest_collect_004_sales.dg`,
  or `digest_collect_stub.dg` for anything else). Also holds two shared helpers reused by every
  collector: `collectOwnTasksCalls` (a user's own open Tasks/Calls + underlying deal facts, one
  wide query each) and `classifyInitialDeals` (deterministic Gold-heat classification). All CRM
  reading happens here, in as few, wide COQL calls as possible — this is the credit-cost-sensitive
  half of the job (see `ANALYSIS.md` §2/§3). Everything decidable without judgment (owner checks,
  Gold routing, D1-D8 bucketing, weekday dates) is decided here, not left for the LLM step.
- **`deluge/digest_generate.dg`** — the nightly loop: reads `Digest_active_users`, calls
  `digest_collect` for each, branches to that user's `digest_generate_<profile>.dg`, and writes
  one shared `Digest_registry` org variable mapping every user to their own latest digest URL.
  Also holds shared helpers: `mergeSection` (generic left-join of collected facts with Claude's
  written text by `deal_id`), `makeSection` (builds one entry of the digest envelope's `sections`
  array), `buildTasksPersoRows`, and `uploadDigest` (WorkDrive upload, filename now user-qualified:
  `digest_run_<date>_<userId>.json`).
  - **`digest_generate_sales_manager.dg`** — the Sales Manager profile's Claude call: static
    house-rules system prompt from `Digest_house_rules_sales_manager` is cache-controlled
    (`cache_control: ephemeral`); only the small daily-facts JSON is uncached. Output is
    structured JSON note text, not HTML.
  - **`digest_generate_004_sales.dg`** — same mechanics, smaller scope (no dispatch/supervision
    language); its own `Digest_house_rules_004_sales` prompt. "Mes deals Initial" needs no Claude
    call at all — it's 100% deterministic pass-through from `digest_collect_004_sales.dg`.
  - **`digest_generate_stub.dg`** — no Claude call. Any profile without a real implementation
    yet gets only the common "Tasks personnelles" section, blank/editable notes.
- **`deluge/digest_actions.dg`** — one Deluge Custom Function per widget button. Each does the
  actual CRM write (owner change, note post with a fresh A8 channel check, reschedule, delete,
  A7 compensation email) with no LLM call — the note text already arrived pre-written from the
  night before, riding along in the button's params. **The real actor is always resolved from
  Deluge's own `zoho.loginuserid`, never from a client-supplied id** — see `resolveActor()` in
  that file; the one named exception is Hassen's test/admin "view as" override (see below).
- **`app/`** — the widget itself. `app.js` is the entry point: resolves the logged-in user
  (`zohoApi.js`'s `getCurrentUser()`), loads that user's own digest (`digestLoader.js`, keyed by
  user id against the `Digest_registry` org variable), and renders it. `app/js/render.js` walks
  the digest's own `sections` array through a `type` → renderer registry (`SECTION_RENDERERS`) —
  it is display-only (zero business logic — all decisions already happened in Deluge) and
  profile-agnostic: a digest simply never contains a section a profile doesn't have, so no
  profile-conditional code lives here. `app/js/config.js` holds the team directory/module
  names/action-function names (the one file to touch when the org's directory changes).
  `app/js/actions.js` wires buttons to `zohoApi.js`'s `callFunction()`, which calls the Deluge
  functions in `digest_actions.dg`.

### Test/admin "view as" switcher

`app/js/viewAs.js` lets one designated CRM user, Hassen (`4664241000160830001`, `DEV_VIEWER_ID`),
switch which user's digest his own widget session displays, so every profile's features can be
tested without a separate CRM login per profile. It's display-only on the client: the actual
write-permission enforcement lives entirely server-side in `digest_actions.dg`'s `resolveActor()`
(see above) — a non-Hassen session can never act as anyone but itself, regardless of what the
client sends. The local `npm start` preview (no CRM SDK) always shows this control too, since
there's no real identity to protect there; it resolves to the two local sample files
(`sample-sales-manager` / `sample-004-sales`) instead of the CRM registry.

## Conventions carried over from the v24.1 policy doc (`Instructions.txt` in the upload, and
## reflected in `ANALYSIS.md`) — generalized from "Alexis" to "the acting user"

These aren't arbitrary — they're read to avoid regressing behavior the team already validated:
- Never write to a Task/Call whose `Owner.id` isn't the acting user's id — re-checked server-side
  on every write (from `zoho.loginuserid`, never a client-supplied id — see above), not trusted
  from the nightly snapshot.
- A8 channel check (Costing thread present vs. absent) is **always** re-queried fresh
  immediately before posting a note, never cached.
- A7 compensation email fires after every tagging note except when the only tags are the CS
  simples listed in `app/js/config.js` (`TEAM.cs`).
- B2B Lost redispatch never changes the deal owner and never creates a follow-up for the acting
  user (`digest_redispatch_b2b_lost` in `digest_actions.dg` has no owner-update step,
  deliberately) — Sales-Manager-profile-only, enforced both by the digest envelope never giving
  another profile this section and by a server-side profile guard in the action function itself.
- Reschedule/reopen actions stay reversible client-side (`app/js/actions.js` collapse/undo), a
  carryover of the old B10 rule, minus the copy-to-clipboard step — actions are native now.

## Adding a new profile

1. Write `deluge/digest_collect_<profile>.dg` (see `digest_collect_004_sales.dg` for a real
   example, `digest_collect_stub.dg` for the floor every profile starts from) and add one branch
   to `digest_collect.dg`'s router.
2. Write `deluge/digest_generate_<profile>.dg` (see `digest_generate_004_sales.dg` / `_stub.dg`)
   and add one branch to `digest_generate.dg`'s loop. If the profile needs Claude-written text,
   create its own `Digest_house_rules_<profile>` org variable — don't reuse another profile's.
3. If the widget needs a new section *type* (beyond `card-list` / `initial-dispatch` /
   `initial-info` / `supervision` / `b2b-redispatch` / `info-table` / `ghost-table`), add one
   entry to `SECTION_RENDERERS` in `app/js/render.js`. Existing types are reusable as-is — most
   new profiles won't need a new one.
4. No frontend profile-conditional code is needed: the digest JSON's own `sections` array is
   what drives rendering.

## Commands

- Install: `npm install`
- Local preview: `npm start` (serves `app/` over plain HTTP at `http://127.0.0.1:5000`). This is
  a **rendering preview only** — there's no CRM to log into, so the widget always runs in "view
  as" mode locally (see above) and `digestLoader.js` resolves to the local sample files; none of
  the action buttons will actually call Deluge. Real testing (SDK init,
  `ZOHO.CRM.FUNCTIONS.execute`, org variables) requires deploying via the Zoho CLI (`zet`) into
  an actual CRM org.
- There is no build step, bundler, or test suite. `app/app.js` uses native ES module imports
  (`type="module"` in `widget.html`) — no transpilation.
- `plugin-manifest.json` is what the Zoho CLI (`zet`) reads for deployment — it points at
  `app/widget.html` as the widget's entry `src`. Touch it only if the widget's entry file or
  version changes.

## Known open items (see `ANALYSIS.md` §6)

CRM edition (widgets/Connections need Enterprise+), a Gmail OAuth Connection for A7 sends
(Deluge's native `sendmail` can't originate from a real Gmail address), the WorkDrive upload
endpoint/connection specifics, and a server-side Anthropic API key — all marked `TODO` inline in
the `deluge/*.dg` files where they're needed. Additionally: the 004-SALES house rules
(`Digest_house_rules_004_sales`) haven't been written yet (only Sales Manager's v24.1 doc
exists), and the 5 remaining profiles have no business rules defined at all — see "Adding a new
profile" above.
