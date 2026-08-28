// Resolves and downloads the latest digest JSON from WorkDrive, the same way the reference
// Employee Activity Audit widget's fileLoader.js resolves `Audit_url` and downloads a CSV —
// same fallback ladder, JSON instead of CSV, and it's the ONLY network call this widget makes
// on open (everything else was already computed by the nightly Deluge job).
import { DIGEST_URL_VARIABLE } from "./config.js";
import { getOrgVariable, initZoho } from "./zohoApi.js";

export async function loadDigest() {
  const url = await resolveDigestUrl();
  if (!url) {
    throw new Error(`Org variable "${DIGEST_URL_VARIABLE}" is empty or unreadable.`);
  }
  const raw = await downloadWithFallback(url);
  const parsed = parseDigestJson(raw);
  return parsed;
}

async function resolveDigestUrl() {
  const fromOrgVar = await getOrgVariable(DIGEST_URL_VARIABLE);
  if (fromOrgVar && typeof fromOrgVar === "string" && fromOrgVar.trim()) {
    return fromOrgVar.trim();
  }
  // Local/dev fallback: a same-origin static file, so the widget is testable without CRM.
  return "./sample-digest.json";
}

async function downloadWithFallback(url) {
  const ready = await initZoho();

  if (ready && window.ZOHO && window.ZOHO.CRM && window.ZOHO.CRM.CONNECTION) {
    try {
      const resp = await window.ZOHO.CRM.CONNECTION.invoke("workdrive", {
        parameters: { method: "GET", url },
      });
      const text = extractConnectionText(resp);
      if (text) return text;
    } catch (_err) {
      // fall through to next transport
    }
  }

  if (ready && window.ZOHO && window.ZOHO.CRM && window.ZOHO.CRM.CONNECTOR) {
    try {
      const resp = await window.ZOHO.CRM.CONNECTOR.invokeAPI({ url, method: "GET" });
      const text = extractConnectionText(resp);
      if (text) return text;
    } catch (_err) {
      // fall through to next transport
    }
  }

  if (ready && window.ZOHO && window.ZOHO.CRM && window.ZOHO.CRM.HTTP) {
    try {
      const resp = await window.ZOHO.CRM.HTTP.get({ url });
      if (typeof resp === "string") return resp;
      if (resp && resp.body) return resp.body;
    } catch (_err) {
      // fall through to next transport
    }
  }

  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${url}`);
  return res.text();
}

function extractConnectionText(resp) {
  if (!resp) return null;
  if (typeof resp === "string") return resp;
  if (resp.response_body) return resp.response_body;
  if (resp.body) return resp.body;
  if (resp.content) return resp.content;
  return null;
}

function parseDigestJson(raw) {
  let text = String(raw || "").trim();
  // Some transports hand back a JSON-encoded string wrapper; unwrap once if so.
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      text = JSON.parse(text);
    } catch (_err) {
      /* keep raw text */
    }
  }
  const data = JSON.parse(text);
  if (!data || typeof data !== "object" || !data.run_date) {
    throw new Error("Digest JSON is missing run_date — refusing to render a malformed payload.");
  }
  return data;
}

// Staleness check: the widget still renders the last-good run, but flags it (Important#3 —
// the CRM evolves between runs; a stale digest should say so rather than look current).
export function isStale(digest, today = new Date()) {
  if (!digest || !digest.run_date) return true;
  const todayKey = today.toISOString().slice(0, 10);
  return digest.run_date !== todayKey;
}
