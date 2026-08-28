# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## What this is

A Zoho CRM widget rendering Alexis M.'s daily pipeline digest (see `ANALYSIS.md` for the full
analysis this repo is based on — read it first if you're new here). It replaces a previous
design where a Claude Project agent re-derived everything from a live CRM/Gmail/Drive
conversation every morning; that pattern burned both Zoho API credits (dozens of small
per-deal COQL calls) and LLM tokens (a 632-line policy doc reloaded every run, sub-agents,
~565 lines of hand-written HTML/CSS/JS regenerated daily). This repo's design confines the
expensive parts to **one nightly batch job outside the widget** and makes the widget itself a
pure, static-template renderer that reads one pre-computed JSON file.

## Architecture

```
Deluge (nightly, ~07:00)                     Zoho CRM Widget (opens instantly, no COQL)
┌────────────────────────┐   JSON facts   ┌─────────────────────────┐
│ digest_collect.dg       │ ─────────────▶ │ digest_generate.dg       │
│ bulk COQL + deterministic│                │ ONE cached Claude call   │
│ classification (D1-D8)   │                │ writes note text/heat/   │
└────────────────────────┘                │ "où ça en est" lines     │
                                            └────────────┬─────────────┘
                                                          │ uploads JSON
                                                          ▼
                                                    WorkDrive file
                                                  (Digest_url org var)
                                                          │ one fetch on open
                                                          ▼
                                            app/widget.html + app.js
                                            renders fixed template,
                                            buttons call digest_actions.dg
```

- **`deluge/digest_collect.dg`** — all the CRM reading (bulk, few calls) and every decision
  that doesn't need judgment (owner checks, Gold routing, D1-D8 bucketing, weekday dates).
- **`deluge/digest_generate.dg`** — the single LLM call of the day. Static house-rules system
  prompt is cache-controlled (`cache_control: ephemeral`); only the small daily-facts JSON is
  uncached. Output is structured JSON note text, not HTML. Uploads the final digest JSON to
  WorkDrive and points the `Digest_url` org variable at it.
- **`deluge/digest_actions.dg`** — one Deluge Custom Function per widget button. Each does the
  actual CRM write (owner change, note post with a fresh A8 channel check, reschedule, delete,
  A7 compensation email) with no LLM call — the note text already arrived pre-written from the
  night before, riding along in the button's params.
- **`app/`** — the widget itself. `app.js` is the entry point; `app/js/config.js` holds the
  team directory/module names/action-function names (the one file to touch when the org's
  directory changes); `app/js/digestLoader.js` fetches the WorkDrive JSON with the same
  fallback-transport ladder as this org's existing Employee Activity Audit widget's
  `fileLoader.js`; `app/js/render.js` is display-only (zero business logic — all decisions
  already happened in Deluge); `app/js/actions.js` wires buttons to `zohoApi.js`'s
  `callFunction()`, which calls the Deluge functions in `digest_actions.dg`.

## Conventions carried over from the v24.1 policy doc (`Instructions.txt` in the upload, and
## reflected in `ANALYSIS.md`)

These aren't arbitrary — they're read to avoid regressing behavior the team already validated:
- Never write to a Task/Call whose `Owner.id` isn't Alexis's (`4664241000189490004`) —
  re-checked server-side on every write, not trusted from the nightly snapshot.
- A8 channel check (Costing thread present vs. absent) is **always** re-queried fresh
  immediately before posting a note, never cached.
- A7 compensation email fires after every tagging note except when the only tags are the CS
  simples listed in `app/js/config.js` (`TEAM.cs`).
- B2B Lost redispatch never changes the deal owner and never creates a follow-up for Alexis
  (`digest_redispatch_b2b_lost` in `digest_actions.dg` has no owner-update step, deliberately).
- Reschedule/reopen actions stay reversible client-side (`app/js/actions.js` collapse/undo), a
  carryover of the old B10 rule, minus the copy-to-clipboard step — actions are native now.

## Commands

- Install: `npm install`
- Local preview: `npm start` (serves `app/` over plain HTTP at `http://127.0.0.1:5000`). This
  is a **rendering preview only** — the ZOHO SDK fails to init outside CRM, so
  `digestLoader.js` falls back to `app/sample-digest.json` and none of the action buttons will
  actually call Deluge. Real testing (SDK init, `ZOHO.CRM.FUNCTIONS.execute`, org variables)
  requires deploying via the Zoho CLI (`zet`) into an actual CRM org.
- There is no build step, bundler, or test suite. `app/app.js` uses native ES module imports
  (`type="module"` in `widget.html`) — no transpilation.

## Known open items (see `ANALYSIS.md` §6)

CRM edition (widgets/Connections need Enterprise+), a Gmail OAuth Connection for A7 sends
(Deluge's native `sendmail` can't originate from Alexis's real Gmail address), the WorkDrive
upload endpoint/connection specifics, and a server-side Anthropic API key — all marked `TODO`
inline in the `deluge/*.dg` files where they're needed.
