const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const { db, bumpRevision, DATA_DIR } = require("./db");
const { generatePdf } = require("./pdf");

const app = express();
app.use(express.json({ limit: "2mb" }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const SETTINGS_ADMIN_FIELDS = [
  "eyebrow", "title", "subtitle", "review_due", "revision_date",
  "shift1_name", "shift1_email", "shift2_name", "shift2_email",
  "shift3_name", "shift3_email", "shift4_name", "shift4_email",
];
const SETTINGS_OPEN_FIELDS = ["auditor", "audit_date", "qa_initials"];
const SETTINGS_GATED_SIGNOFF_FIELDS = ["reviewed_by", "reviewed_date"];

function getSettings() {
  return db.prepare("SELECT * FROM settings WHERE id = 1").get();
}
function getItems() {
  return db.prepare("SELECT * FROM items ORDER BY sort_order ASC").all();
}
function gateOpen() {
  const openItems = db.prepare("SELECT initials FROM items WHERE status = 'U'").all();
  return openItems.every((i) => i.initials && i.initials.trim().length > 0);
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
  res.json({ settings: getSettings(), items: getItems(), gateOpen: gateOpen() });
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

app.post("/api/items/:id/clear", (req, res) => {
  const id = Number(req.params.id);
  const item = db.prepare("SELECT * FROM items WHERE id = ?").get(id);
  if (!item) return res.status(404).json({ error: "Item not found." });
  if (item.photo_filename) {
    const p = path.join(DATA_DIR, "uploads", item.photo_filename);
    fs.existsSync(p) && fs.unlinkSync(p);
  }
  db.prepare(
    "UPDATE items SET description='', corrective_action='', preventive_measures='', initials='', shift=NULL, photo_filename=NULL WHERE id = ?"
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
  const items = db.prepare("SELECT id, photo_filename FROM items").all();
  for (const item of items) {
    if (item.photo_filename) {
      const p = path.join(DATA_DIR, "uploads", item.photo_filename);
      fs.existsSync(p) && fs.unlinkSync(p);
    }
  }
  db.prepare(
    "UPDATE items SET status='', description='', corrective_action='', preventive_measures='', initials='', shift=NULL, photo_filename=NULL"
  ).run();
  db.prepare(
    "UPDATE settings SET auditor='', audit_date='', qa_initials='', reviewed_by='', reviewed_date='' WHERE id = 1"
  ).run();
  bumpRevision();
  res.json({ ok: true });
});

app.get("/api/pdf", (req, res) => {
  generatePdf(res, { settings: getSettings(), items: getItems() });
});

app.use("/uploads", express.static(path.join(DATA_DIR, "uploads"), { maxAge: "30d" }));
app.use(express.static(path.join(__dirname, "..", "public")));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("VF-0033 Audit Console listening on port " + PORT);
});
