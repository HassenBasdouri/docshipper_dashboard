// Test/admin "view as" switcher. Lets one designated CRM user (Hassen) preview any profile's
// digest from inside his own widget session, so every profile's features can be tested without
// needing a separate CRM login per profile. Everyone else never sees this control.
//
// This is display-only on the client side — it does NOT grant write access to another user's
// records by itself. Deluge (deluge/shared/resolve_actor.dg) resolves the real actor from its
// own session variable (`zoho.loginuserid`) and only honors an impersonated `viewAsUserId` when
// the real, server-verified invoker is this same Hassen id. See that file's header comment.
import { getOrgVariable } from "./zohoApi.js";
import { getUserDisplayName } from "./crmApi.js";

export const DEV_VIEWER_ID = "4664241000160830001"; // Hassen

const LOCAL_SAMPLE_USERS = [
  { id: "sample-sales-manager", name: "Alexis (Sales Manager) — sample" },
  { id: "sample-004-sales", name: "004-SALES — sample" },
];

const STORAGE_KEY = "viewAsUserId";

// Reads the same `Digest_active_users` org variable the nightly Deluge job loops over, so the
// picker always lists exactly the set of users who actually get a digest generated. The
// hand-maintained `name` field is only a fallback label — where possible each entry's display
// name is refreshed live via ZOHO.CRM.API.getUser (see crmApiUsers.js) so the picker doesn't go
// stale if someone's name changes in the CRM.
export async function listActiveUsers() {
  try {
    const raw = await getOrgVariable("Digest_active_users");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) {
        return Promise.all(
          parsed.map(async (u) => ({ ...u, name: (await getUserDisplayName(u.id)) || u.name }))
        );
      }
    }
  } catch (_err) {
    // fall through to local samples (no CRM / var unset / bad JSON)
  }
  return LOCAL_SAMPLE_USERS;
}

export function getViewAsSelection() {
  try {
    return sessionStorage.getItem(STORAGE_KEY) || null;
  } catch (_err) {
    return null;
  }
}

export function setViewAsSelection(id) {
  try {
    if (id) sessionStorage.setItem(STORAGE_KEY, id);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch (_err) {
    // sessionStorage unavailable — view-as just won't persist across a reload
  }
}
