# DocShipper Digest — Analysis & Zoho-Native Integration Plan

Analysis of the existing Claude-based "Digest DocShipper" (prompt v24.1 + `digest_2708.html`
sample output) and a plan to move it into Zoho CRM directly, cutting both Zoho API credit
usage and LLM token spend.

## 1. What the current solution actually does

It's a Claude Project/custom assistant, triggered daily at 7:00 AM, connected to Zoho CRM,
Gmail and Google Drive via MCP-style connectors. Every run, from a cold context, it:

1. Re-reads a **632-line instruction document** (the full v24.1 policy: team directory, tag
   rules, note style, triage logic, output format, technical query patterns).
2. Re-derives the CRM state from scratch via **dozens of small, individually-billed API calls**:
   - Tasks/Calls owned by Alexis, batched ~22 `What_Id`s at a time.
   - Per-deal Chat lookups (3 last `MessagesChat`) for every item in scope (30–40+ deals).
   - Per-Initial reads of `Notes` + `Attachments` + dimension fields.
   - A **dichotomic search over `limit {offset},1`** just to get a total count past the 2000-row
     COQL cap (D7).
   - Gmail thread search by DS-number for every operational deal in scope.
3. **Delegates to sub-agents** for the bulky reading (supervision chat threads, Initial notes),
   each of which reloads its own context window.
4. **Free-writes a ~565-line self-contained HTML/CSS/JS dashboard** from scratch — including all
   the interactive JS (clipboard copy with sandboxed-iframe fallback, collapsible cards,
   autosizing textareas, tag-insertion menus) — instead of filling a template.
5. Runs a **Playwright test battery** (badge-sum check, no-scroll check, clipboard-blocked
   simulation, undo-decrements-counter, responsive width, zero JS errors) before calling the
   digest "delivered."
6. On action, the human copies a **pre-written natural-language command** ("Fais…") back into
   the Claude chat, which then re-enters agentic tool-calling to execute it (owner change, note
   post, compensation email) — i.e. every dispatch click costs another LLM round-trip.

## 2. Where the cost actually comes from

These are two different budgets and the current design taxes both:

**Zoho API credits** — dominated by *call count*, not data volume (a COQL call costs the same
whether it returns 1 row or 2000). The current pattern maximizes call count: per-deal chat
lookups instead of batched ones, a binary-search loop just to count Final Quote Sent deals,
Notes/Attachments reads issued per-Initial rather than in bulk, and a full re-query of
everything every run with no caching of yesterday's still-valid state.

**LLM tokens** — dominated by (a) reloading the 632-line static policy every run with no prompt
caching, (b) sub-agents each carrying their own copy of relevant context, (c) the model
hand-authoring ~565 lines of boilerplate HTML/CSS/JS *daily* when that markup never actually
changes structurally, and (d) every user action ("Dispatcher ce deal") re-entering the agent
loop instead of executing a pre-computed action.

## 3. Target architecture (Zoho-native widget, agreed direction)

Three layers, cleanly separated so the LLM is invoked **once a day, one call**, and the widget
itself makes **zero live COQL calls** when Alexis opens it.

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. Nightly Deluge scheduled function  (07:00, native — no MCP hop)   │
│    - Bulk COQL pulls (few, wide queries — not per-deal)              │
│    - Deterministic classification in Deluge code (no LLM):           │
│        owner-id checks, Gold detection, badge math, D1–D8 routing,   │
│        weekday-date rules (B7), stage-closed checks                  │
│    - Writes one JSON payload to a custom module: Digest_Run          │
└─────────────────────────────────────────────────────────────────────┘
                              │ structured JSON (facts only)
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 2. Single cached Claude API call (same nightly job, right after #1)  │
│    - System prompt = static v24.1 house rules, sent as a             │
│      prompt-cached block (cache write once, cache-read pricing on    │
│      every subsequent day the rules don't change)                    │
│    - User content = only the small dynamic JSON from step 1          │
│      (deal facts, chat tails, task/call state) — not the full CRM    │
│    - Sales Manager only: live MCP hop to Zoho's own CRM MCP server   │
│      for a deal's Notes/Attachments/Emails (C2bis), on-demand, not   │
│      pre-fetched — see ../deluge/README.md's deployment checklist    │
│    - Output = structured JSON (note text per deal, heat rating,      │
│      "where it stands" lines, badge labels) — NOT hand-written HTML  │
│    - Result appended into the same Digest_Run record                 │
└─────────────────────────────────────────────────────────────────────┘
                              │ pre-computed data + pre-written notes
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 3. Zoho CRM Widget (static template, built once, versioned in repo)  │
│    - On open: ONE read of today's Digest_Run record. No COQL.        │
│    - Renders the fixed dashboard template with the JSON injected     │
│    - Buttons call Deluge functions directly (ZOHO.CRM.FUNCTIONS)     │
│      → owner change / createRecords MessagesChat / createNotesModule │
│        / delete / reschedule — using the note text already written   │
│        in step 2. No round-trip to an LLM, no copy-paste.            │
│    - Compensation email (A7) sent via sendmentionemail (admin)       │
└─────────────────────────────────────────────────────────────────────┘
```

### Why this cuts both budgets

- **Zoho credits**: the *widget* never calls Zoho's API on open — it reads one already-computed
  record. The nightly collector still needs COQL, but consolidated into a handful of wide
  queries instead of dozens of per-deal ones, and the D7 "count via binary search" is replaced
  by a single `COUNT()`-style COQL aggregate (or, if unsupported on this module, one full
  paginated sweep instead of a search loop — either way, far fewer calls than a dichotomic
  search). Action buttons still cost the normal 1 credit per write, same as today — that part
  is inherent to actually doing the work, not a design flaw.
- **LLM tokens**: one call per day instead of one per run *plus* one per sub-agent *plus* one per
  user action. Prompt caching means the 632-line rulebook is billed at cache-read rates on every
  day after the first. The model is asked for structured note text, not hand-rolled HTML/CSS/JS
  — the markup is a static asset that only changes when *we* edit the template, not something
  regenerated (and re-Playwright-tested) every morning.

## 4. Data model — WorkDrive, not a custom module

Reusing the pattern from the existing "Employee Activity Audit" widget (`Audit_url` org
variable → WorkDrive file → client-side fetch with fallback transports) instead of a custom
CRM module. This avoids needing custom-module creation rights and keeps the widget's read path
identical in shape to code already proven in this org — now generalized to one digest per user
instead of one global digest.

- The nightly Deluge job writes one JSON file per user per day to a fixed WorkDrive folder (e.g.
  `digest_run_2026-08-28_<userId>.json`, user-qualified to avoid collisions) and updates a single
  **`Digest_registry`** CRM org variable — a JSON map `{"<userId>": {"url", "run_date",
  "profile"}, ...}` — after looping over every active user (`Digest_active_users`). This replaces
  the original single-user `Digest_url` string variable.
- JSON shape — a self-describing envelope: `sections` is an ordered list of
  `{key, type, title, accent, data}` (plus `kind`/`cols`/`opts` where a section type needs them),
  where `data` holds **facts + pre-written note text**, never markup. The widget's renderer
  (`app/js/render.js`) walks `sections` through a `type` → renderer registry, so a profile simply
  omits any section it doesn't have — no profile-conditional code in the widget:
  ```json
  {
    "run_date": "2026-08-28",
    "status": "delivered",
    "user_id": "...",
    "profile": "Sales Manager",
    "badge": { "total": 9, "very_grave": false, "pills": [...] },
    "sections": [
      { "key": "initial", "type": "initial-dispatch", "title": "AXIS 1 — INITIAL", "accent": "gold",
        "data": { "groups": [ { "heat": "gold", "deals": [ { "ds": "DS-58854", ... } ] } ] } },
      { "key": "path1", "type": "card-list", "kind": "path1", "title": "PATH 1 — Didn't go through", "accent": "crit",
        "data": [ { "ds": "...", "happened": [...], "proposal": "...", "note": "...", "target_tag": "...", "followup": {...} } ] },
      { "key": "path2", "type": "card-list", "kind": "path2", "title": "PATH 2 — No one else on it", "accent": "warn", "data": [...] },
      { "key": "personal_tasks", "type": "card-list", "kind": "personal", "title": "Personal Tasks", "accent": "info", "data": [...] },
      { "key": "supervision", "type": "supervision", "title": "PATH 3 — Supervision", "accent": "good",
        "data": { "groups_by_referent": [ { "referent": "...", "rows": [...] } ] } },
      { "key": "b2b_lost_redispatch", "type": "b2b-redispatch", "title": "B2B Lost to Redispatch", "accent": "gold",
        "data": [ { "ds": "...", "old_owner": "...", "heat": "hot", "why_lost": "...", "angle": "...", "note": "..." } ] },
      { "key": "b2b_lost_piloted", "type": "info-table", "cols": ["ds","client","ae","item"], "title": "B2B Lost Already Handled", "accent": "gold", "data": [...] },
      { "key": "deals_closed", "type": "ghost-table", "title": "Deals Actually Closed", "accent": "gold", "data": [...] },
      { "key": "vigilance", "type": "card-list", "kind": "vig", "opts": { "noteOnly": true }, "title": "Vigilance", "accent": "neutral", "data": [...] }
    ],
    "method_footer": { "counts": {...}, "anomalies": [...] }
  }
  ```
  A profile like 004-SALES sends a much shorter `sections` list (`personal_tasks`, a read-only
  `initial-info` section, and a note-post-only `b2b_lost_own` card list) — see
  `app/sample-digest-004-sales.json` for a full example, and `../CLAUDE.md`'s "Adding a new
  profile" for how a new profile's collector/generator populates this envelope.
- Widget reads this via the same multi-fallback loader style as `fileLoader.js`
  (`CONNECTION.invoke` → `CONNECTOR.invokeAPI` → `HTTP.get` → `fetch`), parses JSON instead of
  CSV, looks up the logged-in user's own entry in `Digest_registry`, and renders a **template
  driven by the digest's own `sections` list** — zero COQL calls on open.
- If the nightly job fails for a given user, that user's last-good registry entry stays in place
  with `status` still `"delivered"` from its own run date; the widget shows a staleness banner
  when `run_date` isn't today rather than going empty. A failure for one user never affects
  another's entry — the nightly loop updates the registry once after processing everyone.

## 5. Action flow (native, no copy-paste)

Example — "Dispatcher ce deal →" on an Initial:
1. Widget button already carries the deal id, target AE id, pre-written note (from step 2), and
   channel decision is *recomputed live* at click time (A8 requires a fresh Costing-thread check
   right before posting — this one check can't be pre-computed the night before since the CRM
   may have changed) via one Deluge function call.
2. That Deluge function does, in order: owner change (`updateRecords` + `trigger:["workflow"]`) →
   channel check → `createRecords`/`createNotesModule` → `sendmentionemail` compensation send (A7,
   skipped for CS-only tags per A2) → returns success/failure to the widget, which collapses the card
   (client-side, matching the current B10 reversible-collapse UX) and decrements the local badge
   count. No LLM call anywhere in this path.
3. Supervision table (D4) "Appliquer mes choix →" batches the same way: one Deluge function call
   carrying the array of per-row decisions, executed server-side in one pass.

## 6. Open items to confirm before scaffolding code

- **Zoho edition**: Widgets and custom Connections (needed for the WorkDrive Connection) require
  CRM Enterprise or above — please confirm the org's edition.
- ~~**Gmail sending from Deluge**~~ — resolved: A7 compensation sends go through
  `sendmentionemail`, an already-deployed Deluge Standalone function that sends from
  `zoho.adminuserid`, no per-user Gmail OAuth Connection needed. No Gmail dependency remains.
- ~~**Google Drive pricing lookup (C6)**~~ — settled as a non-goal: this deployment never reads
  DocShipper's internal pricing history. Gold-deal estimates stay limited to the public Drewry WCI
  index (house-rules doc §C5) by design, not as an interim gap.
- **Custom module creation rights**: `Digest_Run` needs to be created once in Zoho CRM setup
  (or reuse an existing free-form module) — confirm you can create custom modules on this org.
- **Claude API access for the nightly Deluge job**: this needs a real Anthropic API key (server-
  side), separate from your interactive Claude usage, called via Deluge's `invokeurl`.

Once these are confirmed, the remaining wiring is: creating the `Digest_registry` org variable,
pointing the Deluge jobs at a real Anthropic API key and WorkDrive folder, and connecting the 4
server-side action functions in `deluge/actions/` to the widget's buttons in Zoho CRM's function
list (most action buttons now write directly via `ZOHO.CRM.API` from the widget instead — see
`CLAUDE.md`'s "Client vs. server actions"). The widget scaffold, loader, and Deluge reference
sources are now in this repo (see `CLAUDE.md`).
