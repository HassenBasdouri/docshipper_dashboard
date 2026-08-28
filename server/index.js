// Local dev server only. Zoho widget deployment is done via the Zoho CLI (`zet`), not this
// file — this just lets you open the widget in a plain browser to check rendering against
// app/sample-digest.json (the ZOHO SDK init fails gracefully outside CRM, so only the
// digestLoader's local-file fallback path is exercised here).
const path = require("path");
const express = require("express");

const app = express();
app.use("/app", express.static(path.join(__dirname, "..", "app")));
app.get("/", (_req, res) => res.redirect("/app/widget.html"));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`DocShipper digest widget preview: http://127.0.0.1:${PORT}`);
  console.log("Note: this is a plain HTTP dev preview — ZOHO SDK features only work when embedded inside Zoho CRM.");
});
