// Resolves and downloads the current user's latest digest JSON from WorkDrive, the same way
// the reference Employee Activity Audit widget's fileLoader.js resolves `Audit_url` and
// downloads a CSV — same fallback ladder, JSON instead of CSV, and it's the ONLY network call
// this widget makes on open (everything else was already computed by the nightly Deluge job).
import { DIGEST_REGISTRY_VARIABLE } from "./config.js";
import { getOrgVariable, initZoho } from "./zohoApi.js";

// The two "view as" local-preview options (see app/js/viewAs.js) map straight to a static file
// instead of the registry — used both for local `npm start` preview and as a fallback when a
// real user has no registry entry yet.
const LOCAL_SAMPLE_FILES = {
  "sample-sales-manager": "./sample-digest.json",
  "sample-004-sales": "./sample-digest-004-sales.json",
};

export async function loadDigest(userId) {
  const url = await resolveDigestUrl(userId);
  if (!url) {
    throw new Error(`No digest available for user "${userId}" — check "${DIGEST_REGISTRY_VARIABLE}".`);
  }
  const raw = await downloadWithFallback(url);
  const parsed = parseDigestJson(raw);
  if (parsed.user_id && userId && parsed.user_id !== userId) {
    console.warn(`digest: loaded digest for user_id "${parsed.user_id}" but expected "${userId}"`);
  }
  return parsed;
}

async function resolveDigestUrl(userId) {
  if (userId && LOCAL_SAMPLE_FILES[userId]) {
    return LOCAL_SAMPLE_FILES[userId];
  }

  const registryRaw = await getOrgVariable(DIGEST_REGISTRY_VARIABLE);
  if (registryRaw && userId) {
    try {
      const registry = JSON.parse(registryRaw);
      const entry = registry && registry[userId];
      if (entry && entry.url) return entry.url;
    } catch (_err) {
      // fall through — malformed registry, treat as no entry
    }
  }

  // No registry entry yet (no CRM / var unset / user not run yet) — local/dev fallback so the
  // widget is still testable.
  return "./sample-digest.json";
}

async function downloadWithFallback(url) {
  const ready = await initZoho();
  // The local sample files (view-as's local options, or the no-registry-entry-yet fallback
  // below) are relative paths, not real remote URLs — Zoho's CRM-SDK transports validate `url`
  // against an absolute-URL pattern and reject a relative one with PATTERN_NOT_MATCHED (a live
  // error confirmed this), so only attempt them for a genuine http(s) URL; go straight to plain
  // `fetch()` (same-origin, works for a relative path) otherwise.
  const isRemoteUrl = /^https?:\/\//i.test(url);

  if (isRemoteUrl && ready && window.ZOHO && window.ZOHO.CRM && window.ZOHO.CRM.CONNECTION) {
    try {
      // `url` and `method` are top-level keys on the config object, not nested inside
      // `parameters` (that field is for the target request's own query/body params) — confirmed
      // by a live REQUIRED_PARAM_MISSING error against the widget SDK reference. Only transport
      // confirmed to actually work for a WorkDrive download — see extractConnectionText's header
      // for why the other two (CONNECTOR.invokeAPI, HTTP.get) aren't reliable here.
      const resp = await window.ZOHO.CRM.CONNECTION.invoke("workdrive_connection", { url, method: "GET" });
      const text = extractConnectionText(resp);
      if (text) return text;
    } catch (_err) {
      // fall through to next transport
    }
  }

  if (isRemoteUrl && ready && window.ZOHO && window.ZOHO.CRM && window.ZOHO.CRM.CONNECTOR) {
    try {
      const resp = await window.ZOHO.CRM.CONNECTOR.invokeAPI({ url, method: "GET" });
      const text = extractConnectionText(resp);
      if (text) return text;
    } catch (_err) {
      // confirmed live to throw a TypeError inside the SDK itself for this call shape
      // ("Cannot read properties of undefined (reading 'FILE')") — fall through to next transport
    }
  }

  if (isRemoteUrl && ready && window.ZOHO && window.ZOHO.CRM && window.ZOHO.CRM.HTTP) {
    try {
      const resp = await window.ZOHO.CRM.HTTP.get({ url });
      if (typeof resp === "string") return resp;
      if (resp && resp.body) return resp.body;
    } catch (_err) {
      // confirmed live to return Zoho's own sign-in page HTML for a WorkDrive URL (no
      // WorkDrive-specific auth) rather than throwing — the typeof/resp.body checks above just
      // won't match, falling through to the next transport naturally
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
  // CONNECTION.invoke's actual response wraps the downstream call's result under `details`
  // (confirmed against the widget SDK reference) — check there too before giving up.
  if (resp.details) return extractConnectionText(resp.details);
  // Last resort: confirmed live — for a WorkDrive JSON file download, CONNECTION.invoke's
  // `details` IS the actual file content already parsed into a plain object by the SDK, not
  // wrapped under any of the field names above. Re-stringify it so callers (which expect a JSON
  // string to parse themselves) get one back.
  if (typeof resp === "object") return JSON.stringify(resp);
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
