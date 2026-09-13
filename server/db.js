const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const SECTIONS = require("./sections-data");
const { AUDIT_TYPES, NEW_AUDIT_TYPE_KEYS } = require("./audit-types");

const TRAINING_QUESTIONS = require("./training-questions-data");

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

// Migration: the weekly Safety & Food Culture Training question now lives
// inside the Daily Safety Walk itself (a Sign-Off gate, same mechanism as
// unacknowledged deviations) instead of only in its own tab. This column
// records which week's training question (by the same week-key
// index.js computes) was last answered for the CURRENT, not-yet-archived
// safety walk — reset to '' on every "New Audit" so each fresh walk
// requires answering again, per "one question per walk."
const auditTypeSettingsColumns = db.prepare("PRAGMA table_info(audit_type_settings)").all().map((c) => c.name);
if (!auditTypeSettingsColumns.includes("training_week_key")) {
  db.exec("ALTER TABLE audit_type_settings ADD COLUMN training_week_key TEXT NOT NULL DEFAULT ''");
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

// Mentra glasses AI spot-check log (prototype). Each row is one on-demand
// "check this" trigger from the glasses: what the auditor said, the photo
// it captured, and the AI's one-line read on whether it looks like a
// non-conformance. Deliberately its own simple log rather than writing
// into `items`/NC fields directly — see server/index.js's /api/mentra/flag
// handler for why (each checklist item only holds one open NC at a time,
// so auto-attaching a guessed item risked silently overwriting a real one).
db.exec(`
CREATE TABLE IF NOT EXISTS mentra_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transcript TEXT NOT NULL DEFAULT '',
  photo_filename TEXT NOT NULL,
  flagged INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mentra_flags_created ON mentra_flags(created_at);
`);

// Safety & Food Culture Training — its own standalone branch, separate from
// the checklist-based audit types above (no pass/fail items, no sections).
// training_questions is the one mixed pool of OSHA-safety and food-safety-
// culture/HACCP multiple-choice questions; which one is "this week's"
// question is computed deterministically in index.js (a whole-weeks-since-
// epoch index modulo the active question count) rather than stored here, so
// every device shows the same question without a "current question" row to
// keep in sync. training_responses is an append-only log of every time
// someone answers during a walk — intentionally not deduplicated per
// person/week, since the request was "one question per walk, answer
// required to proceed," not "once per week total."
db.exec(`
CREATE TABLE IF NOT EXISTS training_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL,
  option_a TEXT NOT NULL,
  option_b TEXT NOT NULL,
  option_c TEXT NOT NULL,
  correct_option TEXT NOT NULL,
  explanation TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_training_questions_active ON training_questions(active);

CREATE TABLE IF NOT EXISTS training_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES training_questions(id),
  week_key TEXT NOT NULL DEFAULT '',
  shift INTEGER,
  initials TEXT NOT NULL DEFAULT '',
  selected_option TEXT NOT NULL,
  is_correct INTEGER NOT NULL DEFAULT 0,
  question_prompt TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_training_responses_week ON training_responses(week_key);
CREATE INDEX IF NOT EXISTS idx_training_responses_question ON training_responses(question_id);
`);

// Seed the starting question bank the first time the table is empty. After
// that, the database (not training-questions-data.js) is the source of
// truth — admins manage it from the Training tab's Admin panel.
const trainingQuestionCount = db.prepare("SELECT COUNT(*) AS n FROM training_questions").get().n;
if (trainingQuestionCount === 0) {
  const insertTrainingQuestion = db.prepare(
    `INSERT INTO training_questions
       (category, prompt, option_a, option_b, option_c, correct_option, explanation, sort_order, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
  );
  const seedTrainingQuestions = db.transaction((rows) => {
    let order = 0;
    for (const q of rows) {
      order += 1;
      insertTrainingQuestion.run(
        q.category || "",
        q.prompt,
        q.options.A,
        q.options.B,
        q.options.C,
        q.correct,
        q.explanation || "",
        order
      );
    }
  });
  seedTrainingQuestions(TRAINING_QUESTIONS);
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

// One-time additive/consolidation migration for the GMP Workplace Audit,
// per updated instructions relayed from the site's safety chairwoman
// (Sept 2026):
//   1. Relabels "Warehouse (Materials Receiving, Storage & Distribution)"
//      as "Warehouse / Walker" — content unchanged, name only.
//   2. Merges "Laboratory" + "Chemical, Mineral & Non-Product Material
//      Storage" into one "QA / Chemical Storage" area.
//   3. Merges "Water Processing Area (...)" + "Compressor and Chiller"
//      into one "Water Processing / Compressor & Chiller" area.
//   4. Relabels "Main Office Area" as "Maintenance / Boneyard / Office"
//      and adds the 7 new Boneyard items the chairwoman specified.
//   5. Adds a brand-new "Injection / Regrind" area — no existing GMP
//      section covered injection molding/regrind, so these items are
//      drawn from the Internal Audit's Husky Area 1/2 + Regrind Area
//      content, reworded to GMP's declarative style and focused on
//      OSHA machine-safety topics (guarding, e-stops/interlocks, leaks),
//      per direction to keep this checklist safety/OSHA-focused.
//   6. Adds a fresh copy of the 5 Employee Practices items to every one
//      of the above areas, plus to Production PET 1 and PET 2 (which
//      otherwise keep their own identity and stay separately tracked —
//      "combined" only in the sense that they already sit side by side).
//      The original "Employee Practices (All Areas)" section is left
//      completely untouched, so it still exists on its own; it's now
//      redundant with the per-area copies and can be deleted from Admin
//      once confirmed no in-progress week has data on it.
// As with the Internal Audit consolidation above: every existing item is
// only ever RELOCATED (section renamed in place via UPDATE, never
// deleted-and-reinserted), so any in-progress status/description/
// corrective-action/initials on a live item carries over untouched. Only
// brand-new content (Boneyard, Injection/Regrind, Employee Practices
// copies) is inserted fresh. Gated on a structural landmark ("Injection /
// Regrind" existing), not on item text.
const gmpChairwomanUpdateDone = db
  .prepare("SELECT 1 FROM items WHERE audit_type = 'gmp' AND section = 'Injection / Regrind'")
  .get();
if (!gmpChairwomanUpdateDone) {
  const sectionExists = (section) =>
    !!db.prepare("SELECT 1 FROM items WHERE audit_type = 'gmp' AND section = ?").get(section);
  const renameGmpSection = db.prepare(
    "UPDATE items SET section = ? WHERE audit_type = 'gmp' AND section = ?"
  );
  const carryDeptInto = (oldSection, newSection) => {
    const old = db.prepare("SELECT * FROM departments WHERE section = ?").get(oldSection);
    if (!old) return;
    const existingNew = db.prepare("SELECT * FROM departments WHERE section = ?").get(newSection);
    if (!existingNew) {
      db.prepare(
        "INSERT INTO departments (section, head_email, is_production_line) VALUES (?, ?, ?)"
      ).run(newSection, old.head_email || "", old.is_production_line || 0);
    } else if (!existingNew.head_email && old.head_email) {
      db.prepare("UPDATE departments SET head_email = ? WHERE section = ?").run(old.head_email, newSection);
    }
  };
  const dropOrphanDept = (oldSection) => {
    if (!sectionExists(oldSection)) {
      db.prepare("DELETE FROM departments WHERE section = ?").run(oldSection);
    }
  };
  const ensureDept = db.prepare("INSERT OR IGNORE INTO departments (section) VALUES (?)");

  const OLD_WAREHOUSE = "Warehouse (Materials Receiving, Storage & Distribution)";
  const OLD_LAB = "Laboratory";
  const OLD_CHEMICAL = "Chemical, Mineral & Non-Product Material Storage";
  const OLD_OFFICE = "Main Office Area";
  const OLD_WATER = "Water Processing Area (RO / Filtration / Mineral Injection / Utilities)";
  const OLD_COMPRESSOR = "Compressor and Chiller";
  const PET1 = "Production: PET 1, HuskyFiller/Cappers/Cap Hopper/Labeler/Case Packer/Palletizer";
  const PET2 = "Production: PET 2, HuskyFiller/Cappers/Cap Hopper/Labeler/Case Packer/Palletizer";
  const NEW_WAREHOUSE = "Warehouse / Walker";
  const NEW_QA = "QA / Chemical Storage";
  const NEW_MAINTENANCE = "Maintenance / Boneyard / Office";
  const NEW_WATER = "Water Processing / Compressor & Chiller";
  const NEW_INJECTION = "Injection / Regrind";

  const EMPLOYEE_PRACTICES = [
    "Employees are following good hand washing procedures.",
    "Employees are not wearing jewelry or nail polish and all items are below the waist.",
    "No evidence of employees chewing gum or eating out on the lines.",
    "No personal items (phones, keys, wallets) in GMP areas",
    "Employees are wearing hairnets and beardnets properly. Wound(s) are covered with bandaged protected with rubber gloves.",
  ];

  const BONEYARD_ITEMS = [
    "Floors are clean, dry, and free of oil, grease, water, condensate, or debris.",
    "Maintenance tools used are stored properly and segregated as required.",
    "Hoses are properly connected during use, capped where applicable, and stored off the floor when not in use.",
    "Lubricants, refrigerants, oils, and maintenance chemicals are properly stored.",
    "Chemical containers are properly labeled, capped, and not leaking.",
    "Trash containers are available at points of use, covered where required, and not overflowing.",
    "Walkway is available, free of debris and obstruction in front of Boneyard.",
  ];

  const INJECTION_REGRIND_ITEMS = [
    "Machine guards, disconnect panels, and safety interlocks are in place, secured, and functioning.",
    "HMI and control panels are functioning and free of fault alarms.",
    "E-stops and safety interlocks are tested and functioning.",
    "Conveyor covers and drive guards are intact and properly secured.",
    "Grinder is guarded, with no damaged or missing blades or covers; blender and deduster are clean and free of excessive dust buildup.",
    "Machines are free of hydraulic, oil, or other fluid leaks.",
    "Hoses and tools are stored properly rather than left exposed on or around the machine.",
    "Area is free of spilled resin, preforms, regrind material, plastic shavings, and debris.",
    "Only approved non-conforming plastics/preforms are fed into the regrind system, with no foreign material.",
    "Regrind material is stored in labeled, covered containers to prevent contamination.",
    "Preventive-maintenance program is documented and current, with no tape, wire, or cardboard repairs in use.",
    "Electrical panels and covers are intact with no exposed wiring; overhead lights are in good repair and properly shielded.",
  ];

  const runGmpChairwomanUpdate = db.transaction(() => {
    let order = db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM items WHERE audit_type = 'gmp'").get().m;
    const addEmployeePracticesTo = (section) => {
      EMPLOYEE_PRACTICES.forEach((text) => {
        order += 1;
        insertPlainItem.run("gmp", section, order, text);
      });
    };

    // 1. Warehouse -> Warehouse / Walker.
    if (sectionExists(OLD_WAREHOUSE)) {
      renameGmpSection.run(NEW_WAREHOUSE, OLD_WAREHOUSE);
      carryDeptInto(OLD_WAREHOUSE, NEW_WAREHOUSE);
    }
    ensureDept.run(NEW_WAREHOUSE);
    addEmployeePracticesTo(NEW_WAREHOUSE);

    // 2. Laboratory + Chemical Storage -> QA / Chemical Storage.
    if (sectionExists(OLD_CHEMICAL)) {
      renameGmpSection.run(NEW_QA, OLD_CHEMICAL);
      carryDeptInto(OLD_CHEMICAL, NEW_QA);
    }
    if (sectionExists(OLD_LAB)) {
      renameGmpSection.run(NEW_QA, OLD_LAB);
      carryDeptInto(OLD_LAB, NEW_QA);
    }
    ensureDept.run(NEW_QA);
    addEmployeePracticesTo(NEW_QA);

    // 3. Main Office Area -> Maintenance / Boneyard / Office, + new Boneyard items.
    if (sectionExists(OLD_OFFICE)) {
      renameGmpSection.run(NEW_MAINTENANCE, OLD_OFFICE);
      carryDeptInto(OLD_OFFICE, NEW_MAINTENANCE);
    }
    ensureDept.run(NEW_MAINTENANCE);
    BONEYARD_ITEMS.forEach((text) => {
      order += 1;
      insertPlainItem.run("gmp", NEW_MAINTENANCE, order, text);
    });
    addEmployeePracticesTo(NEW_MAINTENANCE);

    // 4. Water Processing + Compressor and Chiller -> Water Processing / Compressor & Chiller.
    if (sectionExists(OLD_WATER)) {
      renameGmpSection.run(NEW_WATER, OLD_WATER);
      carryDeptInto(OLD_WATER, NEW_WATER);
    }
    if (sectionExists(OLD_COMPRESSOR)) {
      renameGmpSection.run(NEW_WATER, OLD_COMPRESSOR);
      carryDeptInto(OLD_COMPRESSOR, NEW_WATER);
    }
    ensureDept.run(NEW_WATER);
    addEmployeePracticesTo(NEW_WATER);

    // 5. New Injection / Regrind area.
    INJECTION_REGRIND_ITEMS.forEach((text) => {
      order += 1;
      insertPlainItem.run("gmp", NEW_INJECTION, order, text);
    });
    ensureDept.run(NEW_INJECTION);
    addEmployeePracticesTo(NEW_INJECTION);

    // 6. Production PET 1 & PET 2 keep their own identity/content — just add
    //    the shared Employee Practices copy to each.
    if (sectionExists(PET1)) addEmployeePracticesTo(PET1);
    if (sectionExists(PET2)) addEmployeePracticesTo(PET2);

    // Drop department rows left orphaned by the renames/merges above (their
    // contact info, if any, was already carried forward by carryDeptInto).
    [OLD_WAREHOUSE, OLD_LAB, OLD_CHEMICAL, OLD_OFFICE, OLD_WATER, OLD_COMPRESSOR].forEach(dropOrphanDept);
  });
  runGmpChairwomanUpdate();
}

// One-time restructuring of the Daily Safety Walk's zones (Sept 2026), to
// follow the plant's actual walking route per the updated VR-0042-00 Fire
// Evacuation Plan (the "Safe Walking Area" line). Splits three combined
// zones into the individually-labeled rooms the drawing shows —
// "Injection / Regrind" into Regrind Room + Husky 1 + Husky 2 (a brand-new
// second stop, since the old zone only ever covered one machine's worth of
// items); "Water Processing / Compressor & Chiller" into Compressor &
// Chiller Area + Water In-Process Areas; "QA / Chemical Storage /
// Maintenance / Boneyard / Office" into QA Lab / Chemical Storage +
// Maintenance Shop — and adds two stops that weren't checklist zones
// before (Preforms, Offices/Breakroom/Restrooms), all reordered into one
// walking sequence so stop-to-stop movement naturally covers the aisles in
// between, not just the labeled rooms. As with the GMP migration above,
// every existing item is only ever RELOCATED via UPDATE (matched by its
// exact old section + text), never deleted-and-reinserted, so any
// in-progress status/description/photo on a live item carries over
// untouched; only genuinely new content is inserted fresh. Every item
// (including the three zones that keep their name/text as-is — General,
// Production Line 1, Production Line 2) gets a freshly assigned
// sort_order reflecting the new walking order, since the old per-zone
// ordering no longer lines up with it. Gated on a structural landmark
// ("Husky 1 (Injection — PET 1)" existing), not on item text.
const safetyWalkRouteUpdateDone = db
  .prepare("SELECT 1 FROM items WHERE audit_type = 'safety' AND section = 'Husky 1 (Injection — PET 1)'")
  .get();
if (!safetyWalkRouteUpdateDone) {
  const safetySectionExists = (section) =>
    !!db.prepare("SELECT 1 FROM items WHERE audit_type = 'safety' AND section = ?").get(section);
  const relocateSafetyItem = db.prepare(
    "UPDATE items SET section = ?, text = ? WHERE audit_type = 'safety' AND section = ? AND text = ? AND sort_order = (" +
      "SELECT MIN(sort_order) FROM items WHERE audit_type = 'safety' AND section = ? AND text = ?" +
    ")"
  );
  const resortSafetyItem = db.prepare("UPDATE items SET sort_order = ? WHERE id = ?");
  const insertSafetyItem = db.prepare(
    "INSERT INTO items (audit_type, section, sort_order, text) VALUES ('safety', ?, ?, ?)"
  );
  const fanOutDeptInto = (oldSection, newSections) => {
    const old = db.prepare("SELECT * FROM departments WHERE section = ?").get(oldSection);
    if (!old) return;
    newSections.forEach((newSection) => {
      const existingNew = db.prepare("SELECT * FROM departments WHERE section = ?").get(newSection);
      if (!existingNew) {
        db.prepare(
          "INSERT INTO departments (section, head_email, is_production_line) VALUES (?, ?, ?)"
        ).run(newSection, old.head_email || "", old.is_production_line || 0);
      } else if (!existingNew.head_email && old.head_email) {
        db.prepare("UPDATE departments SET head_email = ? WHERE section = ?").run(old.head_email, newSection);
      }
    });
  };
  // departments is keyed by section name only, with no audit_type column —
  // it's shared across every audit type, so a name freed up by this safety
  // migration (e.g. "Injection / Regrind") can still be in active use by a
  // completely different audit type (GMP has its own "Injection / Regrind"
  // section from its own restructuring above). Only drop the row once
  // nothing anywhere still points at that name, or this would silently
  // wipe out another program's configured department contact.
  const dropOrphanSafetyDept = (oldSection) => {
    const stillUsed = !!db.prepare("SELECT 1 FROM items WHERE section = ?").get(oldSection);
    if (!stillUsed) {
      db.prepare("DELETE FROM departments WHERE section = ?").run(oldSection);
    }
  };
  const ensureSafetyDept = db.prepare("INSERT OR IGNORE INTO departments (section) VALUES (?)");

  const OLD_INJECTION_REGRIND = "Injection / Regrind";
  const OLD_WATER_COMPRESSOR = "Water Processing / Compressor & Chiller";
  const OLD_QA_MAINT = "QA / Chemical Storage / Maintenance / Boneyard / Office";
  const OLD_WAREHOUSE = "Warehouse / Walker";

  // Each group is one new zone, in final walking order. Every entry is
  // [oldSection, oldText, newText] to relocate an existing row, or
  // [null, null, newText] to insert brand-new content.
  const ROUTE = [
    ["General / Plant-Wide Safety", [
      ["General / Plant-Wide Safety", "Primary and secondary emergency exits are unobstructed, unlocked from the inside, and clearly marked with illuminated exit signs.", "Primary and secondary emergency exits are unobstructed, unlocked from the inside, and clearly marked with illuminated exit signs."],
      ["General / Plant-Wide Safety", "Evacuation routes and the emergency assembly point are posted and current.", "Evacuation routes and the emergency assembly point are posted and current."],
      ["General / Plant-Wide Safety", "Fire extinguishers are inspected/tagged within the last 12 months, fully charged, unobstructed, and mounted at proper height.", "Fire extinguishers are inspected/tagged within the last 12 months, fully charged, unobstructed, and mounted at proper height."],
      ["General / Plant-Wide Safety", "Sprinkler heads and fire alarm pull stations are unobstructed (18-inch clearance) and undamaged.", "Sprinkler heads and fire alarm pull stations are unobstructed (18-inch clearance) and undamaged."],
      ["General / Plant-Wide Safety", "First aid kit is stocked, accessible, and its contents are within date.", "First aid kit is stocked, accessible, and its contents are within date."],
      ["General / Plant-Wide Safety", "Eyewash/emergency shower stations plant-wide are unobstructed, tested/tagged current, and flush freely.", "Eyewash/emergency shower stations plant-wide are unobstructed, tested/tagged current, and flush freely."],
      ["General / Plant-Wide Safety", "Aisles, walkways, and stairways are clear of clutter, cords, and slip/trip hazards.", "Aisles, walkways, and stairways are clear of clutter, cords, and slip/trip hazards."],
      ["General / Plant-Wide Safety", "Stairs and elevated platforms have handrails/guardrails in good condition.", "Stairs and elevated platforms have handrails/guardrails in good condition."],
      ["General / Plant-Wide Safety", "Required PPE (safety glasses, hearing protection, gloves, steel-toe boots) is being worn correctly in posted PPE areas.", "Required PPE (safety glasses, hearing protection, gloves, steel-toe boots) is being worn correctly in posted PPE areas."],
      ["General / Plant-Wide Safety", "High-noise areas are posted, and hearing protection is available and used.", "High-noise areas are posted, and hearing protection is available and used."],
      ["General / Plant-Wide Safety", "SDS binder or electronic HazCom system is accessible and current for every chemical on-site.", "SDS binder or electronic HazCom system is accessible and current for every chemical on-site."],
      ["General / Plant-Wide Safety", "Confined-space entry points (tanks, silos, pits) are labeled, and entry follows permit-required confined-space procedure.", "Confined-space entry points (tanks, silos, pits) are labeled, and entry follows permit-required confined-space procedure."],
      ["General / Plant-Wide Safety", "Hazard/near-miss reporting log is available and being used.", "Hazard/near-miss reporting log is available and being used."],
    ]],
    ["Compressor & Chiller Area", [
      [OLD_WATER_COMPRESSOR, "No pressurized-air, refrigerant, or hot-water leaks are observed.", "No refrigerant or pressurized-air leaks are observed from compressors, chillers, or supply lines."],
      [OLD_WATER_COMPRESSOR, "Pressure vessels/receivers display a current inspection tag; relief valves are unobstructed and intact.", "Air receivers and pressure vessels display a current inspection tag; relief valves are unobstructed and intact."],
      [OLD_WATER_COMPRESSOR, "Guards are in place on belts, pulleys, and fan blades for compressors and chillers.", "Guards are in place on belts, pulleys, and fan blades for compressors and chillers."],
      [OLD_WATER_COMPRESSOR, "Lockout/tagout points are identified and used when servicing pumps, compressors, or chillers.", "Lockout/tagout points are identified and used when servicing compressors or chillers."],
      [OLD_WATER_COMPRESSOR, "Refrigerant system placards and labels are present and legible.", "Refrigerant system placards and labels are present and legible."],
      [OLD_WATER_COMPRESSOR, "Hearing protection is posted/available where compressor noise requires it.", "Hearing protection is posted/available where compressor noise requires it."],
      [null, null, "Floor around compressors/chillers is dry and free of refrigerant, oil, or condensate residue."],
    ]],
    ["Regrind Room", [
      [OLD_INJECTION_REGRIND, "Lockout/tagout procedure is posted and followed before clearing jams or servicing the grinder or molder.", "Lockout/tagout procedure is posted and followed before clearing jams or servicing the grinder."],
      [OLD_INJECTION_REGRIND, "Grinder blades/guards are intact, with no exposed moving parts, and the hopper interlock functions.", "Grinder blades/guards are intact, with no exposed moving parts, and the hopper interlock functions."],
      [OLD_INJECTION_REGRIND, "Dust collection/deduster is functioning, with no excessive airborne dust buildup.", "Dust collection/deduster is functioning, with no excessive airborne dust buildup."],
      [OLD_INJECTION_REGRIND, "Area is free of slip/trip hazards from spilled resin or regrind material.", "Area is free of slip/trip hazards from spilled resin or regrind material, and hoses/tools are stored properly rather than left on the floor."],
    ]],
    ["Water In-Process Areas", [
      [null, null, "No hot-water, RO, or process-line leaks are observed."],
      [OLD_WATER_COMPRESSOR, "Confined-space tanks or silos are labeled, and entry follows permit-required confined-space procedure.", "Confined-space tanks or silos are labeled, and entry follows permit-required confined-space procedure."],
      [null, null, "Lockout/tagout points are identified and used when servicing process pumps."],
      [OLD_WATER_COMPRESSOR, "Floors are dry, free of standing water or condensate that could cause a slip.", "Floors are dry, free of standing water or condensate that could cause a slip."],
    ]],
    ["QA Lab / Chemical Storage", [
      [OLD_QA_MAINT, "Chemical containers are labeled per Hazard Communication (product identity + hazard warning), capped, and show no leaks or spills.", "Chemical containers are labeled per Hazard Communication (product identity + hazard warning), capped, and show no leaks or spills."],
      [OLD_QA_MAINT, "SDS sheets are available on-site for every chemical stored or used in this area.", "SDS sheets are available on-site for every chemical stored or used in this area."],
      [OLD_QA_MAINT, "Incompatible chemicals (acids/bases, oxidizers) are segregated per their SDS.", "Incompatible chemicals (acids/bases, oxidizers) are segregated per their SDS."],
      [OLD_QA_MAINT, "PPE for chemical handling (gloves, goggles, apron) is available at the point of use and being worn.", "PPE for chemical handling (gloves, goggles, apron) is available at the point of use and being worn."],
      [OLD_QA_MAINT, "Eyewash/emergency shower station in this area is unobstructed, tested, and functional.", "Eyewash/emergency shower station in this area is unobstructed, tested, and functional."],
      [null, null, "QA Lab reagents and glassware are stored securely, with lab PPE (goggles, gloves) available and worn during testing."],
    ]],
    ["Husky 1 (Injection — PET 1)", [
      [OLD_INJECTION_REGRIND, "Machine guards and disconnect panels are in place and secured.", "Machine guards and disconnect panels are in place and secured."],
      [OLD_INJECTION_REGRIND, "Barrel/nozzle heater areas carry a burn-hazard warning and are shielded from incidental contact.", "Barrel/nozzle heater areas carry a burn-hazard warning and are shielded from incidental contact."],
      [OLD_INJECTION_REGRIND, "Electrical panels and covers are intact with no exposed wiring.", "Electrical panels and covers are intact with no exposed wiring."],
      [OLD_INJECTION_REGRIND, "Hoses and tools are stored properly rather than left exposed on or around the machine.", "Hoses and tools are stored properly rather than left exposed on or around the machine."],
      [null, null, "Lockout/tagout procedure is posted and followed before clearing jams or servicing the injection molder."],
      [null, null, "Area around the machine is free of slip/trip hazards from spilled resin, oil, or product."],
    ]],
    ["Dock Space / Warehouse", [
      [OLD_WAREHOUSE, "Aisles, walkways, and dock areas are clear of trip hazards, spills, and obstructions.", "Aisles, walkways, and dock areas are clear of trip hazards, spills, and obstructions."],
      [OLD_WAREHOUSE, "Powered industrial trucks (forklifts) show no fuel/hydraulic/battery leaks and have working horn, lights, and backup alarm.", "Powered industrial trucks (forklifts) show no fuel/hydraulic/battery leaks and have working horn, lights, and backup alarm."],
      [OLD_WAREHOUSE, "Only certified operators drive forklifts, and seatbelts are worn.", "Only certified operators drive forklifts, and seatbelts are worn."],
      [OLD_WAREHOUSE, "Racking is labeled with load capacity, and stacked materials are stable, undamaged, and not overloaded.", "Racking is labeled with load capacity, and stacked materials are stable, undamaged, and not overloaded."],
      [OLD_WAREHOUSE, "Dock plates/levelers are secured and rated for the load; trailer wheels are chocked at the dock.", "Dock plates/levelers are secured and rated for the load; trailer wheels are chocked at the dock."],
      [OLD_WAREHOUSE, "Pedestrian and forklift traffic lanes are marked and kept separate where possible.", "Pedestrian and forklift traffic lanes are marked and kept separate where possible."],
      [OLD_WAREHOUSE, "Forklift battery-charging area is ventilated, has eyewash access nearby, and posts no smoking/open flame.", "Forklift battery-charging area is ventilated, has eyewash access nearby, and posts no smoking/open flame."],
      [OLD_WAREHOUSE, "PPE for battery servicing (apron, face shield, gloves) is available and used.", "PPE for battery servicing (apron, face shield, gloves) is available and used."],
    ]],
    ["Maintenance Shop", [
      [OLD_QA_MAINT, "Electrical panels/disconnects have clear working space (36 inches), intact covers, labeled breakers, no exposed wiring.", "Electrical panels/disconnects have clear working space (36 inches), intact covers, labeled breakers, no exposed wiring."],
      [OLD_QA_MAINT, "Hand and power tools are in good condition; damaged tools are tagged out of service.", "Hand and power tools are in good condition; damaged tools are tagged out of service."],
      [OLD_QA_MAINT, "Lockout/tagout devices and a lockout station are available for equipment serviced in this area.", "Lockout/tagout devices and a lockout station are available for equipment serviced here."],
      [null, null, "Floors are clean, dry, and free of oil, grease, water, condensate, or debris."],
      [null, null, "Maintenance tools and hoses are stored properly — hoses capped and off the floor when not in use, tools segregated as required."],
      [null, null, "Lubricants, refrigerants, oils, and maintenance chemicals are properly stored, with containers labeled, capped, and not leaking."],
      [null, null, "Trash containers are available at points of use, covered where required, and not overflowing."],
      [OLD_QA_MAINT, "Walkway in front of Boneyard is clear of debris and obstruction.", "Walkway in front of the Boneyard/maintenance staging area is clear of debris and obstruction."],
      [OLD_QA_MAINT, "Compressed-gas cylinders, if present, are secured upright with caps on when not in use.", "Compressed-gas cylinders, if present, are secured upright with caps on when not in use."],
    ]],
    ["Production Line 1 (PET 1)", [
      ["Production Line 1 (PET 1)", "Machine guards, light curtains, and door interlocks are in place, undamaged, and functioning.", "Machine guards, light curtains, and door interlocks are in place, undamaged, and functioning."],
      ["Production Line 1 (PET 1)", "Point-of-operation nip points, pinch points, and rotating parts are guarded.", "Point-of-operation nip points, pinch points, and rotating parts are guarded."],
      ["Production Line 1 (PET 1)", "Lockout/tagout procedure is posted at the machine and followed for servicing or clearing jams.", "Lockout/tagout procedure is posted at the machine and followed for servicing or clearing jams."],
      ["Production Line 1 (PET 1)", "E-stops are unobstructed, clearly marked, and tested/functioning.", "E-stops are unobstructed, clearly marked, and tested/functioning."],
      ["Production Line 1 (PET 1)", "Electrical control panel covers are intact, with no exposed wiring or bypassed interlocks.", "Electrical control panel covers are intact, with no exposed wiring or bypassed interlocks."],
      ["Production Line 1 (PET 1)", "Floors around the line are dry and free of oil, water, or product spill.", "Floors around the line are dry and free of oil, water, or product spill."],
      ["Production Line 1 (PET 1)", "Hearing protection is posted/worn where line noise requires it.", "Hearing protection is posted/worn where line noise requires it."],
      ["Production Line 1 (PET 1)", "Compressed-air lines and fittings show no leaks and are never used to clean clothing or skin.", "Compressed-air lines and fittings show no leaks and are never used to clean clothing or skin."],
    ]],
    ["Production Line 2 (PET 2)", [
      ["Production Line 2 (PET 2)", "Machine guards, light curtains, and door interlocks are in place, undamaged, and functioning.", "Machine guards, light curtains, and door interlocks are in place, undamaged, and functioning."],
      ["Production Line 2 (PET 2)", "Point-of-operation nip points, pinch points, and rotating parts are guarded.", "Point-of-operation nip points, pinch points, and rotating parts are guarded."],
      ["Production Line 2 (PET 2)", "Lockout/tagout procedure is posted at the machine and followed for servicing or clearing jams.", "Lockout/tagout procedure is posted at the machine and followed for servicing or clearing jams."],
      ["Production Line 2 (PET 2)", "E-stops are unobstructed, clearly marked, and tested/functioning.", "E-stops are unobstructed, clearly marked, and tested/functioning."],
      ["Production Line 2 (PET 2)", "Electrical control panel covers are intact, with no exposed wiring or bypassed interlocks.", "Electrical control panel covers are intact, with no exposed wiring or bypassed interlocks."],
      ["Production Line 2 (PET 2)", "Floors around the line are dry and free of oil, water, or product spill.", "Floors around the line are dry and free of oil, water, or product spill."],
      ["Production Line 2 (PET 2)", "Hearing protection is posted/worn where line noise requires it.", "Hearing protection is posted/worn where line noise requires it."],
      ["Production Line 2 (PET 2)", "Compressed-air lines and fittings show no leaks and are never used to clean clothing or skin.", "Compressed-air lines and fittings show no leaks and are never used to clean clothing or skin."],
    ]],
    ["Preforms", [
      [null, null, "Preform boxes/gaylords are stacked safely, not overloaded, and don't block the aisle or egress path."],
      [null, null, "Walkway through the Preforms area toward Husky 2 is clear of debris and trip hazards."],
      [null, null, "Preform dust and plastic fines are swept up regularly rather than left to accumulate on the floor."],
    ]],
    ["Husky 2 (Injection — PET 2)", [
      [null, null, "Machine guards and disconnect panels are in place and secured."],
      [null, null, "Lockout/tagout procedure is posted and followed before clearing jams or servicing the injection molder."],
      [null, null, "Barrel/nozzle heater areas carry a burn-hazard warning and are shielded from incidental contact."],
      [null, null, "Electrical panels and covers are intact with no exposed wiring."],
      [null, null, "Hoses and tools are stored properly rather than left exposed on or around the machine."],
      [null, null, "Area around the machine is free of slip/trip hazards from spilled resin, oil, or product."],
    ]],
    ["Offices / Breakroom / Restrooms", [
      [null, null, "Egress path near the Ramp and the Ground Zero meeting point is clear, unlocked, and clearly marked."],
      [null, null, "Office electrical cords and power strips are not daisy-chained or overloaded, and space heaters (if any) have clearance from combustibles."],
      [null, null, "Breakroom appliances (microwave, refrigerator) are in good condition, and the area is kept clean."],
      [null, null, "Restrooms are free of slip hazards and standing water."],
    ]],
  ];

  const runSafetyWalkRouteUpdate = db.transaction(() => {
    let order = 0;
    ROUTE.forEach(([newSection, rows]) => {
      rows.forEach(([oldSection, oldText, newText]) => {
        order += 1;
        if (oldSection && safetySectionExists(oldSection)) {
          const info = relocateSafetyItem.run(newSection, newText, oldSection, oldText, oldSection, oldText);
          if (info.changes > 0) {
            const moved = db
              .prepare("SELECT id FROM items WHERE audit_type = 'safety' AND section = ? AND text = ? ORDER BY id DESC LIMIT 1")
              .get(newSection, newText);
            if (moved) resortSafetyItem.run(order, moved.id);
            return;
          }
        }
        insertSafetyItem.run(newSection, order, newText);
      });
      ensureSafetyDept.run(newSection);
    });

    // Fan the old combined zones' department contacts out to each of the
    // new zones they split into, then drop the now-orphaned old rows.
    fanOutDeptInto(OLD_INJECTION_REGRIND, ["Regrind Room", "Husky 1 (Injection — PET 1)", "Husky 2 (Injection — PET 2)"]);
    fanOutDeptInto(OLD_WATER_COMPRESSOR, ["Compressor & Chiller Area", "Water In-Process Areas"]);
    fanOutDeptInto(OLD_QA_MAINT, ["QA Lab / Chemical Storage", "Maintenance Shop"]);
    fanOutDeptInto(OLD_WAREHOUSE, ["Dock Space / Warehouse"]);
    [OLD_INJECTION_REGRIND, OLD_WATER_COMPRESSOR, OLD_QA_MAINT, OLD_WAREHOUSE].forEach(dropOrphanSafetyDept);
  });
  runSafetyWalkRouteUpdate();
}

// Seed one department row per checklist section (each section IS a
// department). Idempotent, so it also fills in any section added later.
const deptInsert = db.prepare("INSERT OR IGNORE INTO departments (section) VALUES (?)");
const deptSeed = db.transaction((rows) => {
  for (const [section] of rows) deptInsert.run(section);
});
deptSeed(SECTIONS);

// Same idea for any new audit type that has notifications enabled (so far
// just the Daily Safety Walk) — its zones need department rows too, so they
// show up in Admin's contact list ready to fill in.
for (const typeKey of NEW_AUDIT_TYPE_KEYS) {
  const type = AUDIT_TYPES[typeKey];
  if (type.hasNotify) {
    deptSeed(type.sections);
  }
}

function bumpRevision() {
  db.prepare("UPDATE settings SET revision = revision + 1 WHERE id = 1").run();
}

module.exports = { db, bumpRevision, DATA_DIR };
