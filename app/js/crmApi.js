// Thin wrapper around ZOHO.CRM.API for the plain per-owner writes that don't need a
// Sales-Manager-only server-side gate (reschedule, delete, cancel, plain note post — see
// deluge/actions/README-equivalent comments and ../../CLAUDE.md). Calling ZOHO.CRM.API directly
// executes under the actual logged-in user's own authenticated Zoho session — Zoho enforces who
// that is, it isn't a value this code invents or passes around, which is a stronger identity
// guarantee than a Deluge custom function gets automatically (see resolveActor() in
// deluge/shared/resolve_actor.dg for why that matters there). Mirrors zohoApi.js's style: never
// touch `window.ZOHO` outside a wrapper file.
//
// Request/response shapes below are taken verbatim from Zoho's widget SDK reference
// (help.zwidgets.com/help/latest/ZOHO.CRM.API.html) — every write resolves to
// `{ data: [{ code, details, message, status }] }`.
import { initZoho } from "./zohoApi.js";

async function ensureReady(actionLabel) {
  const ready = await initZoho();
  if (!ready) {
    throw new Error(`ZOHO SDK not available — cannot ${actionLabel} outside CRM.`);
  }
}

function firstResult(resp, actionLabel) {
  const entry = resp && resp.data && resp.data[0];
  const code = entry && entry.code && String(entry.code).toUpperCase();
  if (code === "SUCCESS") return entry;
  throw new Error(`${actionLabel} failed: ${JSON.stringify(resp)}`);
}

export async function getRecord(module, recordId) {
  await ensureReady("read record");
  const resp = await window.ZOHO.CRM.API.getRecord({ Entity: module, RecordID: recordId });
  const record = resp && resp.data && resp.data[0];
  if (!record) throw new Error(`Record not found: ${module}/${recordId}`);
  return record;
}

export async function getRecordOwnerId(module, recordId) {
  const record = await getRecord(module, recordId);
  return record.Owner && record.Owner.id;
}

export async function updateRecord(module, recordId, data, trigger) {
  await ensureReady("update record");
  const apiData = { id: recordId, ...data };
  const resp = await window.ZOHO.CRM.API.updateRecord({ Entity: module, APIData: apiData, Trigger: trigger || [] });
  return firstResult(resp, `Update ${module}/${recordId}`);
}

export async function deleteRecord(module, recordId) {
  await ensureReady("delete record");
  const resp = await window.ZOHO.CRM.API.deleteRecord({ Entity: module, RecordID: recordId });
  return firstResult(resp, `Delete ${module}/${recordId}`);
}

export async function addNotes(module, recordId, title, content) {
  await ensureReady("add note");
  const resp = await window.ZOHO.CRM.API.addNotes({ Entity: module, RecordID: recordId, Title: title, Content: content });
  return firstResult(resp, `Add note to ${module}/${recordId}`);
}

// TODO: MessagesChat is a less-common module — confirm ZOHO.CRM.API.insertRecord supports it
// the same generic way real modules do on this org before relying on it in production (same
// caveat this repo already carries server-side in deluge/actions/post_note_with_channel_check.dg).
export async function insertRecord(module, data, trigger) {
  await ensureReady("create record");
  const resp = await window.ZOHO.CRM.API.insertRecord({ Entity: module, APIData: data, Trigger: trigger || [] });
  return firstResult(resp, `Create ${module} record`);
}

export async function getUser(userId) {
  await ensureReady("read user");
  const resp = await window.ZOHO.CRM.API.getUser({ ID: userId });
  return (resp && resp.users && resp.users[0]) || null;
}

// Best-effort live display name for the "view as" picker (see viewAs.js) — falls back to null
// (caller keeps its own hand-maintained label) rather than throwing, since this is purely
// cosmetic and shouldn't block the picker from rendering.
export async function getUserDisplayName(userId) {
  try {
    const user = await getUser(userId);
    return user && (user.full_name || [user.first_name, user.last_name].filter(Boolean).join(" "));
  } catch (_err) {
    return null;
  }
}

// TODO: Zoho's documented example uses Type:"phone"/"email"/"word" for a simple field search —
// confirm "criteria" is a valid Type value for a full criteria-string search (the module/field
// criteria syntax this widget otherwise uses server-side via zoho.crm.searchRecords) before
// relying on it; if not, this may need Type:"word" with a narrower query instead.
export async function searchRecord(module, type, query) {
  await ensureReady("search records");
  const resp = await window.ZOHO.CRM.API.searchRecord({ Entity: module, Type: type, Query: query, delay: false });
  return (resp && resp.data) || [];
}
