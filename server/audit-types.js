// Single source of truth for the three audit types the app now supports.
// GMP is the original, unchanged VF-0033-00 weekly floor audit; Internal
// and Glass & Brittle are new, built on the same blueprint (checklist ->
// NC log -> sign-off -> archived history -> PDF) but with their own
// content, status scale, and per-item extras (zone, CAPA status).
const GMP_SECTIONS = require("./sections-data");
const INTERNAL_SECTIONS = require("./internal-sections-data");
const GLASS_SECTIONS = require("./glass-sections-data");

const AUDIT_TYPES = {
  gmp: {
    key: "gmp",
    label: "GMP Workplace Audit",
    docNumber: "VF-0033-00",
    sectionLabel: "Department",
    sections: GMP_SECTIONS, // [[section, [itemText, ...]], ...]
    hasZoneField: false,
    hasCapaStatus: false,
    hasShift: true,
    hasNotify: true,
    statusOptions: ["A", "U"],
    statusLabels: { A: "Acceptable", U: "Unacceptable" },
    naStatus: null,
    defaults: {
      eyebrow: "VF-0033-00 · GMP Workplace Inspection · Shared Live Record",
      title: "Floor Audit Console",
      subtitle: "Mark an item “U” to open it on the Non-Conformance Log. Everyone sees the same log.",
      revision_date: "02/06/2026",
    },
  },
  internal: {
    key: "internal",
    label: "Internal Audit",
    docNumber: "VF-0034-00",
    sectionLabel: "Category",
    sections: INTERNAL_SECTIONS,
    hasZoneField: false,
    hasCapaStatus: true,
    hasShift: false,
    hasNotify: false,
    statusOptions: ["S", "U", "N"],
    statusLabels: { S: "Satisfactory", U: "Unsatisfactory", N: "N/A" },
    naStatus: "N",
    // Internal Audit's own "Lists" sheet ships Open/Closed/Verified; Glass &
    // Brittle's "Read Me" sheet ships Open/In Progress/Closed. Unified on
    // the latter across both new types so the CAPA lifecycle reads the same
    // way everywhere in the app ("Verified" and "Closed" meant the same
    // thing operationally in the source workbooks).
    capaStatusOptions: ["Open", "In Progress", "Closed"],
    defaults: {
      eyebrow: "VF-0034-00 · Internal Audit Program Checklist · Shared Live Record",
      title: "Internal Audit Console",
      subtitle: "Mark an item “U” (Unsatisfactory) to open it on the Non-Conformance Log. Everyone sees the same log.",
      revision_date: "10/30/2025",
    },
  },
  glass: {
    key: "glass",
    label: "Glass & Brittle Audit",
    docNumber: "VR-0041-00",
    sectionLabel: "Area",
    sections: GLASS_SECTIONS, // [[area, [[itemText, zone], ...]], ...]
    hasZoneField: true,
    hasCapaStatus: true,
    hasShift: false,
    hasNotify: false,
    statusOptions: ["S", "U", "N"],
    statusLabels: { S: "Satisfactory", U: "Unsatisfactory", N: "N/A" },
    naStatus: "N",
    zoneOptions: ["High", "Medium", "Low"],
    zoneFrequencyLabels: { High: "Weekly", Medium: "Monthly", Low: "Quarterly" },
    capaStatusOptions: ["Open", "In Progress", "Closed"],
    defaults: {
      eyebrow: "VR-0041-00 · Glass & Brittle Materials Audit · Shared Live Record",
      title: "Glass & Brittle Audit Console",
      subtitle: "Filter to the zone that’s due, then mark any item “U” (Unsatisfactory) to open it on the log.",
      revision_date: "2025 (Rev 2)",
    },
  },
};

const AUDIT_TYPE_KEYS = Object.keys(AUDIT_TYPES);
const NEW_AUDIT_TYPE_KEYS = AUDIT_TYPE_KEYS.filter((k) => k !== "gmp");

function getAuditType(key) {
  return Object.prototype.hasOwnProperty.call(AUDIT_TYPES, key) ? AUDIT_TYPES[key] : null;
}

module.exports = { AUDIT_TYPES, AUDIT_TYPE_KEYS, NEW_AUDIT_TYPE_KEYS, getAuditType };
