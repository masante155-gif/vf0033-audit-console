const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const { db, bumpRevision, DATA_DIR } = require("./db");
const { generatePdf } = require("./pdf");

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));

function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  return req.protocol + "://" + req.get("host");
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const SETTINGS_ADMIN_FIELDS = [
  "eyebrow", "title", "subtitle", "review_due", "revision_date",
  "shift1_name", "shift1_email", "shift2_name", "shift2_email",
  "shift3_name", "shift3_email", "shift4_name", "shift4_email",
  "shift1_lead_email", "shift2_lead_email", "shift3_lead_email", "shift4_lead_email",
  "emailjs_service_id", "emailjs_template_id", "emailjs_public_key",
];
const SETTINGS_OPEN_FIELDS = ["auditor", "audit_date", "qa_initials"];
const SETTINGS_GATED_SIGNOFF_FIELDS = ["reviewed_by", "reviewed_date"];

function getSettings() {
  return db.prepare("SELECT * FROM settings WHERE id = 1").get();
}
function getItems() {
  return db.prepare("SELECT * FROM items ORDER BY sort_order ASC").all();
}
function getDepartments() {
  return db.prepare("SELECT * FROM departments ORDER BY rowid ASC").all();
}
function getDepartment(section) {
  return db.prepare("SELECT * FROM departments WHERE section = ?").get(section);
}
function gateOpen() {
  const openItems = db.prepare("SELECT initials FROM items WHERE status = 'U'").all();
  return openItems.every((i) => i.initials && i.initials.trim().length > 0);
}

// Freezes the current live checklist into audit_snapshots/audit_snapshot_items
// so pass rates and recurring issues can be trended across audits. Called
// from /api/reset right before it wipes the log for the next audit. Skips
// archiving if nothing was actually reviewed yet (an accidental/empty reset
// shouldn't leave a hollow entry in the history).
const archiveCurrentAudit = db.transaction(() => {
  const settings = getSettings();
  const items = getItems();
  const accepted = items.filter((i) => i.status === "A").length;
  const unacceptable = items.filter((i) => i.status === "U").length;
  if (accepted + unacceptable === 0) return null;

  const info = db
    .prepare(
      "INSERT INTO audit_snapshots (audit_date, auditor, reviewed_by, reviewed_date, total, accepted, unacceptable) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(settings.audit_date || "", settings.auditor || "", settings.reviewed_by || "", settings.reviewed_date || "", items.length, accepted, unacceptable);

  const insertItem = db.prepare(
    "INSERT INTO audit_snapshot_items (snapshot_id, item_id, section, item_text, status, shift, initials) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  for (const item of items) {
    insertItem.run(info.lastInsertRowid, item.id, item.section, item.text, item.status || "", item.shift, item.initials || "");
  }
  return info.lastInsertRowid;
});

function getAuditSnapshots(limit) {
  return db.prepare("SELECT * FROM audit_snapshots ORDER BY id DESC LIMIT ?").all(limit).reverse();
}
function getRecurringIssues(limit) {
  return db
    .prepare(
      `SELECT section, item_text, COUNT(*) AS times_flagged
       FROM audit_snapshot_items
       WHERE status = 'U'
       GROUP BY section, item_text
       ORDER BY times_flagged DESC, item_text ASC
       LIMIT ?`
    )
    .all(limit);
}
function checkAdmin(req) {
  const provided = req.headers["x-admin-passcode"] || "";
  const settings = getSettings();
  return provided && provided === settings.passcode;
}
function requireAdmin(req, res, next) {
  if (!checkAdmin(req)) return res.status(403).json({ error: "Incorrect or missing admin passcode." });
  next();
}

app.get("/api/state", (req, res) => {
  res.json({ settings: getSettings(), items: getItems(), departments: getDepartments(), gateOpen: gateOpen() });
});

app.post("/api/departments", requireAdmin, (req, res) => {
  const { section, head_email, is_production_line } = req.body || {};
  if (!section) return res.status(400).json({ error: "section is required." });
  const existing = db.prepare("SELECT * FROM departments WHERE section = ?").get(section);
  if (!existing) return res.status(404).json({ error: "Unknown department/section." });
  db.prepare("UPDATE departments SET head_email = ?, is_production_line = ? WHERE section = ?").run(
    String(head_email || ""),
    is_production_line ? 1 : 0,
    section
  );
  bumpRevision();
  res.json({ ok: true, department: db.prepare("SELECT * FROM departments WHERE section = ?").get(section) });
});

app.get("/api/revision", (req, res) => {
  const row = db.prepare("SELECT revision FROM settings WHERE id = 1").get();
  res.json({ revision: row.revision });
});

app.post("/api/admin/verify", (req, res) => {
  res.json({ ok: checkAdmin(req) || req.body.passcode === getSettings().passcode });
});

app.post("/api/admin/passcode", requireAdmin, (req, res) => {
  const next = String(req.body.passcode || "").trim();
  if (!next) return res.status(400).json({ error: "Passcode cannot be empty." });
  db.prepare("UPDATE settings SET passcode = ? WHERE id = 1").run(next);
  bumpRevision();
  res.json({ ok: true });
});

app.post("/api/settings", (req, res) => {
  const body = req.body || {};
  const isAdmin = checkAdmin(req);
  const updates = {};

  for (const key of SETTINGS_OPEN_FIELDS) {
    if (key in body) updates[key] = String(body[key]);
  }
  for (const key of SETTINGS_GATED_SIGNOFF_FIELDS) {
    if (key in body) {
      if (!gateOpen()) {
        return res.status(409).json({ error: "Sign-off is locked until every open deviation is acknowledged." });
      }
      updates[key] = String(body[key]);
    }
  }
  for (const key of SETTINGS_ADMIN_FIELDS) {
    if (key in body) {
      if (!isAdmin) return res.status(403).json({ error: "Admin passcode required to change " + key + "." });
      updates[key] = String(body[key]);
    }
  }

  const keys = Object.keys(updates);
  if (keys.length === 0) return res.status(400).json({ error: "No recognized fields." });

  const setClause = keys.map((k) => k + " = ?").join(", ");
  db.prepare("UPDATE settings SET " + setClause + " WHERE id = 1").run(...keys.map((k) => updates[k]));
  bumpRevision();
  res.json({ ok: true, settings: getSettings() });
});

app.post("/api/items/:id/status", (req, res) => {
  const id = Number(req.params.id);
  const status = req.body.status;
  if (!["", "A", "U"].includes(status)) return res.status(400).json({ error: "Invalid status." });
  const item = db.prepare("SELECT * FROM items WHERE id = ?").get(id);
  if (!item) return res.status(404).json({ error: "Item not found." });

  if (status === "U" && !item.description) {
    db.prepare("UPDATE items SET status = ?, description = ? WHERE id = ?").run(status, item.text, id);
  } else {
    db.prepare("UPDATE items SET status = ? WHERE id = ?").run(status, id);
  }
  bumpRevision();
  res.json({ ok: true, item: db.prepare("SELECT * FROM items WHERE id = ?").get(id) });
});

const NC_FIELDS = ["description", "corrective_action", "preventive_measures", "initials"];
app.post("/api/items/:id/nc", (req, res) => {
  const id = Number(req.params.id);
  const body = req.body || {};
  const item = db.prepare("SELECT * FROM items WHERE id = ?").get(id);
  if (!item) return res.status(404).json({ error: "Item not found." });

  const updates = {};
  for (const key of NC_FIELDS) {
    if (key in body) updates[key] = String(body[key]);
  }
  if ("shift" in body) {
    const s = body.shift;
    updates.shift = s === null || s === "" ? null : Number(s);
  }
  const keys = Object.keys(updates);
  if (keys.length === 0) return res.status(400).json({ error: "No recognized fields." });
  const setClause = keys.map((k) => k + " = ?").join(", ");
  db.prepare("UPDATE items SET " + setClause + " WHERE id = ?").run(...keys.map((k) => updates[k]), id);
  bumpRevision();
  res.json({ ok: true, item: db.prepare("SELECT * FROM items WHERE id = ?").get(id) });
});

function shiftName(settings, slot) {
  if (!slot) return null;
  return settings["shift" + slot + "_name"] || ("Shift " + slot);
}

app.get("/api/mail-status", (req, res) => {
  const settings = getSettings();
  const configured = !!(
    settings.emailjs_service_id &&
    settings.emailjs_template_id &&
    settings.emailjs_public_key
  );
  res.json({ configured });
});

// The browser sends the actual email via EmailJS (so it goes out from the
// admin's own connected Gmail, not the server). This endpoint just validates
// the deviation is in a sendable state and hands back everything the
// EmailJS template needs.
app.get("/api/items/:id/notify-payload", (req, res) => {
  const id = Number(req.params.id);
  const item = db.prepare("SELECT * FROM items WHERE id = ?").get(id);
  if (!item) return res.status(404).json({ error: "Item not found." });
  if (item.status !== "U") return res.status(400).json({ error: "This item isn't marked Unacceptable." });

  const settings = getSettings();
  const dept = getDepartment(item.section);
  const shift = shiftName(settings, item.shift);

  // Every department gets its head notified. Departments flagged as
  // production-line ALSO alert the shift supervisor and lead for whichever
  // shift the deviation was logged against.
  const recipients = [];
  if (dept && dept.head_email && dept.head_email.trim()) {
    recipients.push({ email: dept.head_email.trim(), label: "Department Head" });
  }
  if (dept && dept.is_production_line) {
    if (!item.shift) {
      return res.status(400).json({ error: "Pick a shift for this deviation first — this is a production line department." });
    }
    const supEmail = settings["shift" + item.shift + "_email"];
    const leadEmail = settings["shift" + item.shift + "_lead_email"];
    if (supEmail && supEmail.trim()) recipients.push({ email: supEmail.trim(), label: shift + " Supervisor" });
    if (leadEmail && leadEmail.trim()) recipients.push({ email: leadEmail.trim(), label: shift + " Lead" });
  }
  if (recipients.length === 0) {
    return res.status(400).json({
      error: "No recipients configured for this department — set a department head (and shift contacts if this is production line) in Admin.",
    });
  }

  const link = baseUrl(req) + "/?nc=" + id;
  const subject = "GMP Deviation #" + id + " needs review — " + (settings.title || "Floor Audit Console");
  const message =
    "A Non-Conformance was logged on the " + (settings.title || "Floor Audit Console") + ".\n\n" +
    "Item #" + id + " — " + item.section + "\n" +
    (shift ? "Shift: " + shift + "\n" : "") +
    "Audit date: " + (settings.audit_date || "(unspecified)") + "\n" +
    "Auditor: " + (settings.auditor || "(unspecified)") + "\n\n" +
    "Description: " + (item.description || item.text) + "\n" +
    "Corrective action taken: " + (item.corrective_action || "(not yet entered)") + "\n" +
    "Preventive measures: " + (item.preventive_measures || "(not yet entered)") + "\n\n" +
    "Please open the link below, review the deviation, and enter your initials to acknowledge it. " +
    "SQF sign-off is locked until this is acknowledged.\n\n" +
    link;

  const to = recipients.map((r) => r.email).join(",");
  const recipientSummary = recipients.map((r) => r.label).join(", ");

  res.json({ ok: true, to, recipientSummary, subject, message, link, shift, itemId: id });
});

// Called after the browser confirms EmailJS actually sent the message.
app.post("/api/items/:id/notify", (req, res) => {
  const id = Number(req.params.id);
  const item = db.prepare("SELECT * FROM items WHERE id = ?").get(id);
  if (!item) return res.status(404).json({ error: "Item not found." });

  const sentTo = req.body && req.body.sentTo ? String(req.body.sentTo) : null;
  const now = new Date().toISOString();
  db.prepare("UPDATE items SET notified_at = ? WHERE id = ?").run(now, id);
  bumpRevision();
  res.json({ ok: true, item: db.prepare("SELECT * FROM items WHERE id = ?").get(id), sentTo });
});

app.post("/api/items/:id/clear", (req, res) => {
  const id = Number(req.params.id);
  const item = db.prepare("SELECT * FROM items WHERE id = ?").get(id);
  if (!item) return res.status(404).json({ error: "Item not found." });
  if (item.photo_filename) {
    const p = path.join(DATA_DIR, "uploads", item.photo_filename);
    fs.existsSync(p) && fs.unlinkSync(p);
  }
  db.prepare(
    "UPDATE items SET description='', corrective_action='', preventive_measures='', initials='', shift=NULL, photo_filename=NULL, notified_at=NULL WHERE id = ?"
  ).run(id);
  bumpRevision();
  res.json({ ok: true, item: db.prepare("SELECT * FROM items WHERE id = ?").get(id) });
});

app.put("/api/items/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const item = db.prepare("SELECT * FROM items WHERE id = ?").get(id);
  if (!item) return res.status(404).json({ error: "Item not found." });
  const text = req.body && req.body.text != null ? String(req.body.text).trim() : item.text;
  if (!text) return res.status(400).json({ error: "text cannot be empty." });
  db.prepare("UPDATE items SET text = ? WHERE id = ?").run(text, id);
  bumpRevision();
  res.json({ ok: true, item: db.prepare("SELECT * FROM items WHERE id = ?").get(id) });
});

app.post("/api/items", requireAdmin, (req, res) => {
  const { section, text } = req.body || {};
  if (!section || !text || !String(text).trim()) {
    return res.status(400).json({ error: "section and text are required." });
  }
  const maxOrder = db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM items").get().m;
  const result = db
    .prepare("INSERT INTO items (section, sort_order, text) VALUES (?, ?, ?)")
    .run(section, maxOrder + 1, String(text).trim());
  bumpRevision();
  res.json({ ok: true, item: db.prepare("SELECT * FROM items WHERE id = ?").get(result.lastInsertRowid) });
});

app.delete("/api/items/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const item = db.prepare("SELECT * FROM items WHERE id = ?").get(id);
  if (!item) return res.status(404).json({ error: "Item not found." });
  if (item.photo_filename) {
    const p = path.join(DATA_DIR, "uploads", item.photo_filename);
    fs.existsSync(p) && fs.unlinkSync(p);
  }
  db.prepare("DELETE FROM items WHERE id = ?").run(id);
  bumpRevision();
  res.json({ ok: true });
});

app.post("/api/items/:id/photo", upload.single("photo"), async (req, res) => {
  const id = Number(req.params.id);
  const item = db.prepare("SELECT * FROM items WHERE id = ?").get(id);
  if (!item) return res.status(404).json({ error: "Item not found." });
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });

  try {
    const filename = crypto.randomUUID() + ".jpg";
    const outPath = path.join(DATA_DIR, "uploads", filename);
    await sharp(req.file.buffer).rotate().resize({ width: 1100, withoutEnlargement: true }).jpeg({ quality: 76 }).toFile(outPath);

    if (item.photo_filename) {
      const oldPath = path.join(DATA_DIR, "uploads", item.photo_filename);
      fs.existsSync(oldPath) && fs.unlinkSync(oldPath);
    }
    db.prepare("UPDATE items SET photo_filename = ? WHERE id = ?").run(filename, id);
    bumpRevision();
    res.json({ ok: true, photo_filename: filename });
  } catch (e) {
    res.status(500).json({ error: "Could not process image: " + e.message });
  }
});

app.delete("/api/items/:id/photo", (req, res) => {
  const id = Number(req.params.id);
  const item = db.prepare("SELECT * FROM items WHERE id = ?").get(id);
  if (!item) return res.status(404).json({ error: "Item not found." });
  if (item.photo_filename) {
    const p = path.join(DATA_DIR, "uploads", item.photo_filename);
    fs.existsSync(p) && fs.unlinkSync(p);
  }
  db.prepare("UPDATE items SET photo_filename = NULL WHERE id = ?").run(id);
  bumpRevision();
  res.json({ ok: true });
});

app.post("/api/reset", (req, res) => {
  const snapshotId = archiveCurrentAudit();

  const items = db.prepare("SELECT id, photo_filename FROM items").all();
  for (const item of items) {
    if (item.photo_filename) {
      const p = path.join(DATA_DIR, "uploads", item.photo_filename);
      fs.existsSync(p) && fs.unlinkSync(p);
    }
  }
  db.prepare(
    "UPDATE items SET status='', description='', corrective_action='', preventive_measures='', initials='', shift=NULL, photo_filename=NULL, notified_at=NULL"
  ).run();
  db.prepare(
    "UPDATE settings SET auditor='', audit_date='', qa_initials='', reviewed_by='', reviewed_date='' WHERE id = 1"
  ).run();
  bumpRevision();
  res.json({ ok: true, archived: snapshotId !== null });
});

app.get("/api/pdf", (req, res) => {
  const history = {
    snapshots: getAuditSnapshots(10),
    recurringIssues: getRecurringIssues(8),
  };
  generatePdf(res, { settings: getSettings(), items: getItems(), history });
});

app.use("/uploads", express.static(path.join(DATA_DIR, "uploads"), { maxAge: "30d" }));
app.use(express.static(path.join(__dirname, "..", "public")));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("VF-0033 Audit Console listening on port " + PORT);
});
