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
`);

// Migration: add notified_at to items created before this column existed.
const itemColumns = db.prepare("PRAGMA table_info(items)").all().map((c) => c.name);
if (!itemColumns.includes("notified_at")) {
  db.exec("ALTER TABLE items ADD COLUMN notified_at TEXT");
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

function bumpRevision() {
  db.prepare("UPDATE settings SET revision = revision + 1 WHERE id = 1").run();
}

module.exports = { db, bumpRevision, DATA_DIR };
