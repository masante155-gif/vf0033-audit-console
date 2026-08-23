const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const SECTIONS = require("./sections-data");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, "uploads"), { recursive: true });

const dbPath = path.join(DATA_DIR, "audit.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  eyebrow TEXT NOT NULL DEFAULT 'VF-0033-00 · GMP Workplace Inspection · Shared Live Record',
  title TEXT NOT NULL DEFAULT 'Floor Audit Console',
  subtitle TEXT NOT NULL DEFAULT 'Mark an item “U” to open it on the Non-Conformance Log. Everyone sees the same log.',
  auditor TEXT NOT NULL DEFAULT '',
  audit_date TEXT NOT NULL DEFAULT '',
  qa_initials TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT NOT NULL DEFAULT '',
  reviewed_date TEXT NOT NULL DEFAULT '',
  signoff_confirmed_at TEXT NOT NULL DEFAULT '',
  review_due TEXT NOT NULL DEFAULT '',
  revision_date TEXT NOT NULL DEFAULT '02/06/2026',
  passcode TEXT NOT NULL DEFAULT 'GMP2026',
  shift1_name TEXT NOT NULL DEFAULT 'A',
  shift1_email TEXT NOT NULL DEFAULT '',
  shift2_name TEXT NOT NULL DEFAULT 'B',
  shift2_email TEXT NOT NULL DEFAULT '',
  shift3_name TEXT NOT NULL DEFAULT 'C',
  shift3_email TEXT NOT NULL DEFAULT '',
  shift4_name TEXT NOT NULL DEFAULT 'D',
  shift4_email TEXT NOT NULL DEFAULT '',
  shift1_lead_email TEXT NOT NULL DEFAULT '',
  shift2_lead_email TEXT NOT NULL DEFAULT '',
  shift3_lead_email TEXT NOT NULL DEFAULT '',
  shift4_lead_email TEXT NOT NULL DEFAULT '',
  emailjs_service_id TEXT NOT NULL DEFAULT '',
  emailjs_template_id TEXT NOT NULL DEFAULT '',
  emailjs_public_key TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  section TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  corrective_action TEXT NOT NULL DEFAULT '',
  preventive_measures TEXT NOT NULL DEFAULT '',
  shift INTEGER,
  initials TEXT NOT NULL DEFAULT '',
  photo_filename TEXT,
  notified_at TEXT
);

CREATE TABLE IF NOT EXISTS departments (
  section TEXT PRIMARY KEY,
  head_email TEXT NOT NULL DEFAULT '',
  is_production_line INTEGER NOT NULL DEFAULT 0
);

-- One row per archived audit ("New Audit" snapshots the live log here
-- before clearing it), so pass rates and recurring issues can be trended
-- over time instead of being lost on every reset.
CREATE TABLE IF NOT EXISTS audit_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_date TEXT NOT NULL DEFAULT '',
  auditor TEXT NOT NULL DEFAULT '',
  qa_initials TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT NOT NULL DEFAULT '',
  reviewed_date TEXT NOT NULL DEFAULT '',
  archived_at TEXT NOT NULL DEFAULT (datetime('now')),
  total INTEGER NOT NULL DEFAULT 0,
  accepted INTEGER NOT NULL DEFAULT 0,
  unacceptable INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL DEFAULT ''
);

-- Frozen copy of every checklist item's result at the moment an audit was
-- archived. item_id is kept for reference but section + item_text are the
-- durable join keys, since checklist items can be edited or added later.
CREATE TABLE IF NOT EXISTS audit_snapshot_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL REFERENCES audit_snapshots(id),
  item_id INTEGER,
  section TEXT NOT NULL,
  item_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  corrective_action TEXT NOT NULL DEFAULT '',
  preventive_measures TEXT NOT NULL DEFAULT '',
  shift INTEGER,
  initials TEXT NOT NULL DEFAULT '',
  photo_filename TEXT
);
CREATE INDEX IF NOT EXISTS idx_snapshot_items_snapshot ON audit_snapshot_items(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_snapshot_items_status ON audit_snapshot_items(status);

-- Append-only correction trail. A sign-off, once recorded, is never
-- silently overwritten — changing one logs the before/after here instead,
-- so the history stays honest even when a mistake needs fixing later.
CREATE TABLE IF NOT EXISTS audit_snapshot_amendments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL REFERENCES audit_snapshots(id),
  field TEXT NOT NULL,
  old_value TEXT NOT NULL DEFAULT '',
  new_value TEXT NOT NULL DEFAULT '',
  changed_by TEXT NOT NULL DEFAULT '',
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_snapshot_amendments_snapshot ON audit_snapshot_amendments(snapshot_id);
`);

// Migration: add notified_at to items created before this column existed.
const itemColumns = db.prepare("PRAGMA table_info(items)").all().map((c) => c.name);
if (!itemColumns.includes("notified_at")) {
  db.exec("ALTER TABLE items ADD COLUMN notified_at TEXT");
}

// Migration: add EmailJS config + shift lead columns to settings rows created before they existed.
const settingsColumns = db.prepare("PRAGMA table_info(settings)").all().map((c) => c.name);
for (const col of [
  "emailjs_service_id", "emailjs_template_id", "emailjs_public_key",
  "shift1_lead_email", "shift2_lead_email", "shift3_lead_email", "shift4_lead_email",
  "signoff_confirmed_at",
]) {
  if (!settingsColumns.includes(col)) {
    db.exec("ALTER TABLE settings ADD COLUMN " + col + " TEXT NOT NULL DEFAULT ''");
  }
}

// Migration: widen audit_snapshots/audit_snapshot_items for deployments that
// already created these tables before qa_initials/content_hash/NC-detail
// columns were added.
const snapshotColumns = db.prepare("PRAGMA table_info(audit_snapshots)").all().map((c) => c.name);
for (const col of ["qa_initials", "content_hash"]) {
  if (!snapshotColumns.includes(col)) {
    db.exec("ALTER TABLE audit_snapshots ADD COLUMN " + col + " TEXT NOT NULL DEFAULT ''");
  }
}
const snapshotItemColumns = db.prepare("PRAGMA table_info(audit_snapshot_items)").all().map((c) => c.name);
for (const col of ["description", "corrective_action", "preventive_measures"]) {
  if (!snapshotItemColumns.includes(col)) {
    db.exec("ALTER TABLE audit_snapshot_items ADD COLUMN " + col + " TEXT NOT NULL DEFAULT ''");
  }
}
if (!snapshotItemColumns.includes("photo_filename")) {
  db.exec("ALTER TABLE audit_snapshot_items ADD COLUMN photo_filename TEXT");
}

const settingsRow = db.prepare("SELECT id FROM settings WHERE id = 1").get();
if (!settingsRow) {
  db.prepare("INSERT INTO settings (id) VALUES (1)").run();
}

const itemCount = db.prepare("SELECT COUNT(*) AS n FROM items").get().n;
if (itemCount === 0) {
  const insert = db.prepare(
    "INSERT INTO items (section, sort_order, text) VALUES (?, ?, ?)"
  );
  const insertMany = db.transaction((rows) => {
    let order = 0;
    for (const [section, items] of rows) {
      for (const text of items) {
        order += 1;
        insert.run(section, order, text);
      }
    }
  });
  insertMany(SECTIONS);
}

// Seed one department row per checklist section (each section IS a
// department). Idempotent, so it also fills in any section added later.
const deptInsert = db.prepare("INSERT OR IGNORE INTO departments (section) VALUES (?)");
const deptSeed = db.transaction((rows) => {
  for (const [section] of rows) deptInsert.run(section);
});
deptSeed(SECTIONS);

function bumpRevision() {
  db.prepare("UPDATE settings SET revision = revision + 1 WHERE id = 1").run();
}

module.exports = { db, bumpRevision, DATA_DIR };
