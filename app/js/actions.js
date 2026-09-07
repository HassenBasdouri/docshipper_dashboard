// Native action layer. Two paths, chosen per action:
//
//  - Plain per-owner actions (reschedule, delete followup, cancel ghost call, plain note post)
//    write DIRECTLY via ZOHO.CRM.API (see crmApi.js) — that executes under the real logged-in
//    user's own Zoho session, which Zoho itself authenticates; there's no server round-trip and
//    no custom identity-tracking needed for these, since a user can already do the equivalent
//    through the normal CRM UI. A lightweight client-side "is this still mine?" check guards
//    against the CRM having moved since the digest was generated (Important#3) — advisory, not
//    a security boundary, same as any other client-side check.
//  - Sales-Manager-only actions (dispatch, B2B Lost redispatch, supervision batch — all change
//    deal ownership or apply a bulk decision) still call a Deluge Standalone function
//    (deluge/actions/), where a real server-side profile gate enforces the restriction. See
//    ../../CLAUDE.md for the full rationale.
//
// No LLM call happens at click time in either path; the note text was already written by the
// nightly job and travels in the digest JSON to the button's dataset. This replaces the old
// "copy consigne → paste into Claude chat" loop (B10 in the v24.1 spec) with a direct call + the
// same reversible collapse/undo UX.
import { ACTION_FUNCTIONS } from "./config.js";
import { callFunction } from "./zohoApi.js";
import * as crm from "./crmApi.js";

// The real logged-in user's own id (never the view-as selection) — used only for the
// client-side "is this still mine?" advisory check below. Set once from app.js.
let currentUserId = null;
export function setCurrentUser(id) {
  currentUserId = id || null;
}

// Set only when the widget's own logged-in user is the test/admin viewer (Hassen) AND he's
// actively previewing someone else's digest — see app/js/viewAs.js. Every other session leaves
// this null. Only meaningful for the Deluge-routed actions below — Deluge ignores it unless the
// real, server-verified caller is that same viewer id (deluge/shared/resolve_actor.dg). It has
// no effect on the client-side actions: those always execute as whoever is really logged in,
// regardless of which digest is being previewed (see ../../CLAUDE.md's view-as section).
let viewAsUserId = null;
export function setViewAsUser(id) {
  viewAsUserId = id || null;
}

// E6 — "cleared deals" counter. Incremented on every applied follow-up action (including each
// supervision row applied), decremented on undo. Never touched by dispatch, B2B redispatch,
// or a plain dismiss.
export const counters = { cleared: 0, base: 0 };

export function setBadgeBase(n) {
  counters.base = n;
  counters.cleared = 0;
  renderRemainingBadge();
}

function renderRemainingBadge() {
  const el = document.getElementById("badge-remaining");
  if (el) el.textContent = String(Math.max(0, counters.base - counters.cleared));
}

// --- Deluge-routed: Sales-Manager-only actions ---

async function runDelugeAction(cardEl, { functionName, params, collapseLabel, countsTowardCleared }) {
  setCardBusy(cardEl, true);
  try {
    const callParams = viewAsUserId ? { ...params, viewAsUserId } : params;
    const result = await callFunction(functionName, callParams);
    collapseCard(cardEl, collapseLabel, () => uncollapseCard(cardEl, countsTowardCleared), countsTowardCleared);
    return result;
  } catch (err) {
    setCardBusy(cardEl, false);
    showCardError(cardEl, err.message || String(err));
    throw err;
  }
}

export function dispatchInitial(cardEl, { dealId, aeId, note, followup }) {
  return runDelugeAction(cardEl, {
    functionName: ACTION_FUNCTIONS.dispatchInitial,
    params: { dealId, aeId, note, followup },
    collapseLabel: "Dispatched →",
    countsTowardCleared: false, // B2 / E6: dispatch never counts as "cleared"
  });
}

export function redispatchB2bLost(cardEl, { dealId, aeId, note }) {
  return runDelugeAction(cardEl, {
    functionName: ACTION_FUNCTIONS.redispatchB2bLost,
    params: { dealId, aeId, note },
    collapseLabel: "Re-dispatched →",
    countsTowardCleared: false, // D5: never touches E6, no suivi created for the acting user
  });
}

export function applySupervisionBatch(tableEl, decisions) {
  return runDelugeAction(tableEl, {
    functionName: ACTION_FUNCTIONS.applySupervisionBatch,
    // Deluge's digest_apply_supervision_batch declares `decisions` as a String, not a List —
    // Standalone functions only accept string/int/date/float/bool/map as argument types (a live
    // "Invalid Argument Type List" error confirmed this) — so it's pre-stringified here rather
    // than sent as a raw array.
    params: { decisions: JSON.stringify(decisions) },
    collapseLabel: `${decisions.length} rows applied`,
    countsTowardCleared: true,
  });
}

// --- Client-side (ZOHO.CRM.API): plain per-owner actions ---

async function runClientAction(cardEl, { checkModule, checkRecordId, write, collapseLabel, countsTowardCleared }) {
  setCardBusy(cardEl, true);
  try {
    if (checkModule && checkRecordId) {
      const ownerId = await crm.getRecordOwnerId(checkModule, checkRecordId);
      if (!currentUserId || ownerId !== currentUserId) {
        throw new Error("This item is no longer yours — the CRM has changed since the digest.");
      }
    }
    const result = await write();
    collapseCard(cardEl, collapseLabel, () => uncollapseCard(cardEl, countsTowardCleared), countsTowardCleared);
    return result;
  } catch (err) {
    setCardBusy(cardEl, false);
    showCardError(cardEl, err.message || String(err));
    throw err;
  }
}

export function rescheduleItem(cardEl, { recordId, module, newDate }) {
  return runClientAction(cardEl, {
    checkModule: module,
    checkRecordId: recordId,
    write: () => {
      const data =
        module === "Calls"
          ? { Call_Start_Time: `${newDate}T00:00:00+07:00`, Outgoing_Call_Status: "Scheduled" } // F. — without this it stays "Overdue"
          : { Due_Date: newDate };
      return crm.updateRecord(module, recordId, data);
    },
    collapseLabel: `Rescheduled to ${newDate}`,
    countsTowardCleared: true,
  });
}

export function deleteFollowup(cardEl, { recordId, module, reason }) {
  // B9 — deletion always carries an explicit reason; the widget already required one before
  // calling this (see render.js's prompt()). There's no server-side audit log for it now that
  // this write is client-direct — `reason` is kept in the signature for that UI gate, not logged.
  return runClientAction(cardEl, {
    checkModule: module,
    checkRecordId: recordId,
    write: () => crm.deleteRecord(module, recordId),
    collapseLabel: "Deleted",
    countsTowardCleared: true,
  });
}

export function cancelGhostCall(rowEl, { recordId }) {
  return runClientAction(rowEl, {
    checkModule: "Calls",
    checkRecordId: recordId,
    write: () => crm.deleteRecord("Calls", recordId),
    collapseLabel: "Call cancelled",
    countsTowardCleared: false,
  });
}

// postFollowupNote is a hybrid: the note WRITE happens client-side (channel check + insert),
// but the A7 compensation email has no client-SDK equivalent, so it still goes through a small
// Deluge function afterward — see deluge/actions/digest_send_mention_emails.dg. The email step
// is best-effort: if it fails, the note is still posted, so we don't fail the whole action over
// it, just log a console warning.
export async function postFollowupNote(cardEl, { dealId, note, targetTag: _targetTag }) {
  setCardBusy(cardEl, true);
  try {
    await postNoteWithChannelCheck(dealId, note);
    try {
      await callFunction(ACTION_FUNCTIONS.sendMentionEmails, viewAsUserId ? { dealId, note, viewAsUserId } : { dealId, note });
    } catch (emailErr) {
      console.warn("Compensation email step failed (note was still posted):", emailErr);
    }
    collapseCard(cardEl, "Note posted", () => uncollapseCard(cardEl, true), true);
  } catch (err) {
    setCardBusy(cardEl, false);
    showCardError(cardEl, err.message || String(err));
    throw err;
  }
}

// A8 — channel decision, re-checked fresh on every call (never trust the nightly job's read).
// Mirrors deluge/actions/post_note_with_channel_check.dg's logic, now client-side for the plain
// note-post case (see that file's header comment for why the two Sales-Manager-only actions
// still do this server-side instead).
async function postNoteWithChannelCheck(dealId, note) {
  const chats = await crm.searchRecord("Chats", "criteria", `(Deals_Chat:equals:${dealId})and(Name:equals:Costing)`);
  if (chats.length > 0) {
    const thread = chats[0];
    const deal = await crm.getRecord("Deals", dealId);
    await crm.insertRecord("MessagesChat", {
      Name: `Parent Message-${thread.id}-${deal.Deal_Name}`,
      Title_Text: "DISPATCH — note for the AE",
      Chats: { id: thread.id },
      Message_Text: note.replace(/\n/g, "<br>"),
    });
  } else {
    await crm.addNotes("Deals", dealId, "DISPATCH — note for the AE", note);
  }
}

// --- reversible collapse (B10, minus the clipboard step — actions are native now) ---

function setCardBusy(cardEl, busy) {
  cardEl.classList.toggle("is-busy", busy);
  cardEl.querySelectorAll("button").forEach((b) => (b.disabled = busy));
}

function showCardError(cardEl, message) {
  let box = cardEl.querySelector(".action-error");
  if (!box) {
    box = document.createElement("div");
    box.className = "action-error";
    cardEl.appendChild(box);
  }
  box.textContent = `⚠ ${message}`;
}

function collapseCard(cardEl, labelHtml, onReopen, countsTowardCleared) {
  cardEl.style.display = "none";
  const strip = document.createElement("div");
  strip.className = "collapse-strip";
  strip.__card = cardEl;
  strip.innerHTML = `<span>${labelHtml}</span> <button type="button" class="reopen-btn">↩ Reopen</button>`;
  cardEl.parentNode.insertBefore(strip, cardEl);
  cardEl.dataset.counted = countsTowardCleared ? "1" : "";
  if (countsTowardCleared) {
    counters.cleared += 1;
    renderRemainingBadge();
  }
  strip.querySelector(".reopen-btn").addEventListener("click", () => {
    strip.remove();
    cardEl.style.display = "";
    setCardBusy(cardEl, false);
    if (cardEl.dataset.counted === "1") {
      counters.cleared = Math.max(0, counters.cleared - 1);
      renderRemainingBadge();
    }
    onReopen();
  });
}

function uncollapseCard(_cardEl, _countsTowardCleared) {
  // no-op hook, kept for symmetry with the reopen handler above
}

// E7 — dismiss: replies-free, reversible, never touches E6.
export function dismissCard(cardEl) {
  collapseCard(cardEl, "Dismissed", () => {}, false);
}
