// Entry point. Loads the pre-computed digest JSON (one network call, WorkDrive-backed) and
// renders the fixed template — no COQL, no sub-agents, no LLM call happens here.
import { loadDigest } from "./js/digestLoader.js";
import { renderDigest } from "./js/render.js";
import { getCurrentUser, initZoho } from "./js/zohoApi.js";
import * as actions from "./js/actions.js";
import { PROFILE_LABELS } from "./js/config.js";
import { DEV_VIEWER_ID, listActiveUsers, getViewAsSelection, setViewAsSelection } from "./js/viewAs.js";

init();

async function init() {
  const status = document.getElementById("status");
  try {
    // No ZOHO SDK (local `npm start` preview) → treat the session as a viewer too, since
    // there's no real logged-in identity to protect there anyway.
    const ready = await initZoho();
    const user = await getCurrentUser();
    const isViewer = !ready || (user && user.id === DEV_VIEWER_ID);

    if (isViewer) {
      renderViewAsControl(user); // populates async, doesn't block the digest fetch below
    }

    const effectiveUserId = (isViewer && getViewAsSelection()) || (user && user.id) || null;

    const digest = await loadDigest(effectiveUserId);
    const crmDomain = (user && user.zuid && window.location.hostname) || window.location.hostname;

    actions.setViewAsUser(isViewer ? getViewAsSelection() : null);

    status.hidden = true;
    updateSubtitle(digest);
    if (isViewer && (!user || effectiveUserId !== user.id)) {
      showViewAsBanner(digest);
    }
    renderDigest(digest, crmDomain);
  } catch (err) {
    status.hidden = false;
    status.className = "status error";
    status.textContent = `Impossible de charger le digest : ${err.message || err}`;
  }
}

function updateSubtitle(digest) {
  const sub = document.getElementById("subtitle");
  if (!sub) return;
  sub.textContent = PROFILE_LABELS[digest.profile] || digest.profile || "—";
}

function showViewAsBanner(digest) {
  const digestRoot = document.getElementById("digest-root");
  const banner = document.createElement("div");
  banner.className = "view-as-banner";
  banner.textContent = `Vue test — ${digest.profile || "profil inconnu"} (${digest.user_id || "?"})`;
  digestRoot.parentNode.insertBefore(banner, digestRoot);
}

async function renderViewAsControl(user) {
  const mount = document.getElementById("view-as-root");
  if (!mount) return;
  const users = await listActiveUsers();
  const current = getViewAsSelection() || (user && user.id) || (users[0] && users[0].id) || "";

  mount.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "view-as";
  const label = document.createElement("span");
  label.textContent = "Vue test :";
  const select = document.createElement("select");
  users.forEach((u) => {
    const opt = document.createElement("option");
    opt.value = u.id;
    opt.textContent = u.name;
    if (u.id === current) opt.selected = true;
    select.appendChild(opt);
  });
  select.addEventListener("change", () => {
    setViewAsSelection(select.value);
    window.location.reload();
  });
  wrap.appendChild(label);
  wrap.appendChild(select);
  mount.appendChild(wrap);
}
