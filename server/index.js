const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const { db, bumpRevision, DATA_DIR } = require("./db");
const { generatePdf } = require("./pdf");
const { AUDIT_TYPES, NEW_AUDIT_TYPE_KEYS } = require("./audit-types");
const { isAiConfigured, rephraseField, draftFromKeywords, AiNotConfiguredError, AiUpstreamError } = require("./ai");

function handleAiError(res, e) {
  if (e instanceof AiNotConfiguredError) return res.status(503).json({ error: e.message });
  if (e instanceof AiUpstreamError) return res.status(502).json({ error: e.message });
  console.error("AI error:", e);
  return res.status(500).json({ error: "Something went wrong generating that. Try again." });
}

const AI_NC_FIELDS = ["description", "corrective_action", "preventive_measures"];

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));

function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  return req.protocol + "://" + req.get("host");
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const MAX_PHOTOS_PER_ITEM = 10;

// ---- Multi-photo helpers --------------------------------------------------
// Every item (live or archived-snapshot) can carry several photos now,
// stored one-row-per-photo in item_photos / audit_snapshot_item_photos
// rather than in a single column. These attach a `.photos` array (each
// {id, filename}, in upload order) onto rows already fetched elsewhere,
// batched into one extra query rather than one-per-item.
function attachPhotos(items) {
  if (!items.length) return items;
  const ids = [...new Set(items.map((i) => i.id))];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT * FROM item_photos WHERE item_id IN (${placeholders}) ORDER BY item_id ASC, sort_order ASC, id ASC`)
    .all(...ids);
  const byItem = new Map();
  for (const r of rows) {
    if (!byItem.has(r.item_id)) byItem.set(r.item_id, []);
    byItem.get(r.item_id).push({ id: r.id, filename: r.filename });
  }
  for (const item of items) item.photos = byItem.get(item.id) || [];
  return items;
}
function getItemPhotos(itemId) {
  return db
    .prepare("SELECT * FROM item_photos WHERE item_id = ? ORDER BY sort_order ASC, id ASC")
    .all(itemId)
    .map((r) => ({ id: r.id, filename: r.filename }));
}
function attachSnapshotPhotos(snapshotItems) {
  if (!snapshotItems.length) return snapshotItems;
  const ids = snapshotItems.map((i) => i.id);
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT * FROM audit_snapshot_item_photos WHERE snapshot_item_id IN (${placeholders}) ORDER BY snapshot_item_id ASC, sort_order ASC, id ASC`
    )
    .all(...ids);
  const byItem = new Map();
  for (const r of rows) {
    if (!byItem.has(r.snapshot_item_id)) byItem.set(r.snapshot_item_id, []);
    byItem.get(r.snapshot_item_id).push({ id: r.id, filename: r.filename });
  }
  for (const item of snapshotItems) item.photos = byItem.get(item.id) || [];
  return snapshotItems;
}
// Deletes every photo file belonging to the given item_photos rows, then the
// rows themselves are left for the caller to delete (with the rest of the
// item, or via a bulk statement) — this only ever touches disk.
function deleteItemPhotoFiles(photos) {
  photos.forEach((p) => {
    const filePath = path.join(DATA_DIR, "uploads", p.filename);
    fs.existsSync(filePath) && fs.unlinkSync(filePath);
  });
}

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
// GMP-only from here down — items are now a shared table across audit
// types, so every GMP-scoped query below filters on audit_type = 'gmp'
// to keep the live GMP form's behavior identical to before that table
// started holding Internal Audit and Glass & Brittle items too.
function getItems() {
  return attachPhotos(db.prepare("SELECT * FROM items WHERE audit_type = 'gmp' ORDER BY sort_order ASC").all());
}
function getDepartments() {
  return db.prepare("SELECT * FROM departments ORDER BY rowid ASC").all();
}
function getDepartment(section) {
  return db.prepare("SELECT * FROM departments WHERE section = ?").get(section);
}
function gateOpen() {
  const openItems = db.prepare("SELECT initials FROM items WHERE audit_type = 'gmp' AND status = 'U'").all();
  return openItems.every((i) => i.initials && i.initials.trim().length > 0);
}

// Canonical shape used to fingerprint a snapshot's findings, shared between
// archive time (hash it once, up front) and verify time (recompute from
// whatever's in the DB now and compare). Deliberately excludes reviewed_by/
// reviewed_date/content_hash itself — sign-off is expected to be added or
// corrected later and must not appear to "break" the fingerprint.
//
// extraItemFields lets Internal Audit / Glass & Brittle fold their extra
// per-item columns (capa_status, zone) into the hash from day one, without
// changing GMP's payload shape at all: GMP's only call site passes no third
// argument, so extraItemFields defaults to [] and every previously-archived
// GMP snapshot's hash keeps verifying exactly as it always has.
function computeSnapshotHash(core, items, extraItemFields) {
  extraItemFields = extraItemFields || [];
  const payload = JSON.stringify({
    snapshot: {
      audit_date: core.audit_date || "",
      auditor: core.auditor || "",
      qa_initials: core.qa_initials || "",
      archived_at: core.archived_at,
      total: core.total,
      accepted: core.accepted,
      unacceptable: core.unacceptable,
    },
    items: items.map((it) => {
      const base = {
        item_id: it.item_id != null ? it.item_id : it.id,
        section: it.section,
        item_text: it.item_text != null ? it.item_text : it.text,
        status: it.status || "",
        description: it.description || "",
        corrective_action: it.corrective_action || "",
        preventive_measures: it.preventive_measures || "",
        shift: it.shift == null ? null : it.shift,
        initials: it.initials || "",
      };
      for (const field of extraItemFields) {
        base[field] = it[field] == null ? "" : it[field];
      }
      return base;
    }),
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

// Freezes the current live checklist into audit_snapshots/audit_snapshot_items
// so pass rates, recurring issues, and full past reports can be reviewed
// later instead of being lost on every reset. Called from /api/reset right
// before it wipes the log for the next audit. Skips archiving if nothing
// was actually reviewed yet (an accidental/empty reset shouldn't leave a
// hollow entry in the history).
const archiveCurrentAudit = db.transaction(() => {
  const settings = getSettings();
  const items = getItems();
  const accepted = items.filter((i) => i.status === "A").length;
  const unacceptable = items.filter((i) => i.status === "U").length;
  if (accepted + unacceptable === 0) return null;

  const archivedAt = new Date().toISOString();
  const core = {
    audit_date: settings.audit_date || "",
    auditor: settings.auditor || "",
    qa_initials: settings.qa_initials || "",
    archived_at: archivedAt,
    total: items.length,
    accepted,
    unacceptable,
  };
  const contentHash = computeSnapshotHash(core, items);

  const info = db
    .prepare(
      `INSERT INTO audit_snapshots
         (audit_date, auditor, qa_initials, reviewed_by, reviewed_date, archived_at, total, accepted, unacceptable, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      core.audit_date, core.auditor, core.qa_initials,
      settings.reviewed_by || "", settings.reviewed_date || "",
      archivedAt, core.total, core.accepted, core.unacceptable, contentHash
    );

  const insertItem = db.prepare(
    `INSERT INTO audit_snapshot_items
       (snapshot_id, item_id, section, item_text, status, description, corrective_action, preventive_measures, shift, initials, photo_filename)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertSnapshotPhoto = db.prepare(
    "INSERT INTO audit_snapshot_item_photos (snapshot_item_id, filename, sort_order) VALUES (?, ?, ?)"
  );
  for (const item of items) {
    const photos = item.photos || [];
    const itemInfo = insertItem.run(
      info.lastInsertRowid, item.id, item.section, item.text, item.status || "",
      item.description || "", item.corrective_action || "", item.preventive_measures || "",
      item.shift, item.initials || "", (photos[0] && photos[0].filename) || null
    );
    photos.forEach((p, idx) => insertSnapshotPhoto.run(itemInfo.lastInsertRowid, p.filename, idx));
  }
  return info.lastInsertRowid;
});

function getSnapshot(id) {
  return db.prepare("SELECT * FROM audit_snapshots WHERE id = ?").get(id);
}
function getSnapshotItems(id) {
  return attachSnapshotPhotos(db.prepare("SELECT * FROM audit_snapshot_items WHERE snapshot_id = ? ORDER BY id ASC").all(id));
}
// Type-aware: a snapshot's own audit_type tells us which extra fields were
// folded into its hash at archive time (see computeSnapshotHash above), so
// this verifies correctly for GMP (no extra fields, unchanged since launch)
// and for Internal/Glass & Brittle (capa_status / zone) alike.
function verifySnapshot(snapshot, items) {
  if (!snapshot.content_hash) return null; // archived before hashing existed — nothing to check against
  const type = AUDIT_TYPES[snapshot.audit_type] || AUDIT_TYPES.gmp;
  const extraFields = [];
  if (type.hasCapaStatus) extraFields.push("capa_status");
  if (type.hasZoneField) extraFields.push("zone");
  return computeSnapshotHash(snapshot, items, extraFields) === snapshot.content_hash;
}
// typeKey defaults to 'gmp' so every existing GMP call site (getAuditSnapshots(10),
// getAuditSnapshots(10, id)) keeps behaving exactly as before, now correctly
// scoped now that this table holds other audit types' snapshots too.
function getAuditSnapshots(limit, uptoId, typeKey) {
  typeKey = typeKey || "gmp";
  const rows = uptoId
    ? db.prepare("SELECT * FROM audit_snapshots WHERE audit_type = ? AND id <= ? ORDER BY id DESC LIMIT ?").all(typeKey, uptoId, limit)
    : db.prepare("SELECT * FROM audit_snapshots WHERE audit_type = ? ORDER BY id DESC LIMIT ?").all(typeKey, limit);
  return rows.reverse();
}
// audit_snapshot_items has no audit_type column of its own (it never needed
// one before other audit types existed), so scoping joins back to its parent
// snapshot's audit_type. typeKey defaults to 'gmp' for the same reason as above.
function getRecurringIssues(limit, uptoId, typeKey) {
  typeKey = typeKey || "gmp";
  const clause = uptoId
    ? "WHERE s.audit_type = ? AND asi.status = 'U' AND asi.snapshot_id <= ?"
    : "WHERE s.audit_type = ? AND asi.status = 'U'";
  const stmt = db.prepare(
    `SELECT asi.section, asi.item_text, COUNT(*) AS times_flagged
     FROM audit_snapshot_items asi
     JOIN audit_snapshots s ON s.id = asi.snapshot_id
     ${clause}
     GROUP BY asi.section, asi.item_text
     ORDER BY times_flagged DESC, asi.item_text ASC
     LIMIT ?`
  );
  return uptoId ? stmt.all(typeKey, uptoId, limit) : stmt.all(typeKey, limit);
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

// Explicit "Confirm Sign-Off" action for the live (not-yet-archived) audit —
// distinct from the auto-save on the Reviewed By / Date fields. Typing
// saves the draft; this is the deliberate act that stamps a server-side
// timestamp, mirroring "filling in your name" vs. "signing" on paper. The
// timestamp is cleared by /api/reset (new audit cycle) and by the "Edit"
// unconfirm action below (fixing a typo un-signs it until re-confirmed).
app.post("/api/settings/confirm-signoff", (req, res) => {
  if (!gateOpen()) {
    return res.status(409).json({ error: "Sign-off is locked until every open deviation is acknowledged." });
  }
  const body = req.body || {};
  const settings = getSettings();
  const reviewedBy = body.reviewed_by != null ? String(body.reviewed_by).trim() : (settings.reviewed_by || "");
  const reviewedDate = body.reviewed_date != null ? String(body.reviewed_date).trim() : (settings.reviewed_date || "");
  if (!reviewedBy || !reviewedDate) {
    return res.status(400).json({ error: "Enter both a reviewer name and a date before confirming sign-off." });
  }
  const confirmedAt = new Date().toISOString();
  db.prepare("UPDATE settings SET reviewed_by = ?, reviewed_date = ?, signoff_confirmed_at = ? WHERE id = 1").run(
    reviewedBy, reviewedDate, confirmedAt
  );
  bumpRevision();
  res.json({ ok: true, settings: getSettings() });
});

app.post("/api/settings/unconfirm-signoff", (req, res) => {
  db.prepare("UPDATE settings SET signoff_confirmed_at = '' WHERE id = 1").run();
  bumpRevision();
  res.json({ ok: true, settings: getSettings() });
});

app.post("/api/items/:id/status", (req, res) => {
  const id = Number(req.params.id);
  const status = req.body.status;
  if (!["", "A", "U"].includes(status)) return res.status(400).json({ error: "Invalid status." });
  const item = db.prepare("SELECT * FROM items WHERE id = ? AND audit_type = 'gmp'").get(id);
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
  const item = db.prepare("SELECT * FROM items WHERE id = ? AND audit_type = 'gmp'").get(id);
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

app.get("/api/ai-status", (req, res) => {
  res.json({ configured: isAiConfigured() });
});

// Polish whatever the auditor already typed into one NC field. Never writes
// to the item itself — the auditor reviews the suggestion client-side and
// explicitly chooses to use it, same as any other edit to the field.
app.post("/api/items/:id/ai/rephrase", async (req, res) => {
  const id = Number(req.params.id);
  const item = db.prepare("SELECT * FROM items WHERE id = ? AND audit_type = 'gmp'").get(id);
  if (!item) return res.status(404).json({ error: "Item not found." });
  const field = (req.body || {}).field;
  if (!AI_NC_FIELDS.includes(field)) return res.status(400).json({ error: "Unknown field." });
  const currentText = String(item[field] || "").trim();
  if (!currentText) return res.status(400).json({ error: "Type a note first, then polish it with AI." });
  try {
    const text = await rephraseField({
      auditLabel: AUDIT_TYPES.gmp.label,
      sectionLabel: item.section,
      itemText: item.text,
      field,
      currentText,
    });
    res.json({ ok: true, text });
  } catch (e) {
    handleAiError(res, e);
  }
});

// Draft all three NC fields from a short phrase of keywords the auditor
// jots down on the spot.
app.post("/api/items/:id/ai/draft", async (req, res) => {
  const id = Number(req.params.id);
  const item = db.prepare("SELECT * FROM items WHERE id = ? AND audit_type = 'gmp'").get(id);
  if (!item) return res.status(404).json({ error: "Item not found." });
  const keywords = String((req.body || {}).keywords || "").trim();
  if (!keywords) return res.status(400).json({ error: "Type a few keywords describing the issue first." });
  try {
    const drafted = await draftFromKeywords({
      auditLabel: AUDIT_TYPES.gmp.label,
      sectionLabel: item.section,
      itemText: item.text,
      keywords,
    });
    res.json({ ok: true, ...drafted });
  } catch (e) {
    handleAiError(res, e);
  }
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
  const item = db.prepare("SELECT * FROM items WHERE id = ? AND audit_type = 'gmp'").get(id);
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
  const item = db.prepare("SELECT * FROM items WHERE id = ? AND audit_type = 'gmp'").get(id);
  if (!item) return res.status(404).json({ error: "Item not found." });

  const sentTo = req.body && req.body.sentTo ? String(req.body.sentTo) : null;
  const now = new Date().toISOString();
  db.prepare("UPDATE items SET notified_at = ? WHERE id = ?").run(now, id);
  bumpRevision();
  res.json({ ok: true, item: db.prepare("SELECT * FROM items WHERE id = ?").get(id), sentTo });
});

app.post("/api/items/:id/clear", (req, res) => {
  const id = Number(req.params.id);
  const item = db.prepare("SELECT * FROM items WHERE id = ? AND audit_type = 'gmp'").get(id);
  if (!item) return res.status(404).json({ error: "Item not found." });
  deleteItemPhotoFiles(getItemPhotos(id));
  db.prepare("DELETE FROM item_photos WHERE item_id = ?").run(id);
  db.prepare(
    "UPDATE items SET description='', corrective_action='', preventive_measures='', initials='', shift=NULL, photo_filename=NULL, notified_at=NULL WHERE id = ?"
  ).run(id);
  bumpRevision();
  res.json({ ok: true, item: Object.assign(db.prepare("SELECT * FROM items WHERE id = ?").get(id), { photos: [] }) });
});

app.put("/api/items/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const item = db.prepare("SELECT * FROM items WHERE id = ? AND audit_type = 'gmp'").get(id);
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
  const maxOrder = db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM items WHERE audit_type = 'gmp'").get().m;
  const result = db
    .prepare("INSERT INTO items (audit_type, section, sort_order, text) VALUES ('gmp', ?, ?, ?)")
    .run(section, maxOrder + 1, String(text).trim());
  // A brand-new section name (not just a new item in an existing one) needs
  // its own departments row so it shows up in Admin's department/email list.
  db.prepare("INSERT OR IGNORE INTO departments (section) VALUES (?)").run(section);
  bumpRevision();
  res.json({ ok: true, item: db.prepare("SELECT * FROM items WHERE id = ?").get(result.lastInsertRowid) });
});

app.delete("/api/items/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const item = db.prepare("SELECT * FROM items WHERE id = ? AND audit_type = 'gmp'").get(id);
  if (!item) return res.status(404).json({ error: "Item not found." });
  deleteItemPhotoFiles(getItemPhotos(id));
  db.prepare("DELETE FROM item_photos WHERE item_id = ?").run(id);
  db.prepare("DELETE FROM items WHERE id = ?").run(id);
  bumpRevision();
  res.json({ ok: true });
});

// ---- Section-level admin edits (rename / delete a whole department) ------
// A section only "exists" as the set of items carrying that section value,
// so renaming means bulk-updating every item's section — and, since GMP's
// departments table is keyed by section name, carrying that row's
// head_email/is_production_line settings over to the new name too. None of
// this is gated by sign-off status: admin edits to the live checklist are
// always allowed, signed off or not — only "New Audit" archives it.
app.post("/api/sections/rename", requireAdmin, (req, res) => {
  const from = String((req.body || {}).from || "").trim();
  const to = String((req.body || {}).to || "").trim();
  if (!from || !to) return res.status(400).json({ error: "from and to are required." });
  if (from === to) return res.json({ ok: true });
  const exists = db.prepare("SELECT 1 FROM items WHERE audit_type = 'gmp' AND section = ?").get(from);
  if (!exists) return res.status(404).json({ error: "Section not found." });
  const clash = db.prepare("SELECT 1 FROM items WHERE audit_type = 'gmp' AND section = ?").get(to);
  if (clash) return res.status(409).json({ error: "A section with that name already exists." });

  const rename = db.transaction(() => {
    db.prepare("UPDATE items SET section = ? WHERE audit_type = 'gmp' AND section = ?").run(to, from);
    const dept = db.prepare("SELECT * FROM departments WHERE section = ?").get(from);
    db.prepare("DELETE FROM departments WHERE section = ?").run(from);
    db.prepare("INSERT OR IGNORE INTO departments (section, head_email, is_production_line) VALUES (?, ?, ?)").run(
      to, (dept && dept.head_email) || "", (dept && dept.is_production_line) || 0
    );
  });
  rename();
  bumpRevision();
  res.json({ ok: true });
});

app.delete("/api/sections/:name", requireAdmin, (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const items = db.prepare("SELECT * FROM items WHERE audit_type = 'gmp' AND section = ?").all(name);
  if (items.length === 0) return res.status(404).json({ error: "Section not found." });
  const del = db.transaction(() => {
    items.forEach((it) => deleteItemPhotoFiles(getItemPhotos(it.id)));
    db.prepare(
      `DELETE FROM item_photos WHERE item_id IN (${items.map(() => "?").join(",")})`
    ).run(...items.map((it) => it.id));
    db.prepare("DELETE FROM items WHERE audit_type = 'gmp' AND section = ?").run(name);
    db.prepare("DELETE FROM departments WHERE section = ?").run(name);
  });
  del();
  bumpRevision();
  res.json({ ok: true });
});

app.post("/api/items/:id/photo", upload.single("photo"), async (req, res) => {
  const id = Number(req.params.id);
  const item = db.prepare("SELECT * FROM items WHERE id = ? AND audit_type = 'gmp'").get(id);
  if (!item) return res.status(404).json({ error: "Item not found." });
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  const existingCount = db.prepare("SELECT COUNT(*) AS n FROM item_photos WHERE item_id = ?").get(id).n;
  if (existingCount >= MAX_PHOTOS_PER_ITEM) {
    return res.status(400).json({ error: "Up to " + MAX_PHOTOS_PER_ITEM + " photos per item." });
  }

  try {
    const filename = crypto.randomUUID() + ".jpg";
    const outPath = path.join(DATA_DIR, "uploads", filename);
    await sharp(req.file.buffer).rotate().resize({ width: 1100, withoutEnlargement: true }).jpeg({ quality: 76 }).toFile(outPath);

    const nextOrder = db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM item_photos WHERE item_id = ?").get(id).n;
    const info = db.prepare("INSERT INTO item_photos (item_id, filename, sort_order) VALUES (?, ?, ?)").run(id, filename, nextOrder);
    bumpRevision();
    res.json({ ok: true, photo: { id: info.lastInsertRowid, filename }, photos: getItemPhotos(id) });
  } catch (e) {
    res.status(500).json({ error: "Could not process image: " + e.message });
  }
});

app.delete("/api/items/:id/photo/:photoId", (req, res) => {
  const id = Number(req.params.id);
  const photoId = Number(req.params.photoId);
  const item = db.prepare("SELECT * FROM items WHERE id = ? AND audit_type = 'gmp'").get(id);
  if (!item) return res.status(404).json({ error: "Item not found." });
  const photo = db.prepare("SELECT * FROM item_photos WHERE id = ? AND item_id = ?").get(photoId, id);
  if (!photo) return res.status(404).json({ error: "Photo not found." });
  deleteItemPhotoFiles([photo]);
  db.prepare("DELETE FROM item_photos WHERE id = ?").run(photoId);
  bumpRevision();
  res.json({ ok: true, photos: getItemPhotos(id) });
});

app.post("/api/reset", (req, res) => {
  // Photos are archived by reference (copied into audit_snapshot_item_photos)
  // as part of archiveCurrentAudit(), so the underlying files must survive
  // this reset — deleting them here would silently blank out the photo
  // evidence in every past PDF. Only the live item_photos rows (the pointers
  // from the now-cleared items to those files) are removed; the files
  // themselves stay in DATA_DIR/uploads for the archived snapshot to use.
  const snapshotId = archiveCurrentAudit();

  db.prepare("DELETE FROM item_photos WHERE item_id IN (SELECT id FROM items WHERE audit_type = 'gmp')").run();
  db.prepare(
    "UPDATE items SET status='', description='', corrective_action='', preventive_measures='', initials='', shift=NULL, photo_filename=NULL, notified_at=NULL WHERE audit_type = 'gmp'"
  ).run();
  db.prepare(
    "UPDATE settings SET auditor='', audit_date='', qa_initials='', reviewed_by='', reviewed_date='', signoff_confirmed_at='' WHERE id = 1"
  ).run();
  bumpRevision();
  res.json({ ok: true, archived: snapshotId !== null });
});

function withPhotoPaths(item) {
  const photos = item.photos || [];
  return Object.assign({}, item, {
    photo_paths: photos.map((p) => path.join(DATA_DIR, "uploads", p.filename)),
  });
}

app.get("/api/pdf", (req, res) => {
  const history = {
    snapshots: getAuditSnapshots(10),
    recurringIssues: getRecurringIssues(8),
  };
  generatePdf(res, { settings: getSettings(), items: getItems().map(withPhotoPaths), history });
});

function logAmendment(snapshotId, field, oldValue, newValue, changedBy) {
  db.prepare(
    "INSERT INTO audit_snapshot_amendments (snapshot_id, field, old_value, new_value, changed_by) VALUES (?, ?, ?, ?, ?)"
  ).run(snapshotId, field, oldValue || "", newValue || "", changedBy || "");
}
function snapshotSummary(row) {
  const items = getSnapshotItems(row.id);
  return {
    id: row.id,
    audit_date: row.audit_date,
    auditor: row.auditor,
    qa_initials: row.qa_initials,
    reviewed_by: row.reviewed_by,
    reviewed_date: row.reviewed_date,
    archived_at: row.archived_at,
    total: row.total,
    accepted: row.accepted,
    unacceptable: row.unacceptable,
    signedOff: !!(row.reviewed_by && row.reviewed_by.trim() && row.reviewed_date && row.reviewed_date.trim()),
    verified: verifySnapshot(row, items),
  };
}

// ---- Audit history: browse, re-download, and sign off past audits --------
app.get("/api/history", (req, res) => {
  const rows = db.prepare("SELECT * FROM audit_snapshots WHERE audit_type = 'gmp' ORDER BY id DESC").all();
  res.json({ history: rows.map(snapshotSummary) });
});

app.get("/api/history/:id", (req, res) => {
  const id = Number(req.params.id);
  const row = getSnapshot(id);
  if (!row || row.audit_type !== "gmp") return res.status(404).json({ error: "Archived audit not found." });
  const items = getSnapshotItems(id);
  const amendments = db.prepare("SELECT * FROM audit_snapshot_amendments WHERE snapshot_id = ? ORDER BY id ASC").all(id);
  res.json({ ...snapshotSummary(row), items, amendments });
});

app.get("/api/history/:id/pdf", (req, res) => {
  const id = Number(req.params.id);
  const snapshot = getSnapshot(id);
  if (!snapshot || snapshot.audit_type !== "gmp") return res.status(404).json({ error: "Archived audit not found." });
  const snapshotItems = getSnapshotItems(id);
  const verified = verifySnapshot(snapshot, snapshotItems);

  const items = snapshotItems.map((it) => withPhotoPaths({
    id: it.item_id,
    section: it.section,
    text: it.item_text,
    status: it.status,
    description: it.description,
    corrective_action: it.corrective_action,
    preventive_measures: it.preventive_measures,
    shift: it.shift,
    initials: it.initials,
    photos: it.photos,
  }));
  const settings = Object.assign({}, getSettings(), {
    auditor: snapshot.auditor,
    audit_date: snapshot.audit_date,
    qa_initials: snapshot.qa_initials,
    reviewed_by: snapshot.reviewed_by,
    reviewed_date: snapshot.reviewed_date,
  });
  const history = {
    snapshots: getAuditSnapshots(10, id),
    recurringIssues: getRecurringIssues(8, id),
  };
  const archiveInfo = { archivedAt: snapshot.archived_at, verified };
  generatePdf(res, { settings, items, history, archiveInfo });
});

app.post("/api/history/:id/signoff", (req, res) => {
  const id = Number(req.params.id);
  const snapshot = getSnapshot(id);
  if (!snapshot || snapshot.audit_type !== "gmp") return res.status(404).json({ error: "Archived audit not found." });

  const reviewedBy = String((req.body || {}).reviewed_by || "").trim();
  const reviewedDate = String((req.body || {}).reviewed_date || "").trim();
  if (!reviewedBy || !reviewedDate) {
    return res.status(400).json({ error: "Enter both a reviewer name and a date to sign off." });
  }

  const alreadySigned = !!(snapshot.reviewed_by && snapshot.reviewed_by.trim() && snapshot.reviewed_date && snapshot.reviewed_date.trim());
  if (alreadySigned) {
    if (!checkAdmin(req)) {
      return res.status(403).json({ error: "This audit is already signed off. Admin passcode required to correct it." });
    }
    const changedBy = String((req.body || {}).changed_by || "").trim() || "admin";
    if (reviewedBy !== snapshot.reviewed_by) logAmendment(id, "reviewed_by", snapshot.reviewed_by, reviewedBy, changedBy);
    if (reviewedDate !== snapshot.reviewed_date) logAmendment(id, "reviewed_date", snapshot.reviewed_date, reviewedDate, changedBy);
  }

  db.prepare("UPDATE audit_snapshots SET reviewed_by = ?, reviewed_date = ? WHERE id = ?").run(reviewedBy, reviewedDate, id);
  res.json({ ok: true, amended: alreadySigned, snapshot: snapshotSummary(getSnapshot(id)) });
});

// Permanently removes an archived audit — meant for trial/demo runs that
// were never real audits and shouldn't skew trend data (recurring issues,
// the pass-rate history chart, the new Dashboard tab's trend). Admin-only
// and irreversible: no amendment trail, unlike sign-off corrections above,
// because there is nothing sensible left to log once the record is gone.
app.delete("/api/history/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const snapshot = getSnapshot(id);
  if (!snapshot || snapshot.audit_type !== "gmp") return res.status(404).json({ error: "Archived audit not found." });
  const snapshotItems = getSnapshotItems(id);
  const del = db.transaction(() => {
    snapshotItems.forEach((it) => deleteItemPhotoFiles(it.photos || []));
    db.prepare(
      "DELETE FROM audit_snapshot_item_photos WHERE snapshot_item_id IN (SELECT id FROM audit_snapshot_items WHERE snapshot_id = ?)"
    ).run(id);
    db.prepare("DELETE FROM audit_snapshot_amendments WHERE snapshot_id = ?").run(id);
    db.prepare("DELETE FROM audit_snapshot_items WHERE snapshot_id = ?").run(id);
    db.prepare("DELETE FROM audit_snapshots WHERE id = ?").run(id);
  });
  del();
  bumpRevision();
  res.json({ ok: true, deleted: id });
});

// ===========================================================================
// Internal Audit / Glass & Brittle Audit — generic, type-aware routes.
//
// Mirrors the GMP routes above field-for-field and endpoint-for-endpoint
// (state, settings, confirm-signoff, item status/nc/photo/clear, reset,
// pdf, history), but:
//   - reads/writes audit_type_settings (keyed by audit_type) instead of
//     the GMP-only settings table (passcode/shift/EmailJS config still
//     live solely in settings and apply account-wide, via checkAdmin());
//   - scopes every items/snapshots query by audit_type;
//   - drives status options / N/A handling / capa_status / zone off the
//     AUDIT_TYPES config instead of hardcoding GMP's A/U scale.
// None of this touches the GMP routes or tables above — a bug here cannot
// regress the live GMP form.
// ===========================================================================

function requireNewType(req, res, next) {
  const type = AUDIT_TYPES[req.params.type];
  if (!type || req.params.type === "gmp") {
    return res.status(404).json({ error: "Unknown audit type." });
  }
  req.auditType = type;
  next();
}

const TYPE_OPEN_FIELDS = ["auditor", "audit_date", "qa_initials", "zone_filter"];
const TYPE_GATED_SIGNOFF_FIELDS = ["reviewed_by", "reviewed_date"];
const TYPE_ADMIN_FIELDS = ["eyebrow", "title", "subtitle", "review_due", "revision_date"];
const TYPE_NC_FIELDS = ["description", "corrective_action", "preventive_measures", "initials", "capa_status"];

function getTypeSettings(typeKey) {
  return db.prepare("SELECT * FROM audit_type_settings WHERE audit_type = ?").get(typeKey);
}
function getTypeItems(typeKey) {
  return attachPhotos(db.prepare("SELECT * FROM items WHERE audit_type = ? ORDER BY sort_order ASC").all(typeKey));
}
function typeGateOpen(typeKey) {
  const openItems = db.prepare("SELECT initials FROM items WHERE audit_type = ? AND status = 'U'").all(typeKey);
  return openItems.every((i) => i.initials && i.initials.trim().length > 0);
}
function typeMeta(type) {
  return {
    key: type.key,
    label: type.label,
    docNumber: type.docNumber,
    sectionLabel: type.sectionLabel,
    hasZoneField: type.hasZoneField,
    hasCapaStatus: type.hasCapaStatus,
    statusOptions: type.statusOptions,
    statusLabels: type.statusLabels,
    naStatus: type.naStatus,
    zoneOptions: type.zoneOptions || null,
    zoneFrequencyLabels: type.zoneFrequencyLabels || null,
    capaStatusOptions: type.capaStatusOptions || null,
  };
}

// Freezes the current live checklist for one of the new audit types, the
// same way archiveCurrentAudit() does for GMP above (own function so a bug
// here can't touch GMP's transaction). "Passed" for the accepted/unacceptable
// snapshot columns means the 'S' (Satisfactory) status; N/A items count
// toward total but not toward either column — recoverable as total - accepted
// - unacceptable if ever needed.
function archiveTypeAudit(typeKey) {
  const run = db.transaction(() => {
    const type = AUDIT_TYPES[typeKey];
    const settings = getTypeSettings(typeKey);
    const items = getTypeItems(typeKey);
    const satisfactory = items.filter((i) => i.status === "S").length;
    const unsatisfactory = items.filter((i) => i.status === "U").length;
    if (satisfactory + unsatisfactory === 0) return null;

    const archivedAt = new Date().toISOString();
    const core = {
      audit_date: settings.audit_date || "",
      auditor: settings.auditor || "",
      qa_initials: settings.qa_initials || "",
      archived_at: archivedAt,
      total: items.length,
      accepted: satisfactory,
      unacceptable: unsatisfactory,
    };
    const extraFields = [];
    if (type.hasCapaStatus) extraFields.push("capa_status");
    if (type.hasZoneField) extraFields.push("zone");
    const contentHash = computeSnapshotHash(core, items, extraFields);

    const info = db
      .prepare(
        `INSERT INTO audit_snapshots
           (audit_type, audit_date, auditor, qa_initials, reviewed_by, reviewed_date, archived_at, total, accepted, unacceptable, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        typeKey, core.audit_date, core.auditor, core.qa_initials,
        settings.reviewed_by || "", settings.reviewed_date || "",
        archivedAt, core.total, core.accepted, core.unacceptable, contentHash
      );

    const insertItem = db.prepare(
      `INSERT INTO audit_snapshot_items
         (snapshot_id, item_id, section, item_text, status, description, corrective_action, preventive_measures, shift, initials, photo_filename, zone, capa_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertSnapshotPhoto = db.prepare(
      "INSERT INTO audit_snapshot_item_photos (snapshot_item_id, filename, sort_order) VALUES (?, ?, ?)"
    );
    for (const item of items) {
      const photos = item.photos || [];
      const itemInfo = insertItem.run(
        info.lastInsertRowid, item.id, item.section, item.text, item.status || "",
        item.description || "", item.corrective_action || "", item.preventive_measures || "",
        null, item.initials || "", (photos[0] && photos[0].filename) || null,
        item.zone || "", item.capa_status || ""
      );
      photos.forEach((p, idx) => insertSnapshotPhoto.run(itemInfo.lastInsertRowid, p.filename, idx));
    }
    return info.lastInsertRowid;
  });
  return run();
}

app.get("/api/:type/state", requireNewType, (req, res) => {
  const typeKey = req.params.type;
  res.json({
    settings: getTypeSettings(typeKey),
    items: getTypeItems(typeKey),
    gateOpen: typeGateOpen(typeKey),
    auditType: typeMeta(req.auditType),
  });
});

app.post("/api/:type/settings", requireNewType, (req, res) => {
  const typeKey = req.params.type;
  const body = req.body || {};
  const isAdmin = checkAdmin(req);
  const updates = {};

  for (const key of TYPE_OPEN_FIELDS) {
    if (key === "zone_filter" && !req.auditType.hasZoneField) continue;
    if (key in body) updates[key] = String(body[key]);
  }
  for (const key of TYPE_GATED_SIGNOFF_FIELDS) {
    if (key in body) {
      if (!typeGateOpen(typeKey)) {
        return res.status(409).json({ error: "Sign-off is locked until every open deviation is acknowledged." });
      }
      updates[key] = String(body[key]);
    }
  }
  for (const key of TYPE_ADMIN_FIELDS) {
    if (key in body) {
      if (!isAdmin) return res.status(403).json({ error: "Admin passcode required to change " + key + "." });
      updates[key] = String(body[key]);
    }
  }

  const keys = Object.keys(updates);
  if (keys.length === 0) return res.status(400).json({ error: "No recognized fields." });

  const setClause = keys.map((k) => k + " = ?").join(", ");
  db.prepare("UPDATE audit_type_settings SET " + setClause + " WHERE audit_type = ?").run(...keys.map((k) => updates[k]), typeKey);
  bumpRevision();
  res.json({ ok: true, settings: getTypeSettings(typeKey) });
});

app.post("/api/:type/settings/confirm-signoff", requireNewType, (req, res) => {
  const typeKey = req.params.type;
  if (!typeGateOpen(typeKey)) {
    return res.status(409).json({ error: "Sign-off is locked until every open deviation is acknowledged." });
  }
  const body = req.body || {};
  const settings = getTypeSettings(typeKey);
  const reviewedBy = body.reviewed_by != null ? String(body.reviewed_by).trim() : (settings.reviewed_by || "");
  const reviewedDate = body.reviewed_date != null ? String(body.reviewed_date).trim() : (settings.reviewed_date || "");
  if (!reviewedBy || !reviewedDate) {
    return res.status(400).json({ error: "Enter both a reviewer name and a date before confirming sign-off." });
  }
  const confirmedAt = new Date().toISOString();
  db.prepare("UPDATE audit_type_settings SET reviewed_by = ?, reviewed_date = ?, signoff_confirmed_at = ? WHERE audit_type = ?").run(
    reviewedBy, reviewedDate, confirmedAt, typeKey
  );
  bumpRevision();
  res.json({ ok: true, settings: getTypeSettings(typeKey) });
});

app.post("/api/:type/settings/unconfirm-signoff", requireNewType, (req, res) => {
  db.prepare("UPDATE audit_type_settings SET signoff_confirmed_at = '' WHERE audit_type = ?").run(req.params.type);
  bumpRevision();
  res.json({ ok: true, settings: getTypeSettings(req.params.type) });
});

app.post("/api/:type/items/:id/status", requireNewType, (req, res) => {
  const typeKey = req.params.type;
  const id = Number(req.params.id);
  const status = req.body.status;
  const allowed = ["", ...req.auditType.statusOptions];
  if (!allowed.includes(status)) return res.status(400).json({ error: "Invalid status." });
  const item = db.prepare("SELECT * FROM items WHERE id = ? AND audit_type = ?").get(id, typeKey);
  if (!item) return res.status(404).json({ error: "Item not found." });

  // Only the "failed" status ('U') auto-seeds description + opens an NC —
  // the N/A status never does, matching GMP's A/U model extended to the
  // 3-state S/U/N scale.
  if (status === "U" && !item.description) {
    db.prepare("UPDATE items SET status = ?, description = ? WHERE id = ?").run(status, item.text, id);
  } else {
    db.prepare("UPDATE items SET status = ? WHERE id = ?").run(status, id);
  }
  bumpRevision();
  res.json({ ok: true, item: db.prepare("SELECT * FROM items WHERE id = ?").get(id) });
});

app.post("/api/:type/items/:id/nc", requireNewType, (req, res) => {
  const typeKey = req.params.type;
  const id = Number(req.params.id);
  const body = req.body || {};
  const item = db.prepare("SELECT * FROM items WHERE id = ? AND audit_type = ?").get(id, typeKey);
  if (!item) return res.status(404).json({ error: "Item not found." });

  const updates = {};
  for (const key of TYPE_NC_FIELDS) {
    if (key === "capa_status" && !req.auditType.hasCapaStatus) continue;
    if (key in body) updates[key] = String(body[key]);
  }
  const keys = Object.keys(updates);
  if (keys.length === 0) return res.status(400).json({ error: "No recognized fields." });
  const setClause = keys.map((k) => k + " = ?").join(", ");
  db.prepare("UPDATE items SET " + setClause + " WHERE id = ?").run(...keys.map((k) => updates[k]), id);
  bumpRevision();
  res.json({ ok: true, item: db.prepare("SELECT * FROM items WHERE id = ?").get(id) });
});

// See the GMP /api/items/:id/ai/rephrase and /ai/draft routes above for the
// rationale — same behavior, scoped to this audit type.
app.post("/api/:type/items/:id/ai/rephrase", requireNewType, async (req, res) => {
  const typeKey = req.params.type;
  const id = Number(req.params.id);
  const item = db.prepare("SELECT * FROM items WHERE id = ? AND audit_type = ?").get(id, typeKey);
  if (!item) return res.status(404).json({ error: "Item not found." });
  const field = (req.body || {}).field;
  if (!AI_NC_FIELDS.includes(field)) return res.status(400).json({ error: "Unknown field." });
  const currentText = String(item[field] || "").trim();
  if (!currentText) return res.status(400).json({ error: "Type a note first, then polish it with AI." });
  try {
    const text = await rephraseField({
      auditLabel: req.auditType.label,
      sectionLabel: item.section,
      itemText: item.text,
      field,
      currentText,
    });
    res.json({ ok: true, text });
  } catch (e) {
    handleAiError(res, e);
  }
});

app.post("/api/:type/items/:id/ai/draft", requireNewType, async (req, res) => {
  const typeKey = req.params.type;
  const id = Number(req.params.id);
  const item = db.prepare("SELECT * FROM items WHERE id = ? AND audit_type = ?").get(id, typeKey);
  if (!item) return res.status(404).json({ error: "Item not found." });
  const keywords = String((req.body || {}).keywords || "").trim();
  if (!keywords) return res.status(400).json({ error: "Type a few keywords describing the issue first." });
  try {
    const drafted = await draftFromKeywords({
      auditLabel: req.auditType.label,
      sectionLabel: item.section,
      itemText: item.text,
      keywords,
    });
    res.json({ ok: true, ...drafted });
  } catch (e) {
    handleAiError(res, e);
  }
});

app.post("/api/:type/items/:id/clear", requireNewType, (req, res) => {
  const typeKey = req.params.type;
  const id = Number(req.params.id);
  const item = db.prepare("SELECT * FROM items WHERE id = ? AND audit_type = ?").get(id, typeKey);
  if (!item) return res.status(404).json({ error: "Item not found." });
  deleteItemPhotoFiles(getItemPhotos(id));
  db.prepare("DELETE FROM item_photos WHERE item_id = ?").run(id);
  db.prepare(
    "UPDATE items SET description='', corrective_action='', preventive_measures='', initials='', capa_status='', photo_filename=NULL WHERE id = ?"
  ).run(id);
  bumpRevision();
  res.json({ ok: true, item: Object.assign(db.prepare("SELECT * FROM items WHERE id = ?").get(id), { photos: [] }) });
});

// ---- Admin: full checklist editing (item wording, add/delete items and
// whole sections) — mirrors GMP's item/section admin routes above, scoped
// to this audit type. Not gated by sign-off: an admin can restructure the
// live checklist at any point, signed off or not — only "New Audit"
// archives whatever it currently looks like.
app.put("/api/:type/items/:id", requireNewType, requireAdmin, (req, res) => {
  const typeKey = req.params.type;
  const id = Number(req.params.id);
  const item = db.prepare("SELECT * FROM items WHERE id = ? AND audit_type = ?").get(id, typeKey);
  if (!item) return res.status(404).json({ error: "Item not found." });
  const text = req.body && req.body.text != null ? String(req.body.text).trim() : item.text;
  if (!text) return res.status(400).json({ error: "text cannot be empty." });
  db.prepare("UPDATE items SET text = ? WHERE id = ?").run(text, id);
  bumpRevision();
  res.json({ ok: true, item: db.prepare("SELECT * FROM items WHERE id = ?").get(id) });
});

app.post("/api/:type/items", requireNewType, requireAdmin, (req, res) => {
  const typeKey = req.params.type;
  const { section, text } = req.body || {};
  if (!section || !text || !String(text).trim()) {
    return res.status(400).json({ error: "section and text are required." });
  }
  const maxOrder = db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM items WHERE audit_type = ?").get(typeKey).m;
  const result = db
    .prepare("INSERT INTO items (audit_type, section, sort_order, text) VALUES (?, ?, ?, ?)")
    .run(typeKey, section, maxOrder + 1, String(text).trim());
  bumpRevision();
  res.json({ ok: true, item: db.prepare("SELECT * FROM items WHERE id = ?").get(result.lastInsertRowid) });
});

app.delete("/api/:type/items/:id", requireNewType, requireAdmin, (req, res) => {
  const typeKey = req.params.type;
  const id = Number(req.params.id);
  const item = db.prepare("SELECT * FROM items WHERE id = ? AND audit_type = ?").get(id, typeKey);
  if (!item) return res.status(404).json({ error: "Item not found." });
  deleteItemPhotoFiles(getItemPhotos(id));
  db.prepare("DELETE FROM item_photos WHERE item_id = ?").run(id);
  db.prepare("DELETE FROM items WHERE id = ?").run(id);
  bumpRevision();
  res.json({ ok: true });
});

app.post("/api/:type/sections/rename", requireNewType, requireAdmin, (req, res) => {
  const typeKey = req.params.type;
  const from = String((req.body || {}).from || "").trim();
  const to = String((req.body || {}).to || "").trim();
  if (!from || !to) return res.status(400).json({ error: "from and to are required." });
  if (from === to) return res.json({ ok: true });
  const exists = db.prepare("SELECT 1 FROM items WHERE audit_type = ? AND section = ?").get(typeKey, from);
  if (!exists) return res.status(404).json({ error: "Section not found." });
  const clash = db.prepare("SELECT 1 FROM items WHERE audit_type = ? AND section = ?").get(typeKey, to);
  if (clash) return res.status(409).json({ error: "A section with that name already exists." });
  db.prepare("UPDATE items SET section = ? WHERE audit_type = ? AND section = ?").run(to, typeKey, from);
  bumpRevision();
  res.json({ ok: true });
});

app.delete("/api/:type/sections/:name", requireNewType, requireAdmin, (req, res) => {
  const typeKey = req.params.type;
  const name = decodeURIComponent(req.params.name);
  const items = db.prepare("SELECT * FROM items WHERE audit_type = ? AND section = ?").all(typeKey, name);
  if (items.length === 0) return res.status(404).json({ error: "Section not found." });
  const del = db.transaction(() => {
    items.forEach((it) => deleteItemPhotoFiles(getItemPhotos(it.id)));
    db.prepare(
      `DELETE FROM item_photos WHERE item_id IN (${items.map(() => "?").join(",")})`
    ).run(...items.map((it) => it.id));
    db.prepare("DELETE FROM items WHERE audit_type = ? AND section = ?").run(typeKey, name);
  });
  del();
  bumpRevision();
  res.json({ ok: true });
});

app.post("/api/:type/items/:id/photo", requireNewType, upload.single("photo"), async (req, res) => {
  const typeKey = req.params.type;
  const id = Number(req.params.id);
  const item = db.prepare("SELECT * FROM items WHERE id = ? AND audit_type = ?").get(id, typeKey);
  if (!item) return res.status(404).json({ error: "Item not found." });
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  const existingCount = db.prepare("SELECT COUNT(*) AS n FROM item_photos WHERE item_id = ?").get(id).n;
  if (existingCount >= MAX_PHOTOS_PER_ITEM) {
    return res.status(400).json({ error: "Up to " + MAX_PHOTOS_PER_ITEM + " photos per item." });
  }

  try {
    const filename = crypto.randomUUID() + ".jpg";
    const outPath = path.join(DATA_DIR, "uploads", filename);
    await sharp(req.file.buffer).rotate().resize({ width: 1100, withoutEnlargement: true }).jpeg({ quality: 76 }).toFile(outPath);

    const nextOrder = db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM item_photos WHERE item_id = ?").get(id).n;
    const info = db.prepare("INSERT INTO item_photos (item_id, filename, sort_order) VALUES (?, ?, ?)").run(id, filename, nextOrder);
    bumpRevision();
    res.json({ ok: true, photo: { id: info.lastInsertRowid, filename }, photos: getItemPhotos(id) });
  } catch (e) {
    res.status(500).json({ error: "Could not process image: " + e.message });
  }
});

app.delete("/api/:type/items/:id/photo/:photoId", requireNewType, (req, res) => {
  const typeKey = req.params.type;
  const id = Number(req.params.id);
  const photoId = Number(req.params.photoId);
  const item = db.prepare("SELECT * FROM items WHERE id = ? AND audit_type = ?").get(id, typeKey);
  if (!item) return res.status(404).json({ error: "Item not found." });
  const photo = db.prepare("SELECT * FROM item_photos WHERE id = ? AND item_id = ?").get(photoId, id);
  if (!photo) return res.status(404).json({ error: "Photo not found." });
  deleteItemPhotoFiles([photo]);
  db.prepare("DELETE FROM item_photos WHERE id = ?").run(photoId);
  bumpRevision();
  res.json({ ok: true, photos: getItemPhotos(id) });
});

app.post("/api/:type/reset", requireNewType, (req, res) => {
  const typeKey = req.params.type;
  // Zone filter is a UI/session convenience, not audit data — deliberately
  // left untouched by a reset (see zone_filter comment on TYPE_OPEN_FIELDS).
  const snapshotId = archiveTypeAudit(typeKey);

  db.prepare("DELETE FROM item_photos WHERE item_id IN (SELECT id FROM items WHERE audit_type = ?)").run(typeKey);
  db.prepare(
    "UPDATE items SET status='', description='', corrective_action='', preventive_measures='', initials='', capa_status='', photo_filename=NULL WHERE audit_type = ?"
  ).run(typeKey);
  db.prepare(
    "UPDATE audit_type_settings SET auditor='', audit_date='', qa_initials='', reviewed_by='', reviewed_date='', signoff_confirmed_at='' WHERE audit_type = ?"
  ).run(typeKey);
  bumpRevision();
  res.json({ ok: true, archived: snapshotId !== null });
});

app.get("/api/:type/pdf", requireNewType, (req, res) => {
  const typeKey = req.params.type;
  const history = {
    snapshots: getAuditSnapshots(10, null, typeKey),
    recurringIssues: getRecurringIssues(8, null, typeKey),
  };
  generatePdf(res, {
    settings: getTypeSettings(typeKey),
    items: getTypeItems(typeKey).map(withPhotoPaths),
    history,
    auditType: req.auditType,
  });
});

app.get("/api/:type/history", requireNewType, (req, res) => {
  const rows = db.prepare("SELECT * FROM audit_snapshots WHERE audit_type = ? ORDER BY id DESC").all(req.params.type);
  res.json({ history: rows.map(snapshotSummary) });
});

app.get("/api/:type/history/:id", requireNewType, (req, res) => {
  const id = Number(req.params.id);
  const row = getSnapshot(id);
  if (!row || row.audit_type !== req.params.type) return res.status(404).json({ error: "Archived audit not found." });
  const items = getSnapshotItems(id);
  const amendments = db.prepare("SELECT * FROM audit_snapshot_amendments WHERE snapshot_id = ? ORDER BY id ASC").all(id);
  res.json({ ...snapshotSummary(row), items, amendments });
});

app.get("/api/:type/history/:id/pdf", requireNewType, (req, res) => {
  const typeKey = req.params.type;
  const id = Number(req.params.id);
  const snapshot = getSnapshot(id);
  if (!snapshot || snapshot.audit_type !== typeKey) return res.status(404).json({ error: "Archived audit not found." });
  const snapshotItems = getSnapshotItems(id);
  const verified = verifySnapshot(snapshot, snapshotItems);

  const items = snapshotItems.map((it) => withPhotoPaths({
    id: it.item_id,
    section: it.section,
    text: it.item_text,
    status: it.status,
    description: it.description,
    corrective_action: it.corrective_action,
    preventive_measures: it.preventive_measures,
    shift: it.shift,
    initials: it.initials,
    photos: it.photos,
    zone: it.zone,
    capa_status: it.capa_status,
  }));
  const settings = Object.assign({}, getTypeSettings(typeKey), {
    auditor: snapshot.auditor,
    audit_date: snapshot.audit_date,
    qa_initials: snapshot.qa_initials,
    reviewed_by: snapshot.reviewed_by,
    reviewed_date: snapshot.reviewed_date,
  });
  const history = {
    snapshots: getAuditSnapshots(10, id, typeKey),
    recurringIssues: getRecurringIssues(8, id, typeKey),
  };
  const archiveInfo = { archivedAt: snapshot.archived_at, verified };
  generatePdf(res, { settings, items, history, archiveInfo, auditType: req.auditType });
});

app.post("/api/:type/history/:id/signoff", requireNewType, (req, res) => {
  const typeKey = req.params.type;
  const id = Number(req.params.id);
  const snapshot = getSnapshot(id);
  if (!snapshot || snapshot.audit_type !== typeKey) return res.status(404).json({ error: "Archived audit not found." });

  const reviewedBy = String((req.body || {}).reviewed_by || "").trim();
  const reviewedDate = String((req.body || {}).reviewed_date || "").trim();
  if (!reviewedBy || !reviewedDate) {
    return res.status(400).json({ error: "Enter both a reviewer name and a date to sign off." });
  }

  const alreadySigned = !!(snapshot.reviewed_by && snapshot.reviewed_by.trim() && snapshot.reviewed_date && snapshot.reviewed_date.trim());
  if (alreadySigned) {
    if (!checkAdmin(req)) {
      return res.status(403).json({ error: "This audit is already signed off. Admin passcode required to correct it." });
    }
    const changedBy = String((req.body || {}).changed_by || "").trim() || "admin";
    if (reviewedBy !== snapshot.reviewed_by) logAmendment(id, "reviewed_by", snapshot.reviewed_by, reviewedBy, changedBy);
    if (reviewedDate !== snapshot.reviewed_date) logAmendment(id, "reviewed_date", snapshot.reviewed_date, reviewedDate, changedBy);
  }

  db.prepare("UPDATE audit_snapshots SET reviewed_by = ?, reviewed_date = ? WHERE id = ?").run(reviewedBy, reviewedDate, id);
  res.json({ ok: true, amended: alreadySigned, snapshot: snapshotSummary(getSnapshot(id)) });
});

// See the GMP /api/history/:id DELETE route above for the rationale — same
// behavior, scoped to this audit type.
app.delete("/api/:type/history/:id", requireNewType, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const snapshot = getSnapshot(id);
  if (!snapshot || snapshot.audit_type !== req.params.type) return res.status(404).json({ error: "Archived audit not found." });
  const snapshotItems = getSnapshotItems(id);
  const del = db.transaction(() => {
    snapshotItems.forEach((it) => deleteItemPhotoFiles(it.photos || []));
    db.prepare(
      "DELETE FROM audit_snapshot_item_photos WHERE snapshot_item_id IN (SELECT id FROM audit_snapshot_items WHERE snapshot_id = ?)"
    ).run(id);
    db.prepare("DELETE FROM audit_snapshot_amendments WHERE snapshot_id = ?").run(id);
    db.prepare("DELETE FROM audit_snapshot_items WHERE snapshot_id = ?").run(id);
    db.prepare("DELETE FROM audit_snapshots WHERE id = ?").run(id);
  });
  del();
  bumpRevision();
  res.json({ ok: true, deleted: id });
});

app.use("/uploads", express.static(path.join(DATA_DIR, "uploads"), { maxAge: "30d" }));
app.use(express.static(path.join(__dirname, "..", "public")));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("VF-0033 Audit Console listening on port " + PORT);
});
