// Renders the fixed dashboard template from the pre-computed digest JSON. This file owns NO
// business logic (no "is this Gold", no owner checks, no note wording) — all of that already
// happened in the nightly Deluge + Claude job. This is display + wiring only, which is why the
// widget makes zero COQL calls and needs no LLM call on open.
import { tagMenuEntries, dealUrl } from "./config.js";
import * as actions from "./actions.js";

const root = () => document.getElementById("digest-root");

export function renderDigest(data, crmDomain) {
  const container = root();
  container.innerHTML = "";

  if (isStaleBanco(data)) {
    container.appendChild(staleBanner(data));
  }

  container.appendChild(renderBadge(data.badge));
  container.appendChild(lane("l-init", `AXE 1 — INITIAL (${count(data.initial)})`, renderInitial(data.initial, crmDomain)));
  container.appendChild(lane("l-v1", `VOIE 1 — ça n'est pas passé (${data.voie1.length})`, renderCardList(data.voie1, crmDomain, "voie1")));
  container.appendChild(lane("l-v2", `VOIE 2 — personne d'autre dessus (${data.voie2.length})`, renderCardList(data.voie2, crmDomain, "voie2")));
  container.appendChild(lane("l-task", `Tasks personnelles (${data.tasks_perso.length})`, renderCardList(data.tasks_perso, crmDomain, "perso")));
  container.appendChild(lane("l-sup", `VOIE 3 — supervision (${countSupervision(data.supervision)})`, renderSupervision(data.supervision, crmDomain)));
  container.appendChild(lane("l-bl", `B2B Lost à redispatcher (${data.b2b_lost_redispatch.length})`, renderB2bRedispatch(data.b2b_lost_redispatch, crmDomain)));
  container.appendChild(lane("l-bl", `B2B Lost déjà pilotés (${data.b2b_lost_piloted.length})`, renderInfoTable(data.b2b_lost_piloted, crmDomain, ["ds", "client", "ae", "item"])));
  container.appendChild(lane("l-bl", `Deals réellement clos (${data.deals_closed.length})`, renderGhostTable(data.deals_closed, crmDomain)));
  container.appendChild(lane("l-vig", `Vigilance (${data.vigilance.length})`, renderCardList(data.vigilance, crmDomain, "vig", { noteOnly: true })));
  container.appendChild(renderMethodFooter(data.method_footer));

  actions.setBadgeBase(data.badge.total || 0);
}

function isStaleBanco(data) {
  const today = new Date().toISOString().slice(0, 10);
  return data.run_date !== today;
}

function staleBanner(data) {
  const div = document.createElement("div");
  div.className = "stale-banner";
  div.textContent = `⚠ Dernier digest livré le ${data.run_date} — le CRM a pu bouger depuis.`;
  return div;
}

function count(initial) {
  return (initial.groups || []).reduce((sum, g) => sum + g.deals.length, 0);
}
function countSupervision(sup) {
  return (sup.groups_by_referent || []).reduce((sum, g) => sum + g.rows.length, 0);
}

function lane(cls, title, bodyEl) {
  const section = document.createElement("section");
  section.className = `lane ${cls}`;
  const h2 = document.createElement("h2");
  h2.textContent = title;
  section.appendChild(h2);
  section.appendChild(bodyEl);
  return section;
}

function renderBadge(badge) {
  const div = document.createElement("div");
  div.className = "badge";
  const big = document.createElement("div");
  big.className = "big";
  big.innerHTML = `<span id="badge-remaining">${badge.total}</span> items ${badge.very_grave ? '<span class="pill crit">TRÈS GRAVE</span>' : ""}`;
  div.appendChild(big);
  const pills = document.createElement("div");
  pills.className = "pills";
  (badge.pills || []).forEach((p) => {
    const span = document.createElement("span");
    span.className = `pill ${p.tone || ""}`;
    span.innerHTML = `${escapeHtml(p.label)}: <b>${p.count}</b>`;
    pills.appendChild(span);
  });
  div.appendChild(pills);
  return div;
}

// --- AXE 1 Initial ---

function renderInitial(initial, crmDomain) {
  const wrap = document.createElement("div");
  const order = ["gold", "rapide", "moyen", "prudence", "douce"];
  const groups = (initial.groups || []).slice().sort((a, b) => order.indexOf(a.heat) - order.indexOf(b.heat));
  groups.forEach((g) => {
    const grp = document.createElement("div");
    grp.className = "grp";
    grp.textContent = g.heat.toUpperCase();
    wrap.appendChild(grp);
    g.deals.forEach((deal) => wrap.appendChild(renderInitialCard(deal, crmDomain)));
  });
  return wrap;
}

function renderInitialCard(deal, crmDomain) {
  const card = document.createElement("article");
  card.className = "card";
  card.appendChild(dismissBtn(card));
  card.appendChild(rowTop(deal, crmDomain));

  if (deal.gold_estimate) {
    const est = document.createElement("div");
    est.className = "passe good";
    est.innerHTML = `<b>Estimation indicative (Gold)</b> — ${escapeHtml(deal.gold_estimate)}`;
    card.appendChild(est);
  }

  const panel = document.createElement("div");
  panel.className = "dispatch";
  panel.appendChild(aeSelect(deal.suggested_ae_id));
  panel.appendChild(noteEditor(deal.note));
  panel.appendChild(followupSelect(deal.followup));

  const btn = document.createElement("button");
  btn.className = "action-btn";
  btn.textContent = "Dispatcher ce deal →";
  btn.addEventListener("click", () => {
    const aeId = panel.querySelector(".ae-select").value;
    const note = panel.querySelector(".dispatch-note").value;
    const followup = readFollowup(panel);
    actions.dispatchInitial(card, { dealId: deal.deal_id, aeId, note, followup });
  });
  panel.appendChild(btn);
  card.appendChild(panel);
  return card;
}

function aeSelect(selectedId) {
  const select = document.createElement("select");
  select.className = "ae-select";
  tagMenuEntries()
    .filter((p) => p.dispatchTarget)
    .forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      if (p.id === selectedId) opt.selected = true;
      select.appendChild(opt);
    });
  return select;
}

// --- generic "Est-ce que c'est passé / Ce que je propose" card (Voie 1/2, tasks perso, vigilance) ---

function renderCardList(items, crmDomain, kind, opts = {}) {
  const wrap = document.createElement("div");
  items.forEach((item) => wrap.appendChild(renderGenericCard(item, crmDomain, kind, opts)));
  return wrap;
}

function renderGenericCard(item, crmDomain, kind, opts) {
  const card = document.createElement("article");
  card.className = "card";
  card.appendChild(dismissBtn(card));
  card.appendChild(rowTop(item, crmDomain));

  if (!opts.noteOnly) {
    const passe = document.createElement("div");
    passe.className = "passe";
    passe.innerHTML = `<b>Est-ce que c'est passé ?</b><br>${(item.passe || []).map(escapeHtml).join("<br>")}`;
    card.appendChild(passe);

    const propose = document.createElement("div");
    propose.className = "recap";
    propose.innerHTML = `<b>Ce que je propose</b><br>${escapeHtml(item.propose || "")}`;
    card.appendChild(propose);
  }

  const panel = document.createElement("div");
  panel.className = "dispatch";
  panel.appendChild(noteEditor(item.note));
  if (!opts.noteOnly) panel.appendChild(followupSelect(item.followup));

  if (!opts.noteOnly) {
    const postBtn = document.createElement("button");
    postBtn.className = "action-btn";
    postBtn.textContent = "Poster la note";
    postBtn.addEventListener("click", () => {
      const note = panel.querySelector(".dispatch-note").value;
      actions.postFollowupNote(card, { dealId: item.deal_id, note, targetTag: item.target_tag });
    });
    panel.appendChild(postBtn);

    if (item.reschedulable) {
      const dateInput = panel.querySelector(".fdate");
      const rescheduleBtn = document.createElement("button");
      rescheduleBtn.className = "action-btn secondary";
      rescheduleBtn.textContent = "Reprogrammer";
      rescheduleBtn.addEventListener("click", () => {
        actions.rescheduleItem(card, {
          recordId: item.record_id,
          module: item.record_module,
          newDate: dateInput.value,
        });
      });
      panel.appendChild(rescheduleBtn);
    }

    if (item.deletable) {
      const delBtn = document.createElement("button");
      delBtn.className = "action-btn danger";
      delBtn.textContent = "Supprimer";
      delBtn.addEventListener("click", () => {
        const reason = prompt("Raison de la suppression (obligatoire) :");
        if (!reason) return;
        actions.deleteFollowup(card, { recordId: item.record_id, module: item.record_module, reason });
      });
      panel.appendChild(delBtn);
    }
  } else {
    panel.querySelector(".dispatch-note").readOnly = !item.note_editable;
  }

  card.appendChild(panel);
  return card;
}

// --- Voie 3 supervision (grouped table) ---

function renderSupervision(sup, crmDomain) {
  const wrap = document.createElement("div");
  (sup.groups_by_referent || []).forEach((group) => {
    const grp = document.createElement("div");
    grp.className = "grp";
    grp.textContent = group.referent;
    wrap.appendChild(grp);

    const table = document.createElement("table");
    table.className = "sup-table";
    table.innerHTML =
      "<thead><tr><th>Deal</th><th>Client</th><th>Stage</th><th>Ce qui le couvre déjà</th><th>Où ça en est</th><th>Reprise</th><th>Décision</th></tr></thead>";
    const tbody = document.createElement("tbody");
    group.rows.forEach((row) => {
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td><a class="dslink" href="${dealUrl(crmDomain, row.deal_id)}" target="_top">${escapeHtml(row.ds)}</a></td>` +
        `<td>${escapeHtml(row.client)}</td>` +
        `<td><span class="stage">${escapeHtml(row.stage)}</span></td>` +
        `<td>${escapeHtml(row.covered_by)}</td>` +
        `<td>${escapeHtml(row.ou_ca_en_est_line)}<br><span class="muted">⟶ ${escapeHtml(row.ou_ca_en_est_waiting || "rien en attente")}</span></td>` +
        `<td>${escapeHtml(row.resume_date)}</td>`;
      const decisionTd = document.createElement("td");
      const select = document.createElement("select");
      select.className = "sup-action";
      select.dataset.recordId = row.record_id;
      select.dataset.module = row.record_module;
      select.dataset.dealId = row.deal_id;
      [
        ["keep", "— laisser tel quel —"],
        ["reschedule", `Reprogrammer au ${row.resume_date}`],
        ["delete", "Supprimer mon call"],
      ].forEach(([value, label]) => {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = label;
        select.appendChild(opt);
      });
      decisionTd.appendChild(select);
      tr.appendChild(decisionTd);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);

    const applyBtn = document.createElement("button");
    applyBtn.className = "action-btn";
    applyBtn.textContent = "Appliquer mes choix →";
    applyBtn.addEventListener("click", () => {
      const decisions = Array.from(table.querySelectorAll(".sup-action"))
        .filter((s) => s.value !== "keep")
        .map((s) => ({
          recordId: s.dataset.recordId,
          module: s.dataset.module,
          dealId: s.dataset.dealId,
          decision: s.value,
        }));
      if (!decisions.length) return;
      actions.applySupervisionBatch(table, decisions);
    });
    wrap.appendChild(applyBtn);
  });
  return wrap;
}

// --- B2B Lost à redispatcher ---

function renderB2bRedispatch(items, crmDomain) {
  const wrap = document.createElement("div");
  items.forEach((item) => {
    const card = document.createElement("article");
    card.className = "card";
    card.appendChild(dismissBtn(card));
    card.appendChild(rowTop(item, crmDomain));

    const heat = document.createElement("span");
    heat.className = `pill ${item.heat === "chaud" ? "crit" : item.heat === "tiède" ? "warn" : "off"}`;
    heat.textContent = item.heat;
    card.querySelector(".row-top").appendChild(heat);

    const info = document.createElement("div");
    info.className = "passe";
    info.innerHTML =
      `<b>Pourquoi il est tombé</b> — ${escapeHtml(item.why_lost)}<br>` +
      `<b>Par où le reprendre</b> — ${escapeHtml(item.angle)}<br>` +
      `<b>Ancien propriétaire</b> — ${escapeHtml(item.old_owner)}<br>` +
      `<b>Docs fournis</b> — ${escapeHtml(item.docs || "aucun")}<br>` +
      `<b>Manquent</b> — ${escapeHtml(item.missing || "—")}`;
    card.appendChild(info);

    const panel = document.createElement("div");
    panel.className = "dispatch";
    panel.appendChild(aeSelect(item.suggested_ae_id));
    panel.appendChild(noteEditor(item.note));
    const btn = document.createElement("button");
    btn.className = "action-btn";
    btn.textContent = "Re-dispatcher →";
    btn.addEventListener("click", () => {
      const aeId = panel.querySelector(".ae-select").value;
      const note = panel.querySelector(".dispatch-note").value;
      actions.redispatchB2bLost(card, { dealId: item.deal_id, aeId, note });
    });
    panel.appendChild(btn);
    card.appendChild(panel);
    wrap.appendChild(card);
  });
  return wrap;
}

// --- info-only tables ---

const COLUMN_LABELS = { ds: "Deal", client: "Client", ae: "AE", item: "Item couvrant" };

function renderInfoTable(items, crmDomain, cols) {
  const table = document.createElement("table");
  table.className = "info-table";
  table.innerHTML = `<thead><tr>${cols.map((c) => `<th>${COLUMN_LABELS[c] || c}</th>`).join("")}</tr></thead>`;
  const tbody = document.createElement("tbody");
  items.forEach((item) => {
    const tr = document.createElement("tr");
    tr.innerHTML = cols
      .map((c) => (c === "ds" ? `<a class="dslink" href="${dealUrl(crmDomain, item.deal_id)}" target="_top">${escapeHtml(item[c])}</a>` : `<td>${escapeHtml(item[c] ?? "")}</td>`))
      .join("");
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  return table;
}

function renderGhostTable(items, crmDomain) {
  const table = document.createElement("table");
  table.className = "info-table";
  table.innerHTML = "<thead><tr><th>Deal</th><th>Client</th><th>Stage</th><th>Fermé par</th><th>Le</th><th>Décision</th></tr></thead>";
  const tbody = document.createElement("tbody");
  items.forEach((item) => {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td><a class="dslink" href="${dealUrl(crmDomain, item.deal_id)}" target="_top">${escapeHtml(item.ds)}</a></td>` +
      `<td>${escapeHtml(item.client)}</td><td><span class="stage">${escapeHtml(item.stage)}</span></td>` +
      `<td>${escapeHtml(item.closed_by)}</td><td>${escapeHtml(item.closed_date)}</td>`;
    const td = document.createElement("td");
    const select = document.createElement("select");
    select.className = "ghost-action";
    select.innerHTML = `<option value="keep">— laisser tel quel —</option><option value="cancel">Annuler mon call</option>`;
    select.dataset.recordId = item.record_id;
    td.appendChild(select);
    tr.appendChild(td);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  const applyBtn = document.createElement("button");
  applyBtn.className = "action-btn";
  applyBtn.textContent = "Appliquer mes choix";
  applyBtn.addEventListener("click", () => {
    Array.from(table.querySelectorAll(".ghost-action"))
      .filter((s) => s.value === "cancel")
      .forEach((s) => actions.cancelGhostCall(s.closest("tr"), { recordId: s.dataset.recordId }));
  });

  const wrap = document.createElement("div");
  wrap.appendChild(table);
  wrap.appendChild(applyBtn);
  return wrap;
}

function renderMethodFooter(footer) {
  const section = document.createElement("section");
  section.className = "method-footer";
  section.innerHTML = `<h2>Pied de méthode</h2><pre>${escapeHtml(JSON.stringify(footer, null, 2))}</pre>`;
  return section;
}

// --- shared row-top / note editor / followup select / dismiss ---

function rowTop(item, crmDomain) {
  const div = document.createElement("div");
  div.className = "row-top";
  div.innerHTML =
    `<a class="dslink" href="${dealUrl(crmDomain, item.deal_id)}" target="_top">${escapeHtml(item.ds)}</a> ` +
    `<span class="cust">${escapeHtml(item.client)}</span> ` +
    `<span class="stage">${escapeHtml(item.stage || "")}</span> ` +
    `${escapeHtml(item.route || "")}`;
  return div;
}

function dismissBtn(card) {
  const btn = document.createElement("button");
  btn.className = "x";
  btn.textContent = "✕";
  btn.addEventListener("click", () => actions.dismissCard(card));
  return btn;
}

function noteEditor(text) {
  const wrap = document.createElement("div");
  const menu = document.createElement("select");
  menu.className = "tag-select";
  menu.innerHTML = `<option value="">+ tag</option>` + tagMenuEntries().map((p) => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`).join("");
  const textarea = document.createElement("textarea");
  textarea.className = "dispatch-note";
  textarea.value = text || "";
  menu.addEventListener("change", () => insertTag(menu, textarea));
  textarea.addEventListener("input", () => autosize(textarea));
  wrap.appendChild(menu);
  wrap.appendChild(textarea);
  requestAnimationFrame(() => autosize(textarea));
  return wrap;
}

function insertTag(select, textarea) {
  const name = select.value;
  if (!name) return;
  const tag = `@${name} `;
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  textarea.value = textarea.value.slice(0, start) + tag + textarea.value.slice(end);
  select.selectedIndex = 0;
  textarea.focus();
  autosize(textarea);
}

// E12 — notes never scroll; autosize on input/load/resize.
function autosize(ta) {
  ta.style.height = "auto";
  ta.style.height = `${ta.scrollHeight + 4}px`;
}
window.addEventListener("resize", () => {
  document.querySelectorAll("textarea.dispatch-note").forEach(autosize);
});

function followupSelect(followup) {
  const wrap = document.createElement("div");
  wrap.className = "followup-row";
  const typeSelect = document.createElement("select");
  typeSelect.className = "followup-type";
  typeSelect.innerHTML = `<option value="">Aucun suivi</option><option value="task">Task</option><option value="call">Call</option>`;
  typeSelect.value = (followup && followup.type) || "";
  const dateInput = document.createElement("input");
  dateInput.type = "date";
  dateInput.className = "fdate";
  dateInput.value = (followup && followup.date) || "";
  wrap.appendChild(typeSelect);
  wrap.appendChild(dateInput);
  return wrap;
}

function readFollowup(panel) {
  const type = panel.querySelector(".followup-type")?.value || "";
  const date = panel.querySelector(".fdate")?.value || "";
  return type ? { type, date } : null;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
