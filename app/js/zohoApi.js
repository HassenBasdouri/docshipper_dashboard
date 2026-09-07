// Thin wrappers around the Zoho Embedded App SDK. Kept separate so app.js / digestLoader.js /
// actions.js never touch `window.ZOHO` directly — mirrors the pattern in the reference
// Employee Activity Audit widget.

let initPromise = null;

// 4s cap on the handshake: outside a real CRM iframe (e.g. this widget opened standalone, or
// the local `npm start` preview) `embeddedApp.init()` waits on a "PageLoad" postMessage from a
// parent frame that will never arrive — it neither resolves nor rejects, so without a timeout
// this would hang forever instead of falling back to local/dev behavior.
const INIT_TIMEOUT_MS = 4000;

export function initZoho() {
  if (initPromise) return initPromise;
  initPromise = new Promise((resolve) => {
    if (!window.ZOHO || !window.ZOHO.embeddedApp) {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      resolve(ready);
    };
    window.ZOHO.embeddedApp.on("PageLoad", () => finish(true));
    window.ZOHO.embeddedApp.init().catch(() => finish(false));
    setTimeout(() => finish(false), INIT_TIMEOUT_MS);
  });
  return initPromise;
}

export async function getOrgVariable(name) {
  const ready = await initZoho();
  if (!ready) return null;
  try {
    const resp = await window.ZOHO.CRM.API.getOrgVariable(name);
    // Confirmed live: the field is "Content" (capital C), not "content" — the lowercase guess
    // silently returned null on every call (caught nothing, just fell through the ternary),
    // which is why the widget always fell back to the sample digest regardless of "view as".
    return resp && resp.Success && resp.Success.Content ? resp.Success.Content : null;
  } catch (_err) {
    return null;
  }
}

// Used for building "Open Deal" links (see ../js/config.js's dealUrl) — without this, app.js
// fell back to window.location.hostname, which is the widget's OWN hosting domain (e.g.
// "127.0.0.1" during local `npm start`, or wherever Zoho serves the widget's static assets from
// inside the CRM iframe), never the CRM's own domain — producing dead links either way.
// TODO before first real run: confirm the exact response shape against a live org.
export async function getOrgDomain() {
  const ready = await initZoho();
  if (!ready) return null;
  try {
    const resp = await window.ZOHO.CRM.CONFIG.getOrgDomain();
    const raw = resp && resp.Success && resp.Success.Content;
    return raw ? String(raw).replace(/^https?:\/\//, "").replace(/\/$/, "") : null;
  } catch (_err) {
    return null;
  }
}

export async function getCurrentUser() {
  const ready = await initZoho();
  if (!ready) return null;
  try {
    const resp = await window.ZOHO.CRM.CONFIG.getCurrentUser();
    return (resp && resp.users && resp.users[0]) || null;
  } catch (_err) {
    return null;
  }
}

// Executes a Deluge Standalone custom function (see deluge/actions/ for the server side — only
// the Sales-Manager-only actions still go through this; plain per-owner CRUD moved to direct
// ZOHO.CRM.API calls in crmApi.js). Per the widget SDK reference, `arguments` must be a
// JSON-stringified payload, not a raw object.
export async function callFunction(functionName, params) {
  const ready = await initZoho();
  if (!ready) {
    throw new Error(`ZOHO SDK not available — cannot call function "${functionName}" outside CRM.`);
  }
  const resp = await window.ZOHO.CRM.FUNCTIONS.execute(functionName, { arguments: JSON.stringify(params || {}) });
  const code = resp && resp.code && String(resp.code).toUpperCase();
  if (code === "SUCCESS") {
    return resp.details && resp.details.output ? JSON.parse(resp.details.output) : resp.details;
  }
  throw new Error(`Function "${functionName}" failed: ${JSON.stringify(resp)}`);
}
