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
│    - Output = structured JSON (note text per deal, heat rating,      │
│      "où ça en est" lines, badge labels) — NOT hand-written HTML     │
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
│    - Compensation email (A7) sent via a Deluge-side Gmail connection │
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

## 4. Data model

New custom module (or a single-record custom module if history isn't needed): **`Digest_Run`**
- `Run_Date`
- `Badge_JSON` — counts/pills for the header
- `Sections_JSON` — one block per section (Initial dispatch, Voie 1/2/3, B2B Lost ×3, Vigilance),
  each item carrying the pre-written note text, target owner id, suggested follow-up date, and
  the deterministic facts ("est-ce que c'est passé" bullets) computed in step 1
- `Status` — draft / delivered / stale (if the nightly job fails, widget can show last-good run
  with a visible staleness banner rather than silently going empty)

## 5. Action flow (native, no copy-paste)

Example — "Dispatcher ce deal →" on an Initial:
1. Widget button already carries the deal id, target AE id, pre-written note (from step 2), and
   channel decision is *recomputed live* at click time (A8 requires a fresh Costing-thread check
   right before posting — this one check can't be pre-computed the night before since the CRM
   may have changed) via one Deluge function call.
2. That Deluge function does, in order: owner change (`updateRecords` + `trigger:["workflow"]`) →
   channel check → `createRecords`/`createNotesModule` → Gmail compensation send (A7, skipped for
   CS-only tags per A2) → returns success/failure to the widget, which collapses the card
   (client-side, matching the current B10 reversible-collapse UX) and decrements the local badge
   count. No LLM call anywhere in this path.
3. Supervision table (D4) "Appliquer mes choix →" batches the same way: one Deluge function call
   carrying the array of per-row decisions, executed server-side in one pass.

## 6. Open items to confirm before scaffolding code

- **Zoho edition**: Widgets and custom Connections (for Gmail OAuth from Deluge) require
  CRM Enterprise or above — please confirm the org's edition.
- **Gmail sending from Deluge**: needs a Zoho CRM *Connection* authorized against Alexis's Gmail
  (OAuth), since Deluge's native `sendmail` won't originate from her real Gmail address the way
  A7 requires. Do you have (or can you create) that Connection, or should this stay on the
  Gmail MCP connector for just the send step?
- **Google Drive pricing lookup (C6)**: still read-only and low-frequency (Gold deals in
  degraded mode) — fine to leave as an occasional external call rather than building it into the
  nightly job, unless you want it folded in too.
- **Custom module creation rights**: `Digest_Run` needs to be created once in Zoho CRM setup
  (or reuse an existing free-form module) — confirm you can create custom modules on this org.
- **Claude API access for the nightly Deluge job**: this needs a real Anthropic API key (server-
  side), separate from your interactive Claude usage, called via Deluge's `invokeurl`.

Once these are confirmed I'll scaffold: the Deluge collector function, the Deluge
LLM-call function (with the cached system prompt extracted from the v24.1 doc), the
`Digest_Run` module definition, and the widget (HTML/CSS/JS + `plugin-manifest.json`) in this
repo.
