// Thin wrappers around the Zoho Embedded App SDK. Kept separate so app.js / digestLoader.js /
// actions.js never touch `window.ZOHO` directly — mirrors the pattern in the reference
// Employee Activity Audit widget.

let initPromise = null;

export function initZoho() {
  if (initPromise) return initPromise;
  initPromise = new Promise((resolve) => {
    if (!window.ZOHO || !window.ZOHO.embeddedApp) {
      resolve(false);
      return;
    }
    window.ZOHO.embeddedApp.on("PageLoad", () => resolve(true));
    window.ZOHO.embeddedApp.init().catch(() => resolve(false));
  });
  return initPromise;
}

export async function getOrgVariable(name) {
  const ready = await initZoho();
  if (!ready) return null;
  try {
    const resp = await window.ZOHO.CRM.API.getOrgVariable(name);
    return resp && resp.Success && resp.Success.content ? resp.Success.content : null;
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

// Executes a Deluge custom function (see deluge/digest_actions.dg for the server side).
// Every native action button in the widget goes through this — no LLM round-trip, no
// copy-paste command, just a direct server-side execution with a structured result.
export async function callFunction(functionName, params) {
  const ready = await initZoho();
  if (!ready) {
    throw new Error(`ZOHO SDK not available — cannot call function "${functionName}" outside CRM.`);
  }
  const resp = await window.ZOHO.CRM.FUNCTIONS.execute(functionName, { arguments: params || {} });
  if (resp && resp.code === "SUCCESS") {
    return resp.details && resp.details.output ? JSON.parse(resp.details.output) : resp.details;
  }
  throw new Error(`Function "${functionName}" failed: ${JSON.stringify(resp)}`);
}
