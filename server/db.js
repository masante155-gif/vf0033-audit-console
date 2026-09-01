const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const SECTIONS = require("./sections-data");
const { AUDIT_TYPES, NEW_AUDIT_TYPE_KEYS } = require("./audit-types");

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
  audit_type TEXT NOT NULL DEFAULT 'gmp',
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
  notified_at TEXT,
  zone TEXT NOT NULL DEFAULT '',
  capa_status TEXT NOT NULL DEFAULT ''
);

-- Per-audit-type header + sign-off state for the two new audit types
-- (Internal, Glass & Brittle). GMP keeps using the original settings
-- table unchanged, so nothing about the live GMP form is touched by this.
-- Account-level fields (passcode, shift contacts, EmailJS config) stay
-- solely in the settings table and apply across every audit type.
CREATE TABLE IF NOT EXISTS audit_type_settings (
  audit_type TEXT PRIMARY KEY,
  eyebrow TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  subtitle TEXT NOT NULL DEFAULT '',
  auditor TEXT NOT NULL DEFAULT '',
  audit_date TEXT NOT NULL DEFAULT '',
  qa_initials TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT NOT NULL DEFAULT '',
  reviewed_date TEXT NOT NULL DEFAULT '',
  signoff_confirmed_at TEXT NOT NULL DEFAULT '',
  review_due TEXT NOT NULL DEFAULT '',
  revision_date TEXT NOT NULL DEFAULT '',
  zone_filter TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0
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
  audit_type TEXT NOT NULL DEFAULT 'gmp',
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
  photo_filename TEXT,
  zone TEXT NOT NULL DEFAULT '',
  capa_status TEXT NOT NULL DEFAULT ''
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
// Migration: multi-audit-type support. Every pre-existing row is a GMP
// item, so backfilling audit_type='gmp' (the column default) needs no
// explicit UPDATE — existing rows just read back with the default.
if (!itemColumns.includes("audit_type")) {
  db.exec("ALTER TABLE items ADD COLUMN audit_type TEXT NOT NULL DEFAULT 'gmp'");
  db.exec("CREATE INDEX IF NOT EXISTS idx_items_audit_type ON items(audit_type)");
}
if (!itemColumns.includes("zone")) {
  db.exec("ALTER TABLE items ADD COLUMN zone TEXT NOT NULL DEFAULT ''");
}
if (!itemColumns.includes("capa_status")) {
  db.exec("ALTER TABLE items ADD COLUMN capa_status TEXT NOT NULL DEFAULT ''");
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
if (!snapshotColumns.includes("audit_type")) {
  db.exec("ALTER TABLE audit_snapshots ADD COLUMN audit_type TEXT NOT NULL DEFAULT 'gmp'");
  db.exec("CREATE INDEX IF NOT EXISTS idx_snapshots_audit_type ON audit_snapshots(audit_type)");
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
if (!snapshotItemColumns.includes("zone")) {
  db.exec("ALTER TABLE audit_snapshot_items ADD COLUMN zone TEXT NOT NULL DEFAULT ''");
}
if (!snapshotItemColumns.includes("capa_status")) {
  db.exec("ALTER TABLE audit_snapshot_items ADD COLUMN capa_status TEXT NOT NULL DEFAULT ''");
}

// Both columns are guaranteed to exist by this point (fresh installs get
// them from CREATE TABLE, migrated ones from the ALTER TABLE guards above),
// so these are always safe here regardless of which path created them.
db.exec("CREATE INDEX IF NOT EXISTS idx_items_audit_type ON items(audit_type)");
db.exec("CREATE INDEX IF NOT EXISTS idx_snapshots_audit_type ON audit_snapshots(audit_type)");

// Multi-photo support: each item (and each archived snapshot item) can now
// carry several photos instead of just one. These tables are additive — the
// old single photo_filename columns above are left in place but the app
// stops writing to them, so nothing about existing rows breaks. On first
// creation only, any photo already attached under the old single-photo
// model is carried forward as photo #1 so upgrading never silently drops
// evidence that was already there.
const itemPhotosTableExisted = !!db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='item_photos'"
).get();
db.exec(`
CREATE TABLE IF NOT EXISTS item_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id),
  filename TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_item_photos_item ON item_photos(item_id);
`);
if (!itemPhotosTableExisted) {
  db.exec(`
    INSERT INTO item_photos (item_id, filename, sort_order)
    SELECT id, photo_filename, 0 FROM items WHERE photo_filename IS NOT NULL AND photo_filename != ''
  `);
}

const snapshotItemPhotosTableExisted = !!db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='audit_snapshot_item_photos'"
).get();
db.exec(`
CREATE TABLE IF NOT EXISTS audit_snapshot_item_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_item_id INTEGER NOT NULL REFERENCES audit_snapshot_items(id),
  filename TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_snapshot_item_photos_snap_item ON audit_snapshot_item_photos(snapshot_item_id);
`);
if (!snapshotItemPhotosTableExisted) {
  db.exec(`
    INSERT INTO audit_snapshot_item_photos (snapshot_item_id, filename, sort_order)
    SELECT id, photo_filename, 0 FROM audit_snapshot_items WHERE photo_filename IS NOT NULL AND photo_filename != ''
  `);
}

const settingsRow = db.prepare("SELECT id FROM settings WHERE id = 1").get();
if (!settingsRow) {
  db.prepare("INSERT INTO settings (id) VALUES (1)").run();
}

const gmpItemCount = db.prepare("SELECT COUNT(*) AS n FROM items WHERE audit_type = 'gmp'").get().n;
if (gmpItemCount === 0) {
  const insert = db.prepare(
    "INSERT INTO items (audit_type, section, sort_order, text) VALUES ('gmp', ?, ?, ?)"
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

// Seed the two new audit types' checklists (idempotent — only fires the
// first time each type has zero items) and their per-type header/sign-off
// row in audit_type_settings, from the shared config in audit-types.js.
const insertPlainItem = db.prepare(
  "INSERT INTO items (audit_type, section, sort_order, text) VALUES (?, ?, ?, ?)"
);
const insertZonedItem = db.prepare(
  "INSERT INTO items (audit_type, section, sort_order, text, zone) VALUES (?, ?, ?, ?, ?)"
);
const seedTypeItems = db.transaction((typeKey, sections, hasZoneField) => {
  let order = 0;
  for (const [section, items] of sections) {
    for (const entry of items) {
      order += 1;
      if (hasZoneField) {
        const [text, zone] = entry;
        insertZonedItem.run(typeKey, section, order, text, zone || "");
      } else {
        insertPlainItem.run(typeKey, section, order, entry);
      }
    }
  }
});
const insertTypeSettings = db.prepare(
  `INSERT INTO audit_type_settings (audit_type, eyebrow, title, subtitle, revision_date)
   VALUES (?, ?, ?, ?, ?)`
);
for (const typeKey of NEW_AUDIT_TYPE_KEYS) {
  const type = AUDIT_TYPES[typeKey];
  const count = db.prepare("SELECT COUNT(*) AS n FROM items WHERE audit_type = ?").get(typeKey).n;
  if (count === 0) {
    seedTypeItems(typeKey, type.sections, type.hasZoneField);
  }
  const settingsExists = db.prepare("SELECT 1 FROM audit_type_settings WHERE audit_type = ?").get(typeKey);
  if (!settingsExists) {
    insertTypeSettings.run(typeKey, type.defaults.eyebrow, type.defaults.title, type.defaults.subtitle, type.defaults.revision_date);
  }
}

// One-time additive migration: the Internal Audit checklist was
// restructured from 9 generic compliance categories into area-based
// sections that walk the whole plant (see internal-sections-data.js). The
// seed-on-empty path above only ever fires once per type, and this database
// already has the original 92 items — some already marked up with real
// inspection statuses and a handful of real Non-Conformance write-ups — so
// simply changing the source file wouldn't touch a live database, and a
// destructive re-seed would erase that real data. Instead this appends the
// new sections' items after whatever's already there, leaving every
// existing item (and its status/NC fields) completely untouched. Gated on a
// landmark new section name so it only ever runs once; the old categories
// stay in place until removed by hand from the app's admin panel (Delete
// section), same as any other section.
const hasNewInternalSections = db
  .prepare("SELECT 1 FROM items WHERE audit_type = 'internal' AND section = ?")
  .get("Entrance / Visitor Check-in");
if (!hasNewInternalSections) {
  const maxInternalOrder = db
    .prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM items WHERE audit_type = 'internal'")
    .get().m;
  const appendInternalSections = db.transaction((sections, startOrder) => {
    let order = startOrder;
    for (const [section, sectionItems] of sections) {
      for (const text of sectionItems) {
        order += 1;
        insertPlainItem.run("internal", section, order, text);
      }
    }
  });
  appendInternalSections(AUDIT_TYPES.internal.sections, maxInternalOrder);
}

// One-time consolidation migration: now that the area-based sections above
// cover the whole plant, most of the original 9 generic categories just
// duplicate content that now lives in a more specific area section (or is
// already covered weekly by the separate GMP Workplace Audit's "Employee
// Practices" section). This migration:
//   1. Deletes 7 categories outright — confirmed to carry zero recorded
//      inspection data, and fully superseded elsewhere.
//   2. Deletes 3 bathroom items from "Facility & Structural Conditions" —
//      duplicated by the new Restroom sections — and adds one item that had
//      no home anywhere (pest-entry sealing), keeping the rest of that
//      section as a deliberate, permanent, plant-wide (non-area) section.
//   3. Deletes 6 redundant items from "Production Line / Equipment
//      Sanitation" and RELOCATES (UPDATEs the section/sort_order of) the 4
//      that survive into "Production Line 1" — an UPDATE, not a
//      delete+reinsert, specifically so any real status/initials/corrective
//      action already recorded on those rows carries over untouched. The old
//      category then has zero items left and simply stops appearing.
//   4. Adds a handful of items (security plan, ingredient-lot traceability,
//      QA manual, pest-control PROGRAM documentation, wood pallet/transport
//      condition) that had real content but no section to live in, onto the
//      existing "Programs, Records & Policy Compliance" and "General
//      Warehouse" sections.
// Every one of these steps only deletes items confirmed to carry no status,
// description, corrective action, preventive measures, or initials — real
// data is only ever relocated (section changed in place), never deleted.
// Gated on whether the "Personnel GMP Compliance" category (deleted by step
// 1, below) still has any items — a structural check, not a text match: one
// of the very items this migration adds ("Does the plant have a security
// plan in place?") happens to already exist verbatim in the pre-consolidation
// data, so using that text as the landmark would falsely read as "already
// done" and skip the whole migration on every boot.
const consolidationDone =
  !db.prepare("SELECT 1 FROM items WHERE audit_type = 'internal' AND section = 'Personnel GMP Compliance'").get() &&
  db.prepare("SELECT 1 FROM items WHERE audit_type = 'internal'").get();
if (!consolidationDone) {
  const delByText = db.prepare(
    "DELETE FROM items WHERE audit_type = 'internal' AND section = ? AND text = ?"
  );
  const maxOrder = (section) =>
    db
      .prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM items WHERE audit_type = 'internal' AND section = ?")
      .get(section).m;

  const consolidateInternal = db.transaction(() => {
    // 1. Delete the 6 fully-redundant categories.
    const deadCategories = [
      "Personnel GMP Compliance",
      "Sanitation & Housekeeping Practices",
      "Documentation / Records / Policies",
      "Traceability & QA Systems",
      "Maintenance & Utilities Controls",
      "Exterior & Grounds Sanitation",
      "Pest Control & Facility Integrity",
    ];
    const delCategory = db.prepare("DELETE FROM items WHERE audit_type = 'internal' AND section = ?");
    deadCategories.forEach((section) => delCategory.run(section));

    // 2. Trim "Facility & Structural Conditions" to its plant-wide content.
    [
      "Are toilets and washrooms clean and orderly, adequately ventilated to the outside, physically separated from the processing areas, and properly equipped?",
      "Employee bathrooms are clean and equipped with sanitary paper, antiseptic soap, and towels or air dryers for hands. Hand-washing sinks do not require activation through the use of hands.",
      "Are hand-washing signs posted?",
    ].forEach((t) => delByText.run("Facility & Structural Conditions", t));
    let order = maxOrder("Facility & Structural Conditions");
    insertPlainItem.run(
      "internal",
      "Facility & Structural Conditions",
      ++order,
      "Are all doors, windows, and other wall/ceiling openings properly screened or sealed to prevent pest entry, with cracks and crevices caulked or repaired?"
    );

    // 3. Trim old "Production Line / Equipment Sanitation" and relocate the
    //    4 items with real content (2 of which carry real recorded data)
    //    into "Production Line 1".
    [
      "Filler room not used for storage.",
      "Are the fillers, cappers, hoppers, conveyors, bins, and chutes clean?",
      "Fill control is adequate to ensure that product average fill weights are at or above printed label declarations, and that gross under-fills are removed from the lines.",
      "Are non-food supplies stored in a separate area away from finished product?",
      "Incoming materials are free of damage or contamination?",
      "Storage areas are free of strong odors which may be observed by food products.",
    ].forEach((t) => delByText.run("Production Line / Equipment Sanitation", t));
    const relocateToPL1 = db.prepare(
      "UPDATE items SET section = 'Production Line 1', sort_order = ? WHERE audit_type = 'internal' AND section = 'Production Line / Equipment Sanitation' AND text = ?"
    );
    let plOrder = maxOrder("Production Line 1");
    [
      "Are all pipe connections and transfer hose connections leak free?",
      "All chemical spray bottles are labeled correctly and capped.",
      "Hand sink is clean, towels and soap are available. And warm water is working",
      "No busted light, no broken covers, free from infestation.",
    ].forEach((t) => relocateToPL1.run(++plOrder, t));

    // 4. Add the remaining unique content to existing sections.
    let programOrder = maxOrder("Programs, Records & Policy Compliance");
    [
      "Does the plant have a security plan in place?",
      "Is finished product traceable to the ingredient lot?",
      "Does the company have a QA manual that includes sampling plans and specifications for raw materials, packaging materials, and finished products?",
      "Is there a documented pest-control program, including rodents, birds, and insects, with service documentation signed off and followed up by management?",
      "Are examinations of traps and bait boxes documented, with a current map of trap and bait box locations available for review?",
      "Are UV traps functioning properly and cleaned regularly?",
      "Is interior and exterior trap inspection conducted at least monthly, with inspection date and inspector's initials noted at each device?",
      "Does pesticide-usage documentation include product name, EPA registration number, quantity used, areas treated, operator's name and license number, application method and rate, date treated, and copies of FDA approval and current company insurance?",
      "Is there a documented preventive-maintenance program in place, free of temporary tape, wire, or cardboard repairs?",
    ].forEach((t) => insertPlainItem.run("internal", "Programs, Records & Policy Compliance", ++programOrder, t));

    let warehouseOrder = maxOrder("General Warehouse");
    [
      "Are wood pallets maintained in good condition to prevent contamination or damage to ingredients, packaging, and product?",
      "Are non-food supplies stored in a separate area away from finished product?",
      "Is equipment used in transporting or moving raw and finished goods clean and in good working order?",
    ].forEach((t) => insertPlainItem.run("internal", "General Warehouse", ++warehouseOrder, t));
  });
  consolidateInternal();
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
