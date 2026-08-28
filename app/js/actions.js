// Native action layer: every button click here ends in ONE Deluge function call
// (deluge/digest_actions.dg) that does the actual CRM write server-side — owner change,
// note post, channel check (A8), compensation email (A7), reschedule, delete. No LLM call
// happens at click time; the note text was already written by the nightly job and travels
// in the digest JSON to the button's dataset.
//
// This replaces the old "copy consigne → paste into Claude chat" loop (B10 in the v24.1
// spec) with a direct call + the same reversible collapse/undo UX.
import { ACTION_FUNCTIONS } from "./config.js";
import { callFunction } from "./zohoApi.js";

// Set only when the widget's own logged-in user is the test/admin viewer (Hassen) AND he's
// actively previewing someone else's digest — see app/js/viewAs.js. Every other session leaves
// this null, and Deluge ignores it unless the real, server-verified caller is that same viewer
// id (deluge/digest_actions.dg) — so this can never let one ordinary user act as another.
let viewAsUserId = null;
export function setViewAsUser(id) {
  viewAsUserId = id || null;
}

// E6 — "deals écumés" counter. Incremented on every applied follow-up action (including each
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

async function runAction(cardEl, { functionName, params, collapseLabel, countsTowardCleared }) {
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
  return runAction(cardEl, {
    functionName: ACTION_FUNCTIONS.dispatchInitial,
    params: { dealId, aeId, note, followup },
    collapseLabel: "Dispatché →",
    countsTowardCleared: false, // B2 / E6: dispatch never counts as "écumé"
  });
}

export function postFollowupNote(cardEl, { dealId, note, targetTag }) {
  return runAction(cardEl, {
    functionName: ACTION_FUNCTIONS.postFollowupNote,
    params: { dealId, note, targetTag },
    collapseLabel: "Note postée",
    countsTowardCleared: true,
  });
}

export function rescheduleItem(cardEl, { recordId, module, newDate }) {
  return runAction(cardEl, {
    functionName: ACTION_FUNCTIONS.rescheduleItem,
    params: { recordId, module, newDate },
    collapseLabel: `Reprogrammé au ${newDate}`,
    countsTowardCleared: true,
  });
}

export function deleteFollowup(cardEl, { recordId, module, reason }) {
  return runAction(cardEl, {
    functionName: ACTION_FUNCTIONS.deleteFollowup,
    params: { recordId, module, reason },
    collapseLabel: "Supprimé",
    countsTowardCleared: true,
  });
}

export function applySupervisionBatch(tableEl, decisions) {
  return runAction(tableEl, {
    functionName: ACTION_FUNCTIONS.applySupervisionBatch,
    params: { decisions },
    collapseLabel: `${decisions.length} lignes appliquées`,
    countsTowardCleared: true,
  });
}

export function redispatchB2bLost(cardEl, { dealId, aeId, note }) {
  return runAction(cardEl, {
    functionName: ACTION_FUNCTIONS.redispatchB2bLost,
    params: { dealId, aeId, note },
    collapseLabel: "Re-dispatché →",
    countsTowardCleared: false, // D5: never touches E6, no suivi created for Alexis
  });
}

export function cancelGhostCall(rowEl, { recordId }) {
  return runAction(rowEl, {
    functionName: ACTION_FUNCTIONS.cancelGhostCall,
    params: { recordId },
    collapseLabel: "Call annulé",
    countsTowardCleared: false,
  });
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
  strip.innerHTML = `<span>${labelHtml}</span> <button type="button" class="reopen-btn">↩ Rouvrir</button>`;
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
  collapseCard(cardEl, "Ignorée", () => {}, false);
}
