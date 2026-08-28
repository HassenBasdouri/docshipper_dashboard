// All tunables for the digest widget. Nothing in here should require touching
// render.js/actions.js/digestLoader.js when the org's directory or module names change.

// Org variable (Zoho CRM Settings > Org Variables) holding the public/shared WorkDrive link
// to the latest digest JSON — same mechanism the Employee Activity Audit widget uses for
// its `Audit_url` variable. The nightly Deluge job (deluge/digest_generate.dg) updates this
// variable after each successful run.
export const DIGEST_URL_VARIABLE = "Digest_url";

// Deluge custom functions the widget calls for native actions (no copy-paste, no LLM
// round-trip at click time — see deluge/digest_actions.dg for the implementations).
export const ACTION_FUNCTIONS = {
  dispatchInitial: "digest_dispatch_initial",
  postFollowupNote: "digest_post_followup_note",
  rescheduleItem: "digest_reschedule_item",
  deleteFollowup: "digest_delete_followup",
  applySupervisionBatch: "digest_apply_supervision_batch",
  redispatchB2bLost: "digest_redispatch_b2b_lost",
  cancelGhostCall: "digest_cancel_ghost_call",
};

// Alexis M. — the pipeline owner this digest is built for (Important#2 in the v24.1 spec:
// no action button ever targets an item whose Owner.id isn't this id).
export const PIPELINE_OWNER = {
  name: "Alexis M.",
  id: "4664241000189490004",
  email: "alexis.m@docshipper.com",
};

// A2 — exact team directory with ids/emails, as verified via getUsers on 26/08.
// Kept as data (not re-derived at runtime) since the nightly Deluge job already re-verifies
// via getUsers before dispatch — this copy is only for widget-side display/tag menus.
export const TEAM = {
  ae: [
    { name: "Jordan Dubois", email: "jordan.d@docshipper.com", id: "4664241000329095001", dispatchTarget: true },
    { name: "Yanis Huin", email: "yanis.h@docshipper.com", id: "4664241000307521001", dispatchTarget: true },
    { name: "Axel Rocheteau", email: "axel.r@docshipper.com", id: "4664241000292115001", dispatchTarget: true },
    { name: "Mehdi EL HAMZAOUI", email: "mehdi.e@docshipper.com", id: "4664241000340111001", dispatchTarget: true },
    { name: "Maxime MORLON", email: "maxime.m@docshipper.com", id: "4664241000250356001", dispatchTarget: false },
    { name: "Constance Dittrich", email: "constance.d@docshipper.com", id: "4664241000082537008", dispatchTarget: false },
  ],
  op: [
    { name: "Mustapha ERRAIS", email: "mustapha.e@docshipper.com", id: "4664241000184211001" },
    { name: "Karim Messaoudi", email: "karim.m@docshipper.com", id: "4664241000090120001" },
    { name: "Joshua SINAMBAN", email: "joshua.s@docshipper.com", id: "4664241000304700001" },
    { name: "Ranya Yâakoubi", email: "ranya.y@docshipper.com", id: "4664241000028329015" },
    { name: "Khalil Kaddour", email: "khalil.k@docshipper.com", id: "4664241000047237083" },
    { name: "Thomas P", email: "thomas.p@docshipper.com", id: "4664241000276434001" },
    { name: "Jewel Hou", email: "jewel.h@docshipper.com", id: "4664241000269742001" },
    { name: "Idriss Ben Chagra", email: "idriss.b@docshipper.com", id: "4664241000148804001", role: "Operations Manager" },
    { name: "Mayne ZHOU", email: "mayne.z@docshipper.com", id: "4664241000352438001", role: "Sales Shipping / Sourcing-Operation" },
    { name: "Sarah Allalout", email: "sarah.a@docshipper.com", id: "4664241000005529026", role: "Sourcing Operation Manager" },
  ],
  managers: [
    { name: "Taher Kharrat", email: "taher.k@docshipper.com", id: "4664241000112085278", role: "Customer Service Manager" },
  ],
  cs: [
    // CS simples — taggable, but never trigger the A7 compensation email.
    { name: "Alba M.", email: "alba.m@docshipper.com" },
    { name: "Eddie s", email: "eddie.s@docshipper.com" },
    { name: "Stéphane H.", email: "stephane.h@docshipper.com" },
    { name: "Sarah RABAA", email: "sarah.r@docshipper.com" },
  ],
};

// Tag-select menu (A5): the 4 dispatch-target AE + Maxime + all OP + managers.
export function tagMenuEntries() {
  return [
    ...TEAM.ae.filter((p) => p.dispatchTarget || p.name === "Maxime MORLON"),
    ...TEAM.op,
    ...TEAM.managers,
  ];
}

// Emails that never trigger the A7 compensation email (Important#5 exception).
const CS_EMAILS = new Set(TEAM.cs.map((p) => p.email));
export function requiresCompensationEmail(taggedEmail) {
  return !CS_EMAILS.has(taggedEmail);
}

// Section order fixed by E1 — the render layer walks this list, it never reorders on its own.
export const SECTION_ORDER = [
  "badge",
  "initial",
  "voie1",
  "voie2",
  "tasks_perso",
  "supervision",
  "b2b_lost_redispatch",
  "b2b_lost_piloted",
  "deals_closed",
  "vigilance",
  "method_footer",
];

// CRM deal record URL builder (used for "Open Deal" links and dslink cells).
export function dealUrl(crmDomain, dealId) {
  return `https://${crmDomain}/crm/tab/Deals/${dealId}`;
}
