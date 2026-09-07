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
Deluge (nightly, ~07:00) — SUBMIT                     Deluge (poll, ~every 15 min) — FINISH        Zoho CRM Widget
┌───────────────────────────┐  batch request    ┌─────────────────┐  results   ┌────────────────────┐  (opens instantly,
│ generate/digest_generate.dg │ per real-profile ─▶│ Anthropic       │─ pulled  ─▶│ generate/digest_    │   no COQL)
│  loop (Digest_active_users) │  user, submitted  │ Batches API     │  once      │ finish_batches.dg   │  ┌──────────────┐
│  for each user:              │  as ONE batch     │ (async;         │  "ended"   │  per successful     │  │ app/widget.  │
│   collect/digest_collect(id) │  (invokeurl has a │  generation can │            │  result: calls       │  │ html+app.js  │
│   → routes to collect/        │  fixed ~40s      │  take longer     │            │  digest_finish_       │  │ renders the  │
│   digest_collect_<profile>.dg │  timeout — one   │  than that       │            │  <profile>.dg (merge, │  │ digest's own │
│   (Sales Manager/004-SALES/   │  synchronous call │  without         │            │  section-build,       │  │ `sections`   │
│   stub); stub profiles finish │  measured ~52s)   │  blocking a      │            │  upload) and writes    │  │ array        │
│   here directly, no Claude    │                   │  Deluge call     │            │  Digest_registry       │  └──────┬───────┘
│   call needed                 │                   │  on it           │            └───────────┬────────────┘         │
└───────────────────────────┘                     └─────────────────┘                        │ WorkDrive file          │ one fetch
        │ per-batched-user facts persisted to WorkDrive (too big for an org var);              │ (digest_run_<date>_    │ on open,
        │ only {batch_id, state_file_id} goes in the short Digest_pending_batch org var         │  <userId>.json)        │ keyed by
        ▼                                                                                       ▼                        │ the user's
   Digest_pending_batch org var  ──────────────────── read by finish phase ───────────────▶  Digest_registry org var ◀───┘ own id
   (cleared once finish phase completes)                                                     (one entry per user)
```

- **`deluge/collect/digest_collect.dg`** — thin profile router: looks up the user's live CRM
  Profile and calls that profile's collector (`digest_collect_sales_manager.dg`,
  `digest_collect_004_sales.dg`, or `digest_collect_stub.dg` for anything else). Almost all CRM
  reading happens in these files, in as few, wide COQL calls as possible — this is the
  credit-cost-sensitive half of the job (see `ANALYSIS.md` §2/§3). Everything decidable without
  judgment (owner checks, Gold routing, D1-D8 bucketing, weekday dates) is decided here, not left
  for the LLM step. One deliberate exception: the Sales Manager profile's Claude call also has
  live, read-only access to a deal's Notes/Attachments/Emails via Zoho's own hosted CRM MCP server
  (`mcp.zoho.com`, "Data Operations"), connected through Anthropic's MCP connector directly on the
  batch request (`deluge/generate/digest_build_sales_manager_request.dg`) — the house-rules doc's
  C2bis decides when to call it, not `collect/`, since it's genuinely judgment-dependent per deal.
  Shared helpers: `deluge/shared/collect_own_tasks_calls.dg`,
  `deluge/shared/classify_initial_deals.dg`, `deluge/shared/trim_deal_fields.dg` (cuts a full CRM
  Deal record down to the ~13 fields actually used — an untrimmed prompt hit Anthropic's
  200,000-token context limit live).
- **`deluge/generate/digest_generate.dg`** (SUBMIT phase) — the nightly loop: reads
  `Digest_active_users`, calls `digest_collect` for each, and branches by profile. Stub profiles
  finish immediately (no Claude call) and get written straight to `Digest_registry`. Sales
  Manager / 004-SALES profiles are batched instead of called synchronously — see "Why a
  submit/finish split" below — via `digest_build_sales_manager_request.dg` /
  `digest_build_004_sales_request.dg`, one shared `POST /v1/messages/batches` call, and per-user
  state persisted to WorkDrive (`deluge/shared/upload_workdrive_json.dg`) referenced by the
  `Digest_pending_batch` org variable.
- **`deluge/generate/digest_finish_batches.dg`** (FINISH phase, its own separate Schedule) —
  polls `Digest_pending_batch`; once Anthropic reports the batch `"ended"`, fetches results and
  calls `digest_finish_sales_manager.dg` / `digest_finish_004_sales.dg` per successful result,
  which do the merge (`deluge/shared/merge_section.dg` — left-join of collected facts with
  Claude's written text by `deal_id`) and envelope-building (`make_section.dg`,
  `group_deals_by_heat.dg`, `build_personal_tasks_rows.dg`) the single-call versions of these
  functions always did, then upload via `upload_digest.dg` (WorkDrive, filename
  `digest_run_<date>_<userId>.json`) and get written into `Digest_registry`. Clears
  `Digest_pending_batch` once done.
  - **Why a submit/finish split**: a single synchronous Claude call generating a whole Sales
    Manager's notes was measured at ~52s against Deluge's fixed, non-configurable `invokeurl`
    timeout of ~40s — confirmed live, even after switching to the fastest current model
    (`claude-haiku-4-5-20251001`, from `claude-opus-5` originally) and trimming the prompt.
    `invokeurl` has no timeout override on this runtime (a `read_timeout` key was tried and
    rejected at deploy). Anthropic's Batches API is designed for exactly this kind of
    non-interactive bulk workload: submission is fast regardless of how long generation takes,
    since it doesn't block on it.
  - **`digest_build_sales_manager_request.dg`** / **`digest_finish_sales_manager.dg`** — the
    Sales Manager profile's request-build and response-finish halves: static house-rules system
    prompt, fetched from WorkDrive (too big for an org variable — see
    `deluge/shared/fetch_workdrive_text.dg`), is cache-controlled (`cache_control: ephemeral`);
    only the small daily-facts JSON is uncached.
  - **`digest_build_004_sales_request.dg`** / **`digest_finish_004_sales.dg`** — same mechanics,
    smaller scope (no dispatch/supervision language); its own house-rules doc. "Mes deals
    Initial" needs no Claude call at all — it's 100% deterministic pass-through from
    `digest_collect_004_sales.dg`.
  - **`digest_generate_stub.dg`** — no Claude call, called directly from the SUBMIT phase. Any
    profile without a real implementation yet gets only the common "Tasks personnelles" section,
    blank/editable notes.
- **`deluge/actions/`** — only the **4** functions that genuinely need to run server-side, plus
  their private helpers (see "Client vs. server actions" below for why the rest moved to the
  widget). No LLM call in any of them — note text was already written by `generate/` the night
  before and arrives as a function argument. **The real actor is always resolved from Deluge's
  own `zoho.loginuserid`, never a client-supplied id** — see `deluge/shared/resolve_actor.dg`;
  the one named exception is Hassen's test/admin "view as" override (see below).
- **`app/`** — the widget itself. `app.js` is the entry point: resolves the logged-in user
  (`zohoApi.js`'s `getCurrentUser()`), loads that user's own digest (`digestLoader.js`, keyed by
  user id against the `Digest_registry` org variable), and renders it. `app/js/render.js` walks
  the digest's own `sections` array through a `type` → renderer registry (`SECTION_RENDERERS`) —
  it is display-only (zero business logic — all decisions already happened in Deluge) and
  profile-agnostic: a digest simply never contains a section a profile doesn't have, so no
  profile-conditional code lives here. `app/js/config.js` holds the team directory/module
  names/action-function names. `app/js/actions.js` wires buttons to either `app/js/crmApi.js`
  (direct `ZOHO.CRM.API` writes) or `zohoApi.js`'s `callFunction()` (the 4 Deluge functions) — see
  below for which action goes where.

### Client vs. server actions

Most single-record writes — reschedule, delete a followup, cancel a ghost call, post a plain
note — go **directly from the widget** via `ZOHO.CRM.API` (`app/js/crmApi.js`), not through
Deluge. `ZOHO.CRM.API.*` calls execute under the actual logged-in user's own authenticated Zoho
session — un-spoofable, no id the client passes in matters — which is a *stronger* identity
guarantee than a Deluge custom function gets automatically (Deluge only exposes
`zoho.loginuserid`, and that returns an **email**, not a record id — see
`deluge/shared/get_user_id_by_email.dg`'s header for the well-documented Zoho gap this creates).
For actions with no extra business rule beyond "you can only touch your own stuff" — something a
user could already do through the normal CRM UI — going client-direct is simpler and removes a
round-trip, with a client-side "is this still mine?" check as an advisory safety net (the CRM can
have moved since the digest was generated — Important#3 — this is UX, not a security boundary).

What **stays server-side** in `deluge/actions/`: the three actions that change deal ownership or
apply a bulk decision (`digest_dispatch_initial`, `digest_redispatch_b2b_lost`,
`digest_apply_supervision_batch`) — all Sales-Manager-only, enforced by a real profile check via
`deluge/shared/get_user_profile.dg`, not just an absent button — and `digest_send_mention_emails`,
the A7 compensation-email step every note post still needs (sending mail has no client-SDK
equivalent). These four are the only ones `app/js/config.js`'s `ACTION_FUNCTIONS` still lists.

### Test/admin "view as" switcher

`app/js/viewAs.js` lets one designated CRM user, Hassen (`4664241000160830001`, `DEV_VIEWER_ID`),
switch which user's digest his own widget session displays, so every profile's features can be
tested without a separate CRM login per profile. It's display-only on the client. For the 4
server-side actions, write-permission enforcement lives entirely in
`deluge/shared/resolve_actor.dg` — a non-Hassen session can never act as anyone but itself,
regardless of what the client sends. For the client-side actions, "view as" has **no** effect on
who a write executes as — those always run as whoever is really logged in (Zoho's own session),
so previewing another user's digest and clicking e.g. "Reschedule" will correctly fail the
ownership check unless the real session happens to already own that record. Genuine
impersonation for testing only works for the 4 server-side actions. The local `npm start` preview
(no CRM SDK) always shows the view-as control too, since there's no real identity to protect
there; it resolves to the two local sample files (`sample-sales-manager` / `sample-004-sales`)
instead of the CRM registry.

## Conventions carried over from the v24.1 policy doc (`Instructions.txt` in the upload, and
## reflected in `ANALYSIS.md`) — generalized from "Alexis" to "the acting user"

These aren't arbitrary — they're read to avoid regressing behavior the team already validated:
- Never write to a Task/Call whose `Owner.id` isn't the acting user's id — enforced either by the
  client-side "is this still mine?" check (plain actions, see above) or, for the 4 server-side
  actions, re-checked from a resolved server identity, not trusted from the nightly snapshot.
- A8 channel check (Costing thread present vs. absent) is **always** re-queried fresh
  immediately before posting a note, never cached — client-side for plain notes
  (`app/js/actions.js`'s `postNoteWithChannelCheck`), server-side for the two Sales-Manager-only
  actions that still post notes as part of a bigger write (`deluge/actions/post_note_with_channel_check.dg`).
- A7 compensation email fires after every tagging note except when the only tags are the CS
  simples listed in `app/js/config.js` (`TEAM.cs`).
- B2B Lost redispatch never changes the deal owner and never creates a follow-up for the acting
  user (`digest_redispatch_b2b_lost` has no owner-update step, deliberately) — Sales-Manager-
  profile-only, enforced both by the digest envelope never giving another profile this section
  and by a server-side profile guard in the action function itself.
- Reschedule/reopen actions stay reversible client-side (`app/js/actions.js` collapse/undo), a
  carryover of the old B10 rule, minus the copy-to-clipboard step — actions are native now.

## Adding a new profile

1. Write `deluge/collect/digest_collect_<profile>.dg` (see `digest_collect_004_sales.dg` for a
   real example, `digest_collect_stub.dg` for the floor every profile starts from) and add one
   branch to `digest_collect.dg`'s router.
2. If the profile needs Claude-written text, write
   `deluge/generate/digest_build_<profile>_request.dg` + `digest_finish_<profile>.dg` (see the
   004-SALES pair for a real example) — not a single synchronous call; Deluge's `invokeurl` has a
   fixed ~40s timeout that a full profile's worth of note-writing can exceed (see "Why a
   submit/finish split" above), so every real profile's Claude call goes through
   `digest_generate.dg`'s batch submission and `digest_finish_batches.dg`'s poll, same as the
   other two. Add one branch to each of those two files' profile checks, and create the new
   profile's own `Digest_house_rules_<profile>_file_id` org variable (pointing at a WorkDrive
   file, not raw text — see "Deployment checklist" in `deluge/README.md`) — don't reuse another
   profile's. If the profile needs no Claude call at all, it's a stub — see `digest_collect_stub.dg`
   / `digest_generate_stub.dg`, called directly from `digest_generate.dg`'s SUBMIT phase, no
   batching needed. If the profile wants the same live CRM-lookup pattern Sales Manager has (see
   above), reuse the same `Digest_mcp_server_url` / `Digest_mcp_bearer_token` org variables and the
   same `mcp_servers`/`tools` block in that profile's own request-builder — no new MCP server to
   set up, it's already shared, org-wide infrastructure.
3. If the profile needs an action beyond the generic client-side ones already available (post
   note, reschedule, delete, cancel) — e.g. something else that's profile-restricted the way
   dispatch/redispatch/supervision-batch are for Sales Manager — add a new file to
   `deluge/actions/`, gated by its own `getUserProfile(actingUserId) != "<profile>"` check, and
   register it in `ACTION_FUNCTIONS`.
4. If the widget needs a new section *type* (beyond `card-list` / `initial-dispatch` /
   `initial-info` / `supervision` / `b2b-redispatch` / `info-table` / `ghost-table`), add one
   entry to `SECTION_RENDERERS` in `app/js/render.js`. Existing types are reusable as-is — most
   new profiles won't need a new one.
5. No frontend profile-conditional code is needed: the digest JSON's own `sections` array is
   what drives rendering.

## Commands

- Install: `npm install`
- Local preview: `npm start` (serves `app/` over plain HTTP at `http://127.0.0.1:5000`). This is
  a **rendering preview only** — there's no CRM to log into, so the widget always runs in "view
  as" mode locally (see above) and `digestLoader.js` resolves to the local sample files; the
  action buttons will throw a clean, caught "SDK not available" error rather than doing anything
  (verified — no uncaught exceptions from the try/catch itself, though the button's own click
  handler doesn't `.catch()` the returned promise, so the browser console still logs an unhandled
  rejection alongside the on-card error message — a pre-existing, low-priority rough edge, not
  something this pass introduced). Real testing (SDK init, `ZOHO.CRM.API`,
  `ZOHO.CRM.FUNCTIONS.execute`, org variables) requires deploying via the Zoho CLI (`zet`) into
  an actual CRM org.
- There is no build step, bundler, or test suite. `app/app.js` uses native ES module imports
  (`type="module"` in `widget.html`) — no transpilation.
- `plugin-manifest.json` is what the Zoho CLI (`zet`) reads for deployment — it points at
  `app/widget.html` as the widget's entry `src`. Touch it only if the widget's entry file or
  version changes.

## Known open items (see `ANALYSIS.md` §6)

CRM edition (widgets/Connections need Enterprise+) is still open. A7's compensation email is
resolved: it goes through `sendmentionemail`, an already-deployed Deluge Standalone function that
sends from `zoho.adminuserid` and builds its own subject/greeting/link — no per-user Gmail OAuth
Connection needed (`deluge/actions/send_compensation_emails.dg` calls it directly). Everything
else that was open here has since been confirmed live end-to-end: the WorkDrive upload/download
endpoints (`deluge/shared/upload_digest.dg` / `deluge/shared/fetch_workdrive_text.dg` — including
that `attributes.Permalink` is the wrong URL for programmatic fetching, a human-facing web app
route requiring browser sign-in cookies; the real one is the API download endpoint,
`www.zohoapis.com/workdrive/api/v1/download/<resource_id>`, which the widget's own
`ZOHO.CRM.CONNECTION.invoke` needs too — see `deluge/README.md`'s deployment-checklist constraints
list) and the Anthropic Batches API integration (`deluge/generate/digest_generate.dg`'s submission,
`deluge/generate/digest_finish_batches.dg`'s poll/finish, including the results-JSONL corruption
that relay introduces and its reconstruction) — a full submit → batch → poll → finish → WorkDrive
upload → widget fetch has successfully rendered a real user's digest. The poll interval on
`digest_finish_batches.dg`'s Schedule (starting guess: ~15 minutes) should still be tuned to how
long this org's batches actually take once running on a real schedule rather than manual test
runs. Confirmed against a live org (and fixed everywhere they're used):
`zoho.crm.getRecordById("users", userId)` and the bulk `zoho.crm.getRecords("users", ...)` both
return a Map with a `"users"` key holding a List, never the record(s) directly — `deluge/shared/`'s
user lookups all account for this now. Still unconfirmed: whether `zoho.loginuserid` is reliably
populated inside a function invoked via `ZOHO.CRM.FUNCTIONS.execute()` from a widget (flagged in
`deluge/shared/resolve_actor.dg`). Additionally: the 004-SALES house rules
(`Digest_house_rules_004_sales_file_id`) haven't been written yet (only Sales Manager's v24.1 doc
exists), and the 5 remaining profiles have no business rules defined at all — see "Adding a new
profile" above.
