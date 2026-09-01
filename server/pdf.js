const fs = require("fs");
const PDFDocument = require("pdfkit");

// Brand palette — matches the app's own CSS custom properties (public/index.html)
// so the PDF feels like it came from the same product, not a generic report.
const C = {
  accent: "#2B6777",
  accentStrong: "#1E4E5C",
  accentTint: "#E3EFF1",
  ink: "#16232B",
  inkMuted: "#5B6C77",
  inkFaint: "#8598A2",
  line: "#D8E0E3",
  lineStrong: "#C1CBCF",
  surface2: "#F5F8F9",
  ok: "#2E7D4F",
  okTint: "#E3F3E8",
  bad: "#A83A2C",
  badTint: "#FBEAE7",
  warn: "#93641A",
  warnTint: "#FBF1DD",
};

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 42;
const CONTENT_W = PAGE_W - MARGIN * 2;
const BOTTOM_SAFE = PAGE_H - 60;

// Short axis/row labels for the radar + bar chart — the full checklist
// section names are too long to set around a radar chart or in a narrow
// bar-chart label column.
const SHORT_LABEL = {
  "Employee Practices (All Areas)": "Employee Practices",
  "Production: PET 1, HuskyFiller/Cappers/Cap Hopper/Labeler/Case Packer/Palletizer": "Production: PET 1",
  "Production: PET 2, HuskyFiller/Cappers/Cap Hopper/Labeler/Case Packer/Palletizer": "Production: PET 2",
  "Water Processing Area (RO / Filtration / Mineral Injection / Utilities)": "Water Processing",
  "Compressor and Chiller": "Compressor/Chiller",
  "Warehouse (Materials Receiving, Storage & Distribution)": "Warehouse",
  "Chemical, Mineral & Non-Product Material Storage": "Chemical/Mineral Storage",
  "Laboratory": "Laboratory",
  "Main Office Area": "Main Office",
};
function shortLabel(section) {
  return SHORT_LABEL[section] || section.split(":")[0].split("(")[0].trim();
}

function shiftName(settings, slot) {
  if (!slot) return "—";
  return settings["shift" + slot + "_name"] || ("Shift " + slot);
}

// GMP's own default shape — used whenever generatePdf() is called without
// an auditType (both of GMP's existing call sites), so the live GMP report
// keeps rendering exactly as it always has.
const GMP_TYPE = {
  key: "gmp",
  label: "GMP Workplace Audit",
  docNumber: "VF-0033-00",
  sectionLabel: "Department",
  hasZoneField: false,
  hasCapaStatus: false,
  statusOptions: ["A", "U"],
  statusLabels: { A: "Acceptable", U: "Unacceptable" },
  naStatus: null,
};

// Group items by checklist section, preserving first-seen order.
// passStatus/failStatus are the status codes counted as "passed"/"failed"
// for this audit type (A/U for GMP, S/U for the 3-state types) — the
// returned field names stay accepted/unacceptable/passRate either way so
// every downstream chart function (bars, radar, top issues, checklist)
// works unchanged regardless of which type's data it's fed.
function groupBySection(items, passStatus, failStatus) {
  const order = [];
  const map = new Map();
  items.forEach((item) => {
    if (!map.has(item.section)) {
      map.set(item.section, []);
      order.push(item.section);
    }
    map.get(item.section).push(item);
  });
  return order.map((section) => {
    const rows = map.get(section);
    const accepted = rows.filter((r) => r.status === passStatus).length;
    const unacceptable = rows.filter((r) => r.status === failStatus).length;
    const total = rows.length;
    const reviewed = accepted + unacceptable;
    return {
      section,
      label: shortLabel(section),
      items: rows,
      total,
      accepted,
      unacceptable,
      notReviewed: total - reviewed,
      passRate: reviewed > 0 ? accepted / reviewed : null,
    };
  });
}

function ensureSpace(doc, needed) {
  if (doc.y + needed > BOTTOM_SAFE) doc.addPage();
}

// ---- KPI row — a hairline-ruled ledger row, not colored cards ------------
// (formal-register treatment: thin dividers between fields, a serif
// numeral, a small-caps label — the same language as the section headings
// and results table rather than a separate "dashboard card" idiom.)
function drawStatCards(doc, x, y, w, cards) {
  const gap = 0;
  const cardW = w / cards.length;
  const cardH = 58;
  doc.moveTo(x, y).lineTo(x + w, y).lineWidth(0.6).stroke(C.line);
  cards.forEach((card, i) => {
    const cx = x + i * cardW;
    if (i > 0) doc.moveTo(cx, y + 6).lineTo(cx, y + cardH - 6).lineWidth(0.6).stroke(C.line);
    const padX = 14;
    doc.font("Helvetica").fontSize(7.6).fillColor(C.inkFaint).text(
      card.label.toUpperCase(), cx + padX, y + 12, { width: cardW - padX - 8, characterSpacing: 0.4, lineBreak: false }
    );
    doc.font("Times-Bold").fontSize(22).fillColor(card.color).text(
      String(card.value), cx + padX, y + 24, { width: cardW - padX - 8, lineBreak: false }
    );
    doc.font("Helvetica").fontSize(8).fillColor(C.inkMuted).text(
      card.sub, cx + padX, y + 47, { width: cardW - padX - 8, lineBreak: false }
    );
  });
  doc.moveTo(x, y + cardH).lineTo(x + w, y + cardH).lineWidth(0.6).stroke(C.line);
  return y + cardH;
}

// ---- Results-by-department stacked bar rows ------------------------------
function drawDeptBars(doc, x, y, w, deptStats) {
  const labelW = 128;
  const rateW = 78;
  const barX = x + labelW;
  const barW = w - labelW - rateW;
  const rowH = 17;

  deptStats.forEach((d) => {
    ensureSpace(doc, rowH + 2);
    const rowY = doc.y;
    doc.font("Helvetica").fontSize(8.6).fillColor(C.ink).text(d.label, x, rowY + 4, { width: labelW - 8, lineBreak: false });

    const trackH = 9;
    const trackY = rowY + 3;
    doc.roundedRect(barX, trackY, barW, trackH, 2).fill(C.surface2);
    if (d.total > 0) {
      let segX = barX;
      const okW = (d.accepted / d.total) * barW;
      const badW = (d.unacceptable / d.total) * barW;
      if (okW > 0) { doc.rect(segX, trackY, okW, trackH).fill(C.ok); segX += okW; }
      if (badW > 0) { doc.rect(segX, trackY, badW, trackH).fill(C.bad); segX += badW; }
    }
    doc.roundedRect(barX, trackY, barW, trackH, 2).lineWidth(0.6).stroke(C.lineStrong);

    const rateText = d.passRate === null ? "not reviewed" : Math.round(d.passRate * 100) + "% pass";
    doc.font("Helvetica-Bold").fontSize(8.4).fillColor(d.passRate === null ? C.inkFaint : (d.passRate >= 0.9 ? C.ok : d.passRate >= 0.7 ? C.warn : C.bad))
      .text(rateText, barX + barW + 8, rowY + 4, { width: rateW - 8, lineBreak: false });

    doc.y = rowY + rowH;
  });
  return doc.y;
}

// A radar chart's labels ring the outside of the circle — past ~16 axes on
// a Letter-width page they start to collide (Glass & Brittle's ~28 areas
// is the case that motivated this cap). Below 3 axes there's no shape to
// read either way. Outside that range the stacked bars above stay the only
// visual — they scale to any number of rows just fine.
const MIN_RADAR_AXES = 3;
const MAX_RADAR_AXES = 16;

// ---- Section radar — a spider/risk-profile chart of pass rate by section.
// The stacked bars above give the exact numbers; this gives the same data
// an at-a-glance shape, the way a formal vulnerability-assessment report
// would (the device is borrowed from that genre of report; the rendering —
// hairline rings, muted palette, serif-free labels — stays in this report's
// own ledger register rather than copying another product's look).
function drawSectionRadar(doc, x, y, w, deptStats, sectionLabel) {
  const axes = deptStats.filter((d) => d.total > 0);
  if (axes.length < MIN_RADAR_AXES || axes.length > MAX_RADAR_AXES) return y;

  const n = axes.length;
  const radius = Math.min(w / 2 - 78, 108);
  const cx = x + w / 2;
  const cy = y + radius + 10;

  const angleFor = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const pointAt = (i, frac) => {
    const a = angleFor(i);
    return [cx + Math.cos(a) * radius * frac, cy + Math.sin(a) * radius * frac];
  };

  // Grid rings + spokes, faint.
  [0.25, 0.5, 0.75, 1].forEach((frac) => {
    const ringPts = [];
    for (let i = 0; i < n; i++) ringPts.push(pointAt(i, frac));
    doc.polygon(...ringPts).lineWidth(0.5).stroke(C.line);
  });
  for (let i = 0; i < n; i++) {
    const [px, py] = pointAt(i, 1);
    doc.moveTo(cx, cy).lineTo(px, py).lineWidth(0.5).stroke(C.line);
  }

  // Data shape — colored by the same 90%/70% thresholds the bar rows use,
  // so a reader who's seen the bars reads this chart's color the same way.
  const avgRate = axes.reduce((s, d) => s + (d.passRate || 0), 0) / n;
  const shapeColor = avgRate >= 0.9 ? C.ok : avgRate >= 0.7 ? C.warn : C.bad;
  const dataPts = axes.map((d, i) => pointAt(i, d.passRate === null ? 0.03 : Math.max(0.03, d.passRate)));
  doc.polygon(...dataPts).lineWidth(1.3).fillOpacity(0.24).fillAndStroke(shapeColor, shapeColor);
  doc.fillOpacity(1);
  dataPts.forEach(([px, py]) => doc.circle(px, py, 2).fill(shapeColor));

  // Axis labels ring the chart, anchored left/right/center by which side
  // of the circle they fall on so none of them overlap the shape.
  doc.font("Helvetica").fontSize(7.4).fillColor(C.inkMuted);
  const boxW = 104;
  axes.forEach((d, i) => {
    const a = angleFor(i);
    const [lx, ly] = pointAt(i, 1);
    const cos = Math.cos(a);
    const align = cos > 0.2 ? "left" : cos < -0.2 ? "right" : "center";
    const tx = align === "left" ? lx + 6 : align === "right" ? lx - boxW - 6 : lx - boxW / 2;
    doc.text(d.label, tx, ly - 4 + (Math.sin(a) > 0.6 ? 8 : Math.sin(a) < -0.6 ? -14 : 0), { width: boxW, align, lineBreak: false });
  });

  return cy + radius + 28;
}

// ---- CAPA status bar — only drawn for audit types that track CAPA status
// (Internal Audit, Glass & Brittle; GMP has no capa_status field). ---------
function drawCapaBar(doc, x, y, w, items) {
  const counts = { Open: 0, "In Progress": 0, Closed: 0 };
  items.forEach((it) => {
    const s = it.capa_status || "Open";
    if (counts[s] === undefined) counts[s] = 0;
    counts[s] += 1;
  });
  const total = items.length;
  const order = ["Open", "In Progress", "Closed"];
  const colors = { Open: C.bad, "In Progress": C.warn, Closed: C.ok };
  const barH = 9;
  doc.roundedRect(x, y, w, barH, 2).lineWidth(0.8).stroke(C.lineStrong);
  if (total > 0) {
    let segX = x;
    order.forEach((k) => {
      const segW = (counts[k] / total) * w;
      if (segW > 0) { doc.rect(segX, y, segW, barH).fill(colors[k]); segX += segW; }
    });
  }
  let ly = y + barH + 10;
  const legendGap = 90;
  order.forEach((k, i) => {
    doc.font("Helvetica-Bold").fontSize(9).fillColor(colors[k]).text(String(counts[k]), x + i * legendGap, ly, { lineBreak: false, continued: true });
    doc.font("Helvetica").fontSize(8.6).fillColor(C.inkMuted).text("  " + k, { lineBreak: false });
  });
  return ly + 16;
}

// ---- Priority findings — the most urgent open items, item-level rather
// than section-level, with zone/CAPA context alongside each one. ----------
function drawPriorityFindings(doc, x, y, w, openItems, type) {
  if (openItems.length === 0) {
    doc.font("Helvetica").fontSize(9).fillColor(C.inkMuted).text("No open findings this cycle.", x, y, { width: w });
    return doc.y;
  }
  const ZONE_RANK = { High: 0, Medium: 1, Low: 2 };
  let ranked = openItems.slice();
  if (type.hasZoneField) {
    ranked = ranked.slice().sort((a, b) => (ZONE_RANK[a.zone] ?? 3) - (ZONE_RANK[b.zone] ?? 3));
  }
  const MAX_ROWS = 8;
  const shown = ranked.slice(0, MAX_ROWS);
  const remaining = ranked.length - shown.length;

  const sectionW = 118;
  const statusW = (type.hasZoneField ? 52 : 0) + 88;
  const textW = w - sectionW - statusW - 16;

  // Header row
  doc.font("Helvetica-Bold").fontSize(7.4).fillColor(C.inkFaint);
  doc.text(type.sectionLabel.toUpperCase(), x, y, { width: sectionW, characterSpacing: 0.3, lineBreak: false });
  doc.text("FINDING", x + sectionW + 8, y, { width: textW, characterSpacing: 0.3, lineBreak: false });
  doc.text("STATUS", x + sectionW + 8 + textW + 8, y, { width: statusW, characterSpacing: 0.3, lineBreak: false, align: "right" });
  doc.y = y + 12;
  doc.moveTo(x, doc.y).lineTo(x + w, doc.y).lineWidth(0.8).stroke(C.ink);
  doc.y += 6;

  shown.forEach((item) => {
    doc.font("Helvetica").fontSize(8.6);
    const findingText = item.description || item.text;
    const textH = doc.heightOfString(findingText, { width: textW });
    const rowH = Math.max(14, textH) + 8;
    ensureSpace(doc, rowH);
    const rowY = doc.y;

    doc.font("Helvetica").fontSize(8.2).fillColor(C.inkMuted).text(shortLabel(item.section), x, rowY, { width: sectionW - 8 });
    doc.font("Helvetica").fontSize(8.6).fillColor(C.ink).text(findingText, x + sectionW + 8, rowY, { width: textW });

    let statusLine = "";
    if (type.hasZoneField && item.zone) statusLine += item.zone.toUpperCase() + "  ";
    const capaStatus = type.hasCapaStatus ? (item.capa_status || "Open") : null;
    const statusColor = capaStatus === "Closed" ? C.ok : capaStatus === "In Progress" ? C.warn : C.bad;
    doc.font("Helvetica-Bold").fontSize(7.8).fillColor(statusColor).text(
      statusLine + (capaStatus ? capaStatus.toUpperCase() : "OPEN"),
      x + sectionW + 8 + textW + 8, rowY, { width: statusW, align: "right", characterSpacing: 0.2, lineBreak: false }
    );

    doc.y = rowY + rowH;
    doc.moveTo(x, doc.y - 2).lineTo(x + w, doc.y - 2).lineWidth(0.5).stroke(C.line);
  });

  if (remaining > 0) {
    doc.font("Helvetica").fontSize(8).fillColor(C.inkFaint).text(
      "+ " + remaining + " more — see Non-Conformance Log", x, doc.y + 4
    );
  }
  return doc.y;
}

function sectionHeading(doc, text, y) {
  doc.font("Times-Bold").fontSize(13).fillColor(C.ink).text(text, MARGIN, y);
  doc.moveTo(MARGIN, doc.y + 2).lineTo(PAGE_W - MARGIN, doc.y + 2).lineWidth(0.6).stroke(C.line);
  return doc.y + 12;
}

// Small vector pass/fail/pending marker — drawn with primitives rather than
// unicode check/cross glyphs, since pdfkit's standard Helvetica encoding
// doesn't reliably include those symbols. naStatus is null for GMP (A/U
// only) and "N" for the 3-state types — items with that status get a
// filled dash marker, distinct from a genuinely not-yet-reviewed item.
function drawStatusIcon(doc, cx, cy, status, passStatus, failStatus, naStatus) {
  const r = 5;
  if (status === passStatus) {
    doc.circle(cx, cy, r).fill(C.ok);
    doc.lineWidth(1.3).lineCap("round").lineJoin("round")
      .moveTo(cx - 2.3, cy + 0.2).lineTo(cx - 0.6, cy + 2.1).lineTo(cx + 2.5, cy - 2.3)
      .stroke("#FFFFFF");
  } else if (status === failStatus) {
    doc.circle(cx, cy, r).fill(C.bad);
    doc.lineWidth(1.3).lineCap("round")
      .moveTo(cx - 2.1, cy - 2.1).lineTo(cx + 2.1, cy + 2.1)
      .moveTo(cx - 2.1, cy + 2.1).lineTo(cx + 2.1, cy - 2.1)
      .stroke("#FFFFFF");
  } else if (naStatus && status === naStatus) {
    doc.circle(cx, cy, r).fill(C.inkFaint);
    doc.lineWidth(1.3).lineCap("round").moveTo(cx - 2.3, cy).lineTo(cx + 2.3, cy).stroke("#FFFFFF");
  } else {
    doc.circle(cx, cy, r).lineWidth(1).stroke(C.lineStrong);
  }
}

// ---- Full checklist appendix — every item, grouped by department ---------
function drawFullChecklist(doc, deptStats, passStatus, failStatus, naStatus, itemNumbers) {
  const textX = MARGIN + 22;
  const textW = CONTENT_W - 22;

  deptStats.forEach((dept) => {
    ensureSpace(doc, 24);
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor(C.accentStrong).text(
      dept.label.toUpperCase(), MARGIN, doc.y, { characterSpacing: 0.3 }
    );
    doc.moveTo(MARGIN, doc.y + 2).lineTo(PAGE_W - MARGIN, doc.y + 2).lineWidth(0.6).stroke(C.line);
    doc.y += 9;

    dept.items.forEach((item) => {
      const label = "#" + itemNumbers.get(item.id) + " — " + item.text;
      doc.font("Helvetica").fontSize(8.4);
      const textH = doc.heightOfString(label, { width: textW });
      const rowH = Math.max(13, textH) + 4;
      ensureSpace(doc, rowH);
      const rowY = doc.y;
      drawStatusIcon(doc, MARGIN + 6, rowY + Math.min(8.5, rowH / 2), item.status, passStatus, failStatus, naStatus);
      const color = item.status === failStatus ? C.bad : item.status === passStatus ? C.ink : C.inkFaint;
      doc.font("Helvetica").fontSize(8.4).fillColor(color).text(label, textX, rowY, { width: textW });
      doc.y = rowY + rowH;
    });
    doc.y += 8;
  });
}

// ---- Audit trend — unacceptable-item count across past archived audits ---
function drawAuditTrendChart(doc, x, y, w, snapshots) {
  if (snapshots.length === 0) {
    doc.font("Helvetica").fontSize(9).fillColor(C.inkMuted).text(
      'Trend data will appear here once past audits have been archived — each time "New Audit" is used to clear the log, the outgoing audit is saved for this chart.',
      x, y, { width: w }
    );
    return doc.y;
  }

  const n = snapshots.length;
  const chartH = 100;
  const gap = 10;
  const barW = Math.min(36, (w - gap * (n - 1)) / n);
  const totalBarsW = n * barW + (n - 1) * gap;
  const startX = x + Math.max(0, (w - totalBarsW) / 2);
  const maxVal = Math.max(1, ...snapshots.map((s) => s.unacceptable));
  const baseline = y + chartH;

  doc.moveTo(x, baseline).lineTo(x + w, baseline).lineWidth(0.6).stroke(C.line);

  snapshots.forEach((s, i) => {
    const bx = startX + i * (barW + gap);
    const bh = s.unacceptable > 0 ? Math.max(3, (s.unacceptable / maxVal) * (chartH - 24)) : 0;
    if (bh > 0) doc.roundedRect(bx, baseline - bh, barW, bh, 2).fill(C.bad);
    doc.font("Helvetica-Bold").fontSize(8).fillColor(C.bad).text(
      String(s.unacceptable), bx - 4, baseline - bh - 12, { width: barW + 8, align: "center", lineBreak: false }
    );
    const dateLabel = s.audit_date || ("#" + s.id);
    doc.font("Helvetica").fontSize(7).fillColor(C.inkMuted).text(
      dateLabel, bx - 8, baseline + 4, { width: barW + 16, align: "center", lineBreak: false }
    );
  });

  return baseline + 18;
}

// ---- Recurring issues — checklist items flagged most often across audits -
function drawRecurringIssues(doc, x, y, w, issues) {
  if (issues.length === 0) {
    doc.font("Helvetica").fontSize(9).fillColor(C.inkMuted).text(
      "No repeat issues yet — this list fills in once a few audits have been archived.",
      x, y, { width: w }
    );
    return doc.y;
  }

  const countW = 34;
  const sectionW = 130;
  const textW = w - countW - sectionW;

  issues.forEach((iss, idx) => {
    doc.font("Helvetica").fontSize(8.6);
    const textH = doc.heightOfString(iss.item_text, { width: textW });
    const rowH = Math.max(14, textH) + 6;
    ensureSpace(doc, rowH);
    const rowY = doc.y;

    doc.font("Helvetica-Bold").fontSize(9.5).fillColor(C.bad).text(
      String(iss.times_flagged) + "×", x, rowY, { width: countW, lineBreak: false }
    );
    doc.font("Helvetica").fontSize(8.6).fillColor(C.ink).text(iss.item_text, x + countW, rowY, { width: textW });
    doc.font("Helvetica").fontSize(7.6).fillColor(C.inkFaint).text(
      shortLabel(iss.section), x + countW + textW, rowY + 1, { width: sectionW, align: "right" }
    );

    doc.y = rowY + rowH;
    if (idx < issues.length - 1) {
      doc.moveTo(x, doc.y - 3).lineTo(x + w, doc.y - 3).lineWidth(0.5).stroke(C.line);
    }
  });
  return doc.y;
}

function formatArchivedAt(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function generatePdf(res, { settings, items, history, archiveInfo, auditType }) {
  // auditType is only passed by the Internal Audit / Glass & Brittle routes;
  // GMP's two call sites (live + history) omit it entirely, so `type` below
  // is GMP_TYPE and every GMP-specific string/threshold below reduces to
  // exactly what this file already produced before multi-audit-type support.
  const type = Object.assign({}, GMP_TYPE, auditType || {});
  const passStatus = type.statusOptions[0]; // "A" for GMP, "S" for the 3-state types
  const failStatus = "U"; // universal "failed / open NC" code across all audit types
  const naStatus = type.naStatus; // null for GMP, "N" for the 3-state types
  const hasShift = type.key === "gmp"; // only GMP items carry a shift assignment

  const snapshots = (history && history.snapshots) || [];
  const recurringIssues = (history && history.recurringIssues) || [];
  const doc = new PDFDocument({ size: "LETTER", margin: MARGIN });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="' + type.docNumber + '-audit-' + (settings.audit_date || "draft").replace(/\//g, "-") + '.pdf"'
  );
  doc.pipe(res);

  const total = items.length;
  const passed = items.filter((i) => i.status === passStatus).length;
  const unacceptable = items.filter((i) => i.status === failStatus).length;
  const naCount = naStatus ? items.filter((i) => i.status === naStatus).length : 0;
  const notReviewed = total - passed - unacceptable - naCount;
  const deptStats = groupBySection(items, passStatus, failStatus);

  // Sequential 1..N numbering in the same section-grouped order the UI
  // renders items in, so PDF item numbers always line up with the on-screen
  // badges — regardless of gaps left in the underlying database ids by past
  // deletions.
  const itemNumbers = new Map();
  {
    let n = 1;
    deptStats.forEach((dept) => { dept.items.forEach((item) => { itemNumbers.set(item.id, n++); }); });
  }

  // ---- Header band -------------------------------------------------------
  // A plain formal masthead — a thin accent rule, a serif title, and the
  // document number set top-right — rather than a colored graphic mark.
  doc.rect(0, 0, PAGE_W, 8).fill(C.accent);

  doc.font("Times-Bold").fontSize(21).fillColor(C.ink).text(settings.title || "Floor Audit Console", MARGIN, 30, { width: 340 });
  doc.font("Helvetica").fontSize(8.5).fillColor(C.accent).text((settings.eyebrow || "").toUpperCase(), MARGIN, doc.y + 1, { width: 340, characterSpacing: 0.4 });
  doc.font("Helvetica-Bold").fontSize(9).fillColor(C.inkMuted).text(
    "Doc " + type.docNumber, PAGE_W - MARGIN - 160, 32, { width: 160, align: "right", lineBreak: false }
  );
  doc.font("Helvetica").fontSize(8).fillColor(C.inkFaint).text(
    "Period ending " + (settings.audit_date || "—"), PAGE_W - MARGIN - 160, 44, { width: 160, align: "right", lineBreak: false }
  );
  doc.moveDown(0.6);

  // Report details strip
  const detailsY = doc.y + 4;
  const details = [
    ["Auditor", settings.auditor || "—"],
    ["Audit Date", settings.audit_date || "—"],
    ["Reviewed By", settings.reviewed_by || "—"],
    ["Review Date", settings.reviewed_date || "—"],
  ];
  const detailW = CONTENT_W / details.length;
  details.forEach(([label, value], i) => {
    const dx = MARGIN + i * detailW;
    doc.font("Helvetica").fontSize(7.6).fillColor(C.inkFaint).text(label.toUpperCase(), dx, detailsY, { characterSpacing: 0.4 });
    doc.font("Helvetica-Bold").fontSize(10.5).fillColor(C.ink).text(value, dx, detailsY + 10, { width: detailW - 10, lineBreak: false });
    if (i > 0) doc.moveTo(dx - 10, detailsY - 2).lineTo(dx - 10, detailsY + 24).lineWidth(0.6).stroke(C.line);
  });
  doc.y = detailsY + 32;
  doc.moveTo(MARGIN, doc.y).lineTo(PAGE_W - MARGIN, doc.y).lineWidth(0.8).stroke(C.line);
  doc.y += 14;

  // ---- Archived-record banner — only present when this PDF was pulled
  // back out of history rather than generated from the live checklist.
  if (archiveInfo) {
    const bannerH = 26;
    const bannerY = doc.y;
    doc.roundedRect(MARGIN, bannerY, CONTENT_W, bannerH, 4).fill(C.accentTint);
    doc.font("Helvetica-Bold").fontSize(8.6).fillColor(C.accentStrong).text(
      "ARCHIVED RECORD", MARGIN + 12, bannerY + 6, { characterSpacing: 0.3, lineBreak: false }
    );
    doc.font("Helvetica").fontSize(8.3).fillColor(C.inkMuted).text(
      "Pulled from history · archived " + formatArchivedAt(archiveInfo.archivedAt),
      MARGIN + 118, bannerY + 6.5, { width: CONTENT_W - 260, lineBreak: false }
    );
    let badgeText = "Integrity not checkable";
    let badgeColor = C.inkFaint;
    let badgeTint = C.surface2;
    if (archiveInfo.verified === true) { badgeText = "Verified unaltered"; badgeColor = C.ok; badgeTint = C.okTint; }
    else if (archiveInfo.verified === false) { badgeText = "Does not match original fingerprint"; badgeColor = C.bad; badgeTint = C.badTint; }
    doc.font("Helvetica-Bold").fontSize(7.8).fillColor(badgeColor);
    const badgeW = doc.widthOfString(badgeText) + 16;
    doc.roundedRect(MARGIN + CONTENT_W - badgeW - 10, bannerY + 5, badgeW, 16, 8).fill(badgeTint);
    doc.fillColor(badgeColor).text(badgeText, MARGIN + CONTENT_W - badgeW - 10, bannerY + 9, { width: badgeW, align: "center", lineBreak: false });
    doc.y = bannerY + bannerH + 12;
  }

  // ---- Overview stat cards -------------------------------------------------
  doc.y = sectionHeading(doc, "Overview", doc.y);
  const reviewedPct = total > 0 ? Math.round(((passed + unacceptable + naCount) / total) * 100) : 0;
  const passLabel = type.statusLabels[passStatus] || "Acceptable";
  const failLabel = type.statusLabels[failStatus] || "Unacceptable";
  const overviewCards = [
    { label: passLabel, value: passed, sub: "of " + total + " items", color: C.ok },
    { label: failLabel, value: unacceptable, sub: "of " + total + " items", color: C.bad },
  ];
  if (naStatus) {
    overviewCards.push({ label: type.statusLabels[naStatus] || "N/A", value: naCount, sub: "of " + total + " items", color: C.inkFaint });
  }
  overviewCards.push({ label: "Not Reviewed", value: notReviewed, sub: reviewedPct + "% reviewed so far", color: C.warn });
  const cardsY = drawStatCards(doc, MARGIN, doc.y, CONTENT_W, overviewCards);
  doc.y = cardsY + 20;

  // ---- Results by department (stacked bars) -------------------------------
  ensureSpace(doc, 24);
  doc.y = sectionHeading(doc, "Results by " + type.sectionLabel, doc.y);
  doc.y = drawDeptBars(doc, MARGIN, doc.y, CONTENT_W, deptStats);
  doc.y += 16;

  // ---- Risk profile (radar) — same data as the bars above, as a shape ----
  const reviewedSectionCount = deptStats.filter((d) => d.total > 0).length;
  if (reviewedSectionCount >= MIN_RADAR_AXES && reviewedSectionCount <= MAX_RADAR_AXES) {
    ensureSpace(doc, 280);
    doc.font("Helvetica").fontSize(8).fillColor(C.inkFaint).text(
      "Pass rate by " + type.sectionLabel.toLowerCase() + ", plotted as a risk profile — the larger the shape, the lower the risk.",
      MARGIN, doc.y, { width: CONTENT_W }
    );
    doc.y += 8;
    doc.y = drawSectionRadar(doc, MARGIN, doc.y, CONTENT_W, deptStats, type.sectionLabel);
    doc.y += 8;
  }

  // ---- CAPA status --------------------------------------------------------
  // Only for the audit types that track it (Internal, Glass & Brittle) —
  // GMP items have no capa_status field.
  const openItemsForFindings = items.filter((i) => i.status === failStatus);
  if (type.hasCapaStatus && openItemsForFindings.length > 0) {
    ensureSpace(doc, 50);
    doc.y = sectionHeading(doc, "CAPA Status (" + openItemsForFindings.length + " findings)", doc.y);
    doc.y = drawCapaBar(doc, MARGIN, doc.y, CONTENT_W, openItemsForFindings);
    doc.y += 8;
  }

  // ---- Priority findings ---------------------------------------------------
  // Item-level, not section-level — the most urgent open findings, ranked
  // by risk zone where the audit type has one (Glass & Brittle), otherwise
  // in checklist order. Full detail for every open item still follows in
  // the Non-Conformance Log below; this is a page-1 preview.
  if (unacceptable > 0) {
    ensureSpace(doc, 40);
    doc.y = sectionHeading(doc, "Priority Findings", doc.y);
    doc.y = drawPriorityFindings(doc, MARGIN, doc.y, CONTENT_W, openItemsForFindings, type);
    doc.y += 10;
  }

  // ---- Non-Conformance Log ----------------------------------------------
  doc.addPage();
  doc.y = sectionHeading(doc, "Non-Conformance Log", MARGIN);
  const openItems = items.filter((i) => i.status === failStatus);

  if (openItems.length === 0) {
    doc.font("Helvetica").fontSize(10).fillColor(C.inkMuted).text("No deviations logged.");
  }

  openItems.forEach((item) => {
    const acknowledged = item.initials && item.initials.trim().length > 0;
    const cx = MARGIN + 12;
    const cw = CONTENT_W - 12;

    const descText = "Description: " + (item.description || item.text);
    const caText = "Corrective Action: " + (item.corrective_action || "—");
    const pmText = "Preventive Measures: " + (item.preventive_measures || "—");
    // Line 4 of each card: Shift only applies to GMP; zone and CAPA status
    // only apply to the types that have them. Acknowledgment always shows —
    // GMP keeps its original "Supervisor Acknowledgment" wording exactly,
    // the other types drop "Supervisor" since they aren't shift-based.
    const line4Parts = [];
    if (hasShift) line4Parts.push("Shift: " + shiftName(settings, item.shift));
    if (type.hasZoneField && item.zone) line4Parts.push("Zone: " + item.zone);
    if (type.hasCapaStatus) line4Parts.push("CAPA Status: " + (item.capa_status || "Open"));
    line4Parts.push((hasShift ? "Supervisor " : "") + "Acknowledgment: " + (item.initials || "Pending"));
    const shiftText = line4Parts.join("    ");

    // Measure first (at the same font/width used to draw) so the colored
    // side bar and card spacing match wrapped text of any length.
    doc.font("Helvetica").fontSize(9);
    const descH = doc.heightOfString(descText, { width: cw });
    const caH = doc.heightOfString(caText, { width: cw });
    const pmH = doc.heightOfString(pmText, { width: cw });
    doc.font("Helvetica-Bold").fontSize(9);
    const shiftH = doc.heightOfString(shiftText, { width: cw });
    const headerH = 16;
    const fieldGap = 2;

    // Photo evidence, if this deviation has any attached — rendered as a
    // small thumbnail grid inside the card rather than at full resolution.
    const THUMB_W = 90, THUMB_H = 68, THUMB_GAP = 6, THUMB_COLS = 5;
    let photoImages = [];
    if (item.photo_paths && item.photo_paths.length) {
      item.photo_paths.forEach((p) => {
        if (!fs.existsSync(p)) return;
        try {
          photoImages.push(doc.openImage(p));
        } catch (e) {
          // unreadable/missing file on disk — skip silently, text fields still render
        }
      });
    }
    const photoCols = Math.min(THUMB_COLS, photoImages.length);
    const photoRows = photoImages.length ? Math.ceil(photoImages.length / photoCols) : 0;
    const photoGridH = photoImages.length ? photoRows * THUMB_H + (photoRows - 1) * THUMB_GAP : 0;
    let photoLabelH = 0;
    if (photoImages.length) {
      doc.font("Helvetica-Bold").fontSize(7.6);
      photoLabelH = doc.heightOfString("PHOTO EVIDENCE (" + photoImages.length + ")", { width: cw });
    }
    const photoBlockH = photoImages.length ? fieldGap + photoLabelH + 3 + photoGridH : 0;
    const boxH = headerH + descH + fieldGap + caH + fieldGap + pmH + fieldGap + shiftH + photoBlockH + 4;

    ensureSpace(doc, boxH + 10);
    const boxY = doc.y;
    doc.rect(MARGIN, boxY, 3, boxH).fill(C.bad);

    doc.font("Helvetica-Bold").fontSize(10.5).fillColor(C.ink).text("#" + itemNumbers.get(item.id) + "  " + shortLabel(item.section), cx, boxY, { width: cw - 90 });

    const badgeText = acknowledged ? "ACKNOWLEDGED" : "NOT ACKNOWLEDGED";
    const badgeColor = acknowledged ? C.ok : C.warn;
    const badgeTint = acknowledged ? C.okTint : C.warnTint;
    doc.font("Helvetica-Bold").fontSize(7.4).fillColor(badgeColor);
    const badgeW = doc.widthOfString(badgeText) + 14;
    doc.roundedRect(MARGIN + CONTENT_W - badgeW, boxY, badgeW, 14, 7).fill(badgeTint);
    doc.fillColor(badgeColor).text(badgeText, MARGIN + CONTENT_W - badgeW, boxY + 3.5, { width: badgeW, align: "center", lineBreak: false });

    let ly = boxY + headerH;
    doc.font("Helvetica").fontSize(9).fillColor(C.inkMuted);
    doc.text(descText, cx, ly, { width: cw });
    ly = doc.y + fieldGap;
    doc.text(caText, cx, ly, { width: cw });
    ly = doc.y + fieldGap;
    doc.text(pmText, cx, ly, { width: cw });
    ly = doc.y + fieldGap;
    doc.font("Helvetica-Bold").fontSize(9).fillColor(C.ink).text(shiftText, cx, ly, { width: cw });

    if (photoImages.length) {
      ly = doc.y + fieldGap;
      doc.font("Helvetica-Bold").fontSize(7.6).fillColor(C.inkFaint).text(
        "PHOTO EVIDENCE (" + photoImages.length + ")", cx, ly, { width: cw, characterSpacing: 0.3, lineBreak: false }
      );
      const gridY = doc.y + 3;
      photoImages.forEach((img, idx) => {
        const col = idx % photoCols;
        const row = Math.floor(idx / photoCols);
        const scale = Math.min(THUMB_W / img.width, THUMB_H / img.height, 1);
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const cellX = cx + col * (THUMB_W + THUMB_GAP);
        const cellY = gridY + row * (THUMB_H + THUMB_GAP);
        const drawX = cellX + (THUMB_W - w) / 2;
        const drawY = cellY + (THUMB_H - h) / 2;
        doc.image(img, drawX, drawY, { width: w, height: h });
      });
      doc.y = gridY + photoGridH;
    }

    doc.y = boxY + boxH + 10;
  });

  // ---- Full Checklist Appendix ----------------------------------------------
  doc.addPage();
  doc.y = sectionHeading(doc, "Full Checklist (all " + total + " items)", MARGIN);
  drawFullChecklist(doc, deptStats, passStatus, failStatus, naStatus, itemNumbers);

  // ---- Audit Trend ------------------------------------------------------------
  doc.addPage();
  doc.y = sectionHeading(doc, "Audit Trend — Unacceptable Items Over Time", MARGIN);
  doc.y = drawAuditTrendChart(doc, MARGIN, doc.y + 6, CONTENT_W, snapshots);
  doc.y += 18;

  ensureSpace(doc, 30);
  doc.y = sectionHeading(doc, "Recurring Issues (most frequently flagged)", doc.y);
  doc.y = drawRecurringIssues(doc, MARGIN, doc.y, CONTENT_W, recurringIssues);

  // ---- Sign-off ------------------------------------------------------------
  // GMP keeps its exact original "SQF Sign-Off" / "SQF Practitioner"
  // wording; the other audit types use plain, non-standard-specific labels
  // since they aren't SQF-scoped audits.
  const signoffHeading = type.key === "gmp" ? "SQF Sign-Off" : "Sign-Off";
  const reviewedByLabel = type.key === "gmp" ? "Reviewed By (SQF Practitioner)" : "Reviewed By";
  const footerText = type.key === "gmp"
    ? "VF-0033-00 GMP Audit Form · Written by Michael Asante · Revise Date " + (settings.revision_date || "—")
    : type.docNumber + " " + type.label + " Form · Written by Michael Asante · Revise Date " + (settings.revision_date || "—");

  ensureSpace(doc, 90);
  doc.moveDown(0.6);
  doc.moveTo(MARGIN, doc.y).lineTo(PAGE_W - MARGIN, doc.y).lineWidth(0.8).stroke(C.line);
  doc.y += 12;
  doc.font("Times-Bold").fontSize(13).fillColor(C.ink).text(signoffHeading);
  doc.font("Helvetica").fontSize(10).fillColor(C.inkMuted);
  doc.text("QA Lead / Tech Initials: " + (settings.qa_initials || "—"));
  doc.text(reviewedByLabel + ": " + (settings.reviewed_by || "—"));
  doc.text("Date: " + (settings.reviewed_date || "—"));

  doc.moveDown(1.2);
  doc.fontSize(8).fillColor(C.inkFaint).text(footerText);

  doc.end();
}

module.exports = { generatePdf };
