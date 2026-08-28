// Entry point. Loads the pre-computed digest JSON (one network call, WorkDrive-backed) and
// renders the fixed template — no COQL, no sub-agents, no LLM call happens here.
import { loadDigest } from "./js/digestLoader.js";
import { renderDigest } from "./js/render.js";
import { getCurrentUser } from "./js/zohoApi.js";

init();

async function init() {
  const status = document.getElementById("status");
  try {
    const [digest, user] = await Promise.all([loadDigest(), getCurrentUser()]);
    const crmDomain = (user && user.zuid && window.location.hostname) || window.location.hostname;
    status.hidden = true;
    renderDigest(digest, crmDomain);
  } catch (err) {
    status.hidden = false;
    status.className = "status error";
    status.textContent = `Impossible de charger le digest : ${err.message || err}`;
  }
}
