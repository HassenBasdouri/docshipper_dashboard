# Deluge reference sources

These `.dg` files are **reference source for Zoho CRM Deluge functions** — Deluge only runs
inside Zoho (Setup → Developer Space → Functions), there's no local runner, so these are kept
here for version control and code review, then pasted into the Zoho function editor.

**One function per file.** Zoho's Developer Space deploys each function as its own unit, and
Deluge functions call each other by name (`<result> = <function_name>(<params>);`, confirmed
pattern — see Zoho's own "Calling Functions within Functions" docs) regardless of which file they
started in — so a file boundary in this repo has no deployment meaning of its own, but matching
it 1:1 to a deployed function keeps the repo honest about what actually gets pasted where. The
four subfolders group them by role:

- **`shared/`** — helpers reused across more than one of the folders below (user lookups, the
  digest envelope builders, the section-merge helper, `fetch_workdrive_text.dg` for reading
  house-rules text stored in WorkDrive since it's too big for a CRM org variable,
  `upload_workdrive_json.dg` for the generic version of that same upload (used to persist
  pending-batch state between `generate/digest_generate.dg` and `generate/digest_finish_batches.dg`
  — see `generate/` below), `delete_workdrive_file.dg` for best-effort delete-by-id cleanup of
  WorkDrive files this pipeline itself uploaded and knows are no longer needed (a superseded
  `digest_run_*.json`, a consumed pending-batch state file, a consumed batch-results relay file —
  see `generate/` below for where each is called; never given a house-rules file's id, so those stay
  untouched), `trim_deal_fields.dg` for cutting a full CRM Deal record down to the ~13 fields this
  pipeline actually uses before it's embedded — often several times over — in the Claude prompt; an
  untrimmed prompt for one Sales Manager hit Anthropic's 200,000-token context limit live at
  283,138 tokens), and `strip_json_fence.dg` for stripping the markdown code fence Claude sometimes
  wraps its JSON output in before parsing it.
- **`collect/`** — nightly step 1: CRM reads + deterministic classification, one router + one
  file per profile's collector.
- **`generate/`** — nightly step 2, split into a SUBMIT phase (`digest_generate.dg`, same schedule
  slot as before) and a FINISH phase (`digest_finish_batches.dg`, its own separate new Schedule)
  — see `generate/` below for why.
- **`actions/`** — the widget-invoked functions that still need to run server-side (see "Client
  vs. server" below) plus their private helpers.

Field/module API names (`Deals`, `What_Id`, `Outgoing_Call_Status`, the user ids in
`../app/js/config.js`, etc.) come straight from the v24.1 policy doc (`../Instructions.txt`)
and were confirmed there via live `getUsers`/COQL checks on 26/08 — reuse them as-is, but
re-verify anything that looks org-specific if the schema has moved on since. Deluge task syntax
throughout (searchRecords/updateRecord/createRecord signatures, the lack of a real
`deleteRecord`/`updateOrgVariable` task, `zoho.loginuserid` returning an email rather than a
record id) was verified against Zoho's own documentation and community threads — see the
per-file TODOs for anything that still needs live-org confirmation.

Every user gets their own digest, gated by their native CRM Profile — see `../CLAUDE.md`'s
"Adding a new profile" section for how the collect/generate split is per-profile.

## Client vs. server: who does the actual CRM write?

Most single-record writes (reschedule, delete a followup, cancel a ghost call, post a plain
note) now happen **directly from the widget** via `ZOHO.CRM.API` (`../app/js/crmApi.js`), not
through a Deluge function. Two reasons:

1. Calling `ZOHO.CRM.API.*` from the widget executes under the actual logged-in user's own
   authenticated Zoho session — Zoho enforces that identity itself, un-spoofable, no id the
   client passes in matters. A Deluge custom function, by contrast, does **not** automatically
   inherit the identity of whoever triggered it via `ZOHO.CRM.FUNCTIONS.execute()` — Deluge only
   exposes `zoho.loginuserid`, and even that returns an **email**, not a record id (a
   long-documented Zoho gap — see `shared/get_user_id_by_email.dg`'s header). So for actions with
   no extra business rule beyond "you can only touch your own stuff" — something a user could
   already do through the normal CRM UI anyway — going client-direct is both simpler and gives a
   *stronger* identity guarantee than routing through Deluge ever did.
2. It cuts a full Deluge round-trip out of every button click that doesn't need one.

What **stays** in `actions/`, server-side: the three actions that change deal ownership or apply
a bulk decision (`digest_dispatch_initial`, `digest_redispatch_b2b_lost`,
`digest_apply_supervision_batch`) — all Sales-Manager-only, enforced by a real profile check in
Deluge (`shared/get_user_profile.dg`), not just an absent button — and
`digest_send_mention_emails`, the compensation-email step every note post still needs (sending
mail has no client-SDK equivalent). See `shared/resolve_actor.dg` for how those four resolve
"who is really acting" despite the `zoho.loginuserid` limitation above.

## Files

- **`collect/digest_collect.dg`** — nightly step 1 router: looks up each user's live CRM Profile
  and calls that profile's collector.
  - **`collect/digest_collect_sales_manager.dg`** — the original Sales Manager (Alexis) logic,
    parameterized by `userId`: bulk COQL pulls (Tasks/Calls, Initial deals, B2B Lost deals,
    supervision candidates), and the *deterministic* classification that doesn't need an LLM
    (owner-id checks, Gold detection, weekday-date math, D1–D8 routing into path1/path2/supervision
    buckets).
  - **`collect/digest_collect_004_sales.dg`** — individual sales rep: own Tasks/Calls, own
    Initial deals (same Gold classification, no dispatch queue), own B2B Lost deals (no
    piloted/redispatch split).
  - **`collect/digest_collect_stub.dg`** — floor for any profile without real rules yet: just the
    common "own Tasks/Calls" bundle.
  - Shared by all three: `shared/collect_own_tasks_calls.dg`, `shared/classify_initial_deals.dg`.
  - Output: one Deluge Map matching the envelope shape in `../ANALYSIS.md` §4, minus note text.
- **`generate/digest_generate.dg`** — nightly step 2, SUBMIT phase, runs right after step 1: loops
  over `Digest_active_users`, calls `digest_collect` per user, and branches by profile. Stub
  profiles finish immediately via `generate/digest_generate_stub.dg` (no Claude call — only the
  common "Personal Tasks" section) and get written straight to `Digest_registry`, same as
  always. Sales Manager / 004-SALES profiles are different: a single synchronous Claude call
  writing a whole Sales Manager's notes was taking ~52s against Deluge's fixed, non-configurable
  ~40s `invokeurl` timeout, confirmed live even after switching to the fastest current model
  (`claude-haiku-4-5-20251001`) and trimming the prompt (`shared/trim_deal_fields.dg`). So instead
  of calling Claude directly, this builds each such user's request
  (`generate/digest_build_sales_manager_request.dg` / `generate/digest_build_004_sales_request.dg`
  — same cached, profile-specific system prompt as before, fetched via
  `shared/fetch_workdrive_text.dg` from the WorkDrive file id in
  `Digest_house_rules_sales_manager_file_id` / `Digest_house_rules_004_sales_file_id`) and adds it
  to ONE shared Anthropic Batches API submission (`POST /v1/messages/batches`) — a batch
  *submission* call is fast regardless of how long generation itself takes, since it doesn't block
  on it. Each batched user's `collected` facts + profile are persisted to WorkDrive
  (`shared/upload_workdrive_json.dg`) since Deluge functions don't share memory across separate
  scheduled runs; only the resulting `{batch_id, state_file_id}` — both short strings — goes into
  the new `Digest_pending_batch` org variable.
- **`generate/digest_finish_batches.dg`** — nightly step 2, FINISH phase, its own separate
  Schedule (short recurring interval, e.g. every ~15 minutes — see "Deployment checklist" below).
  Polls whether the pending batch has finished; if not, exits and retries next poll. Once
  Anthropic reports it `"ended"`, fetches the results, downloads the state
  `digest_generate.dg` persisted, and for each successful result calls
  `generate/digest_finish_sales_manager.dg` / `generate/digest_finish_004_sales.dg` — the second
  half of what used to be one function per profile, taking Claude's already-generated text instead
  of calling Claude itself, and doing the same merge (`shared/merge_section.dg`,
  `shared/group_deals_by_heat.dg`) + envelope-building it always did. Both halves upload via
  `shared/upload_digest.dg` (filename `digest_run_<date>_<userId>.json`, user-qualified) and
  return the entry that gets stored in `Digest_registry`; `digest_finish_batches.dg` clears
  `Digest_pending_batch` once done so the next poll doesn't reprocess the same batch. Both
  `digest_generate.dg` (stub-profile branch) and `digest_finish_batches.dg` also self-clean
  WorkDrive as they go: right before overwriting a user's `Digest_registry` entry, the file the old
  entry pointed at is deleted (`shared/delete_workdrive_file.dg`) unless it's the same file a
  same-day re-run just overwrote in place; and once a batch is fully processed,
  `digest_finish_batches.dg` deletes the pending-batch state file and the batch-results relay file
  it downloaded, since neither is ever referenced again after that point. No WorkDrive folder
  listing is involved — every delete is by a specific `resource_id` the pipeline just finished
  using, so the house-rules files (whose ids never flow through this path) are never at risk.
- **`actions/`** — the four functions that still run server-side (see "Client vs. server" above),
  plus their private helpers: `post_note_with_channel_check.dg`, `send_compensation_emails.dg`
  (calls the already-deployed `sendmentionemail` function for the actual send),
  `create_followup.dg`, `apply_supervision_decision.dg`,
  `extract_tags.dg` (@mention -> {first_name, email, is_cs_simple} resolution against the live
  CRM `"users"` module, so new hires need no repo edit — only the small CS-exemption email list
  inside it mirrors `../app/js/config.js`'s TEAM.cs).

## Deployment checklist

1. Create the `Digest_registry` org variable (JSON map, replaces the old single-user
   `Digest_url`), the `Digest_active_users` org variable (hand-maintained JSON array
   `[{"id": "...", "name": "..."}]` of everyone who should get a nightly digest), and the
   `Digest_pending_batch` org variable (start it as `{}`) that `generate/digest_generate.dg` /
   `generate/digest_finish_batches.dg` use to hand off the in-flight Anthropic batch between the
   submit and finish phases — all under Setup → Developer Space → Variables.
2. For each *real* (non-stub) profile, upload that profile's house-rules text as a `.txt` file to
   WorkDrive (e.g. the existing v24.1 doc for Sales Manager) and create a
   `Digest_house_rules_<profile>_file_id` org variable holding that WorkDrive file's id — **not**
   the raw text: CRM org variables have a real size ceiling well below a several-hundred-line
   policy doc, hit live when this was first tried as plain text. `shared/fetch_workdrive_text.dg`
   downloads it fresh on every `generate/digest_build_<profile>_request.dg` call. Stub profiles
   need none.
3. Paste every file under `shared/`, `collect/`, `generate/`, and `actions/` in as its own
   **Standalone** function — file name is the intended function name throughout, and every
   function signature in this repo is written as `string standalone.<name>(...)` to match. This
   isn't limited to the widget-invoked functions: **every** function here is Standalone, because
   that's the only category general enough to be called by name from another custom function
   (`shared/`, and most of `collect/`/`generate/`/`actions/`'s private helpers), from a Schedule
   (`generate/digest_generate.dg`, `generate/digest_finish_batches.dg`), or via
   `ZOHO.CRM.API.FUNCTIONS.execute()` from the widget (the four in `## Files` below that must
   match `ACTION_FUNCTIONS` in `../app/js/config.js`) — none of these are bound to a workflow
   rule, related-list button, or blueprint transition, which are the only cases that would need a
   different category. Fourteen constraints were confirmed the hard way against a live org, in this
   order, and every file in this repo already follows all fourteen:
     - A deploy of `actions/apply_supervision_decision.dg` failed with "Invalid return Type Map.
       Category standalone returns string" — Standalone functions can only declare return type
       `string`, full stop, not `void`/`Map`/`List`/etc. Every function here that logically
       produces a `Map`/`List` therefore returns it JSON-stringified, and every call site
       immediately parses the result back with `.toMap()`/`.toJSONList()` so nothing past that
       one line changes shape; a function with no real return value returns `""`.
     - A deploy then failed with "Invalid Argument Type List" — Standalone functions also only
       accept `string`/`int`/`date`/`float`/`bool`/`map` as **argument** types, not `List` or a
       generic `Object`. Any function that logically takes a List (or, in `make_section.dg`'s
       case, a `data` param that's sometimes a Map and sometimes a List) takes a JSON string
       instead (`fooJson`) and parses it internally with `.toJSONList()`; callers pass a
       JSON-stringified version of whatever List/value they have. `make_section.dg` additionally
       takes a `dataType` ("map"/"list") discriminator so it knows how to parse `dataJson` back.
     - A deploy then failed with "Not able to find 'toJSON' function" — `.toJSON()` isn't a real
       Deluge method on Map/List, despite reading as the obvious counterpart to `.toMap()`/
       `.toJSONList()`. The real Map/List -> JSON-string conversion is `.toString()` (this is why
       `requestBody.toString()` already worked in the two Anthropic `invokeurl` calls before this
       was caught elsewhere). Every JSON-stringification in this repo is `.toString()`, never
       `.toJSON()`.
     - Calling one Standalone function from inside another only actually resolves at runtime when
       called through its qualified name, `standalone.<name>(...)` — a bare `<name>(...)` call
       deploys without error but doesn't reach the function. Every call from one function in this
       repo into another is written `standalone.<name>(...)`, including calls into a function
       defined in the same file.
     - A deploy failed with "? is not supported in Deluge" — no ternary/`?:` conditional
       expression. Every spot that would otherwise use one (a "heat" flag, a `dataType` branch, a
       null-guarded JSON-encode) is instead an explicit `if { } else { }` assigning into a local
       variable before it's used.
     - A live execution failed with "The task has been terminated since the API call is taking too
       long to respond" — `invokeurl` has a fixed, non-configurable timeout of roughly 40 seconds
       on this runtime (a `read_timeout` override key was tried and rejected at deploy: "no viable
       alternative at input"). A single synchronous Claude call generating a whole Sales Manager's
       notes was measured at ~52 seconds even on the fastest current model
       (`claude-haiku-4-5-20251001`) with a trimmed prompt, so `generate/digest_generate.dg` no
       longer calls Claude directly — it submits every batchable user's request to Anthropic's
       Batches API (a fast, non-blocking submission call) and `generate/digest_finish_batches.dg`,
       on its own separate Schedule, polls for completion later. See the `generate/` bullet under
       `## Files` above for the full submit/finish split.
     - `zoho.workdrive.uploadFile`'s real response shape, confirmed live:
       `{"data":[{"attributes":{"resource_id":..., "Permalink":..., "FileName":..., ...}, "type":
       "files"}]}` — a `data` array, not a flat object, and the permalink field is capitalized
       `"Permalink"`. `shared/upload_digest.dg`'s original flat, lowercase `"permalink"` guess was
       never actually live-confirmed despite an earlier comment there claiming it was;
       `shared/upload_workdrive_json.dg` needed the same `data[0].attributes.resource_id` fix.
     - A `POST /v1/messages/batches` result's `results_url` serves newline-delimited JSON with
       `Content-Disposition: attachment` — `invokeurl` cannot extract this as text directly (both
       a plain call and `detailed:true` came back without the real body; `detailed:true`'s
       `responseText` instead echoed a fragment of the `Content-Disposition` header). Confirmed
       workaround: `invokeurl`'s plain (non-`detailed`) return value for a response like this IS a
       real Deluge File object with the correct bytes — `zoho.workdrive.uploadFile` accepts it
       directly (no `.toFile()`, which converts a String to a File — this is already one), and
       relaying through WorkDrive (upload, then `shared/fetch_workdrive_text.dg` to read it back)
       recovers the real content. See `generate/digest_finish_batches.dg` for the full relay.
     - WorkDrive's download endpoint serves a file back with `content-type:
       application/x-unknown` when its filename has an extension WorkDrive doesn't recognize
       (e.g. `.jsonl`) — `invokeurl` cannot expose that as text either (same symptom as the
       Batches results problem above: plain call empty, `detailed:true`'s `responseText` just the
       filename; a `for each` iteration attempt confirmed `fileResp` genuinely is a Deluge File
       object, but iteration is CSV-only — `"'.csv file formats are only supported to
       iterate.'"`). Fix: upload with a `.txt` filename instead (`shared/upload_digest.dg`,
       `shared/upload_workdrive_json.dg`, and every WorkDrive upload in `generate/digest_generate.dg`
       / `generate/digest_finish_batches.dg` do this now, regardless of the content's real shape),
       so WorkDrive serves it back as `text/plain`, which `invokeurl` exposes correctly.
       `.json` was also tried for content that's genuinely one valid JSON object (the pending-batch
       state) since `application/json` is a content-type `invokeurl` already auto-parses into a
       Map elsewhere in this repo — but that round-trip (auto-parse, `shared/fetch_workdrive_text.dg`'s
       own `.toString()` reserializing it, the caller's `.toMap()` re-parsing it) failed live with
       "Invalid JSON Format String", so every WorkDrive text upload in this repo now uses `.txt`
       uniformly rather than depending on that auto-parse path for some files and not others.
     - Claude's raw text output sometimes wraps its JSON in a markdown code fence
       (`` ```json\n{...}\n``` ``) even though the prompt explicitly asks for "ONLY a JSON object,
       with no surrounding text" — confirmed live: this broke `writtenText.toMap()` in
       `generate/digest_finish_sales_manager.dg` / `digest_finish_004_sales.dg` with "Invalid JSON
       Format String". Unrelated to any of the WorkDrive/`invokeurl` findings above — this would
       have hit the original single-call design too. Fixed with `shared/strip_json_fence.dg`,
       called before every `written = ....toMap()` in both `digest_finish_<profile>.dg` files (and
       needed in any future profile's, per "Adding a new profile" in `../CLAUDE.md`).
     - The `.txt`-relayed batch results (previous bullet) come back with a real, separate
       corruption on top of the content-type issue: JSON escape sequences INSIDE string values
       (the "text" field's own `\n`'s) come back as literal raw newline bytes, splitting what
       should be one JSON object per result into hundreds of fragments — confirmed against
       Anthropic's own docs, which show plain, standard single-line-per-result JSONL with no such
       corruption at the source, so this is entirely introduced somewhere in the WorkDrive/Deluge
       round trip (root cause still unconfirmed). A `.csv`-extension + `for each` iteration
       alternative was tried and also failed (fragmented into 2 nonsensical pieces — Deluge's CSV
       parser doing something opaque with JSON's quotes/commas). Fixed in
       `generate/digest_finish_batches.dg` by reconstructing record boundaries from the literal
       anchor `{"custom_id":"` (unaffected by the corruption, since it's outer structure, not
       inside the corrupted `"text"` field) via `.toList()` on that literal delimiter, then
       collapsing any remaining raw newlines/CRs within each reconstructed chunk to a space rather
       than trying to re-escape them — a real but acceptable cosmetic cost (Claude's note text
       loses its line breaks, read as one paragraph with spaces instead).
     - Deluge's regex engine has repeatedly behaved unexpectedly this session: it rejected an
       escaped `"\{"` as "not a valid regular expression" (worked around above by avoiding regex
       for that split entirely), and separately, `shared/strip_json_fence.dg`'s original
       `^```[a-zA-Z]*\n?` / `` ```\s*$ `` leading/trailing-anchor patterns matched nothing live
       (cleaned output came back the exact same length as the input, confirmed via an added debug
       log) despite looking like standard regex. Fixed by dropping regex for that function
       entirely — find the first `"{"` and the last `"}"` via `.indexOf()`/`.lastIndexOf()` and
       extract that substring via `.subText()` instead.
     - `zoho.workdrive.uploadFile`'s `attributes.Permalink` field looked like the right URL to
       store for later download (and is genuinely correct for a human to click and view the file
       in WorkDrive's own UI), but it's the wrong one for programmatic fetching — confirmed live:
       the widget's `ZOHO.CRM.CONNECTION.invoke("workdrive_connection", ...)` call against a
       `Permalink` URL got redirected to Zoho's own sign-in page HTML, even though that call is
       genuinely OAuth-authenticated via the Connection. `Permalink` (`workdrive.zoho.com/file/
       <id>`) is a human-facing web app route requiring an interactive browser session with
       sign-in cookies; no API/OAuth token substitutes for that. Fixed in `shared/upload_digest.dg`
       by storing the WorkDrive API download endpoint instead
       (`www.zohoapis.com/workdrive/api/v1/download/<resource_id>`, built from
       `attributes.resource_id`) — the same endpoint `shared/fetch_workdrive_text.dg` already uses
       successfully server-side. Also confirmed live in the same investigation:
       `uploadResp.get("data")` is a bare object `{"attributes":..., "type":"files"}` for a
       brand-new upload but a one-element array `[{"attributes":..., "type":"files"}]` when
       overwriting an existing same-named file — Deluge's `Map.get(0)` on a bare Map happens to
       fall back to returning the Map itself (undocumented, just observed), so
       `.get("data").get(0).get("attributes")` works for both shapes without extra branching.
     - `app/js/digestLoader.js`'s `extractConnectionText` needed the same kind of fix as the
       Deluge side: `ZOHO.CRM.CONNECTION.invoke`'s response nests the actual downstream result
       under `details`, and for a WorkDrive JSON file download, `details` IS the file's content
       already parsed into a plain JS object by the SDK — not wrapped under any of
       `response_body`/`body`/`content`. Added a last-resort `JSON.stringify(resp)` fallback for
       when `resp` is a plain object matching none of those known wrapper shapes, confirmed live to
       fix the client-side `"Unexpected end of JSON input"` this caused. The other two client-side
       transports were confirmed unusable in the same pass: `ZOHO.CRM.CONNECTOR.invokeAPI` throws
       an SDK-internal `TypeError: Cannot read properties of undefined (reading 'FILE')` for this
       call shape, and `ZOHO.CRM.HTTP.get` has no WorkDrive-specific auth at all (returns Zoho's
       sign-in page, same as an unauthenticated bare `fetch()`) — `ZOHO.CRM.CONNECTION.invoke` is
       the only one of the three that actually works for this.
     - `shared/delete_workdrive_file.dg`'s first guess, a plain `invokeurl` `DELETE` to
       `/api/v1/files/<id>`, was rejected live with 415 (Unsupported Media Type) — WorkDrive
       doesn't delete a file that way. The confirmed approach, per WorkDrive's own API docs: `PATCH`
       to the same URL with a JSON:API body (`{"data": {"attributes": {"status": "61"}, "type":
       "files"}}`) and an `Accept: application/vnd.api+json` header — status `"61"` moves the file
       to WorkDrive's trash rather than purging it outright.
   Schedule `generate/digest_generate.dg` daily ~07:00 (matching the digest's current cadence; it
   calls everything else by name) AND `generate/digest_finish_batches.dg` on its own separate,
   short recurring interval — start with every ~15 minutes and adjust once you've observed how
   long this org's batches actually take to complete.
4. `shared/resolve_actor.dg`'s `HASSEN_EMAIL` is already filled in with the test/admin viewer's
   real Zoho login email (the counterpart to `DEV_VIEWER_ID` in `../app/js/viewAs.js`, which
   identifies him by CRM record id client-side) — only revisit it if that login email changes.
5. Set up: an Anthropic API key (Connections or a secure custom variable) and a WorkDrive
   destination folder + upload credentials. The A7 compensation email needs no separate setup
   here — it goes through `sendmentionemail`, an already-deployed Deluge Standalone function
   (admin-account sender), called directly from `actions/send_compensation_emails.dg`.
6. For the Sales Manager profile's live Notes/Attachments/Emails lookups (house-rules doc C2bis):
   at `mcp.zoho.com`, open the Zoho CRM integration's **Data Operations** MCP server (check its
   tool catalog actually covers a Deal's related Notes/Attachments/Emails — if not, check the
   other three categories, Data Insights/Module Customization/Workflow Automation, before
   concluding it isn't available). Set the authorization mode to **"Authorization via
   Connections"** — *not* "Authorization on Demand," which expects an interactive per-user login
   that a headless nightly Deluge call can never do. Generate the server URL (treat it like a
   password — Zoho embeds the credential in the URL itself) and create the
   `Digest_mcp_server_url` org variable holding it. If Zoho's console also issues a *separate*
   bearer/access token alongside the URL, create `Digest_mcp_bearer_token` too — otherwise leave
   it unset; `generate/digest_build_sales_manager_request.dg` only sends it when non-empty. No
   server of ours to host, no separate Zoho OAuth app to register.
7. Adding a new profile later? See `../CLAUDE.md`'s "Adding a new profile" section — no changes
   needed to this deployment checklist beyond adding that profile's files/org variable. A new
   *real* (non-stub) profile that needs its own Claude call should follow the same
   build-request/finish-<profile> split as Sales Manager and 004-SALES, not a single synchronous
   call, given the confirmed `invokeurl` timeout above.
