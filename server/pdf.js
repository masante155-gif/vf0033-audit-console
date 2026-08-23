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

// Group items by checklist section, preserving first-seen order.
function groupBySection(items) {
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
    const accepted = rows.filter((r) => r.status === "A").length;
    const unacceptable = rows.filter((r) => r.status === "U").length;
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

// ---- Stat cards (Acceptable / Unacceptable / Not Reviewed) --------------
function drawStatCards(doc, x, y, w, cards) {
  const gap = 12;
  const cardW = (w - gap * (cards.length - 1)) / cards.length;
  const cardH = 78;
  cards.forEach((card, i) => {
    const cx = x + i * (cardW + gap);
    doc.roundedRect(cx, y, cardW, cardH, 6).fillAndStroke("#FFFFFF", C.line);
    doc.font("Helvetica-Bold").fontSize(24).fillColor(card.color).text(
      String(card.value), cx + 14, y + 12, { width: cardW - 28, lineBreak: false }
    );
    doc.font("Helvetica").fontSize(9).fillColor(C.inkMuted).text(
      card.sub, cx + 14, y + 40, { width: cardW - 28, lineBreak: false }
    );
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor(C.ink).text(
      card.label.toUpperCase(), cx + 14, y + 54, { width: cardW - 28, characterSpacing: 0.3 }
    );
    doc.rect(cx, y + cardH - 4, cardW, 4).fill(card.color);
  });
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

// ---- Radar / spider chart: pass rate per department ----------------------
function drawRadar(doc, cx, cy, radius, deptStats) {
  const n = deptStats.length;
  const angleFor = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / n;

  // Grid rings at 25/50/75/100%
  [0.25, 0.5, 0.75, 1].forEach((frac) => {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = angleFor(i);
      pts.push([cx + Math.cos(a) * radius * frac, cy + Math.sin(a) * radius * frac]);
    }
    doc.polygon(...pts).lineWidth(0.5).stroke(C.line);
  });

  // Axis spokes
  for (let i = 0; i < n; i++) {
    const a = angleFor(i);
    doc.moveTo(cx, cy).lineTo(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius).lineWidth(0.5).stroke(C.line);
  }

  // Data polygon — points with no reviewed items sit at the center.
  const dataPts = deptStats.map((d, i) => {
    const a = angleFor(i);
    const frac = d.passRate === null ? 0 : d.passRate;
    return [cx + Math.cos(a) * radius * frac, cy + Math.sin(a) * radius * frac];
  });
  doc.polygon(...dataPts).fillOpacity(0.28).fill(C.accent);
  doc.fillOpacity(1);
  doc.polygon(...dataPts).lineWidth(1.4).stroke(C.accentStrong);
  dataPts.forEach(([px, py], i) => {
    const d = deptStats[i];
    doc.circle(px, py, 2.4).fill(d.passRate === null ? C.inkFaint : (d.passRate >= 0.9 ? C.ok : d.passRate >= 0.7 ? C.warn : C.bad));
  });

  // Axis labels, aligned by which side of the circle they fall on.
  doc.font("Helvetica").fontSize(7.4).fillColor(C.inkMuted);
  for (let i = 0; i < n; i++) {
    const a = angleFor(i);
    const lx = cx + Math.cos(a) * (radius + 10);
    const ly = cy + Math.sin(a) * (radius + 10);
    const cosA = Math.cos(a);
    let align = "center";
    let boxX = lx - 45;
    let boxW = 90;
    if (cosA > 0.25) { align = "left"; boxX = lx; boxW = 70; }
    else if (cosA < -0.25) { align = "right"; boxX = lx - 70; boxW = 70; }
    doc.text(deptStats[i].label, boxX, ly - 4, { width: boxW, align, lineBreak: false });
  }
}

// ---- Top issues ranking ---------------------------------------------------
function drawTopIssues(doc, x, y, w, deptStats) {
  const issues = deptStats.filter((d) => d.unacceptable > 0).sort((a, b) => b.unacceptable - a.unacceptable);
  if (issues.length === 0) return doc.y;
  const maxCount = issues[0].unacceptable;
  const labelW = 150;
  const countW = 26;
  const barW = w - labelW - countW;
  const rowH = 16;

  // Keep the whole ranking together — an orphaned row or two stranded at
  // the top of an otherwise-blank page reads as broken, not intentional.
  ensureSpace(doc, issues.length * rowH + 4);

  issues.forEach((d) => {
    const rowY = doc.y;
    doc.font("Helvetica").fontSize(8.4).fillColor(C.ink).text(d.label, x, rowY + 3, { width: labelW - 8, lineBreak: false });
    const w2 = Math.max(4, (d.unacceptable / maxCount) * barW);
    doc.roundedRect(x + labelW, rowY + 2, w2, 10, 2).fill(C.bad);
    doc.font("Helvetica-Bold").fontSize(8.4).fillColor(C.bad).text(
      String(d.unacceptable), x + labelW + barW + 6, rowY + 3, { width: countW, lineBreak: false }
    );
    doc.y = rowY + rowH;
  });
  return doc.y;
}

function sectionHeading(doc, text, y) {
  doc.font("Helvetica-Bold").fontSize(11.5).fillColor(C.ink).text(text, MARGIN, y);
  return doc.y + 6;
}

// Small vector pass/fail/pending marker — drawn with primitives rather than
// unicode check/cross glyphs, since pdfkit's standard Helvetica encoding
// doesn't reliably include those symbols.
function drawStatusIcon(doc, cx, cy, status) {
  const r = 5;
  if (status === "A") {
    doc.circle(cx, cy, r).fill(C.ok);
    doc.lineWidth(1.3).lineCap("round").lineJoin("round")
      .moveTo(cx - 2.3, cy + 0.2).lineTo(cx - 0.6, cy + 2.1).lineTo(cx + 2.5, cy - 2.3)
      .stroke("#FFFFFF");
  } else if (status === "U") {
    doc.circle(cx, cy, r).fill(C.bad);
    doc.lineWidth(1.3).lineCap("round")
      .moveTo(cx - 2.1, cy - 2.1).lineTo(cx + 2.1, cy + 2.1)
      .moveTo(cx - 2.1, cy + 2.1).lineTo(cx + 2.1, cy - 2.1)
      .stroke("#FFFFFF");
  } else {
    doc.circle(cx, cy, r).lineWidth(1).stroke(C.lineStrong);
  }
}

// ---- Full checklist appendix — every item, grouped by department ---------
function drawFullChecklist(doc, deptStats) {
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
      const label = "#" + item.id + " — " + item.text;
      doc.font("Helvetica").fontSize(8.4);
      const textH = doc.heightOfString(label, { width: textW });
      const rowH = Math.max(13, textH) + 4;
      ensureSpace(doc, rowH);
      const rowY = doc.y;
      drawStatusIcon(doc, MARGIN + 6, rowY + Math.min(8.5, rowH / 2), item.status);
      const color = item.status === "U" ? C.bad : item.status === "A" ? C.ink : C.inkFaint;
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

function generatePdf(res, { settings, items, history, archiveInfo }) {
  const snapshots = (history && history.snapshots) || [];
  const recurringIssues = (history && history.recurringIssues) || [];
  const doc = new PDFDocument({ size: "LETTER", margin: MARGIN });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="VF-0033-00-audit-' + (settings.audit_date || "draft").replace(/\//g, "-") + '.pdf"'
  );
  doc.pipe(res);

  const total = items.length;
  const accepted = items.filter((i) => i.status === "A").length;
  const unacceptable = items.filter((i) => i.status === "U").length;
  const notReviewed = total - accepted - unacceptable;
  const deptStats = groupBySection(items);

  // ---- Header band -------------------------------------------------------
  doc.rect(0, 0, PAGE_W, 8).fill(C.accent);

  // Small stepped brand mark, echoing the app's accent/ok/warn/bad palette.
  const markX = PAGE_W - MARGIN - 46;
  doc.rect(markX, 28, 46, 12).fillOpacity(0.9).fill(C.accent);
  doc.rect(markX + 12, 40, 34, 8).fillOpacity(0.9).fill(C.ok);
  doc.rect(markX + 24, 48, 22, 6).fillOpacity(0.9).fill(C.warn);
  doc.fillOpacity(1);

  doc.font("Helvetica-Bold").fontSize(20).fillColor(C.ink).text(settings.title || "Floor Audit Console", MARGIN, 30, { width: 380 });
  doc.font("Helvetica").fontSize(8.5).fillColor(C.accent).text((settings.eyebrow || "").toUpperCase(), MARGIN, doc.y + 1, { width: 380, characterSpacing: 0.4 });
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
  const reviewedPct = total > 0 ? Math.round(((accepted + unacceptable) / total) * 100) : 0;
  const cardsY = drawStatCards(doc, MARGIN, doc.y, CONTENT_W, [
    { label: "Acceptable", value: accepted, sub: "of " + total + " items", color: C.ok },
    { label: "Unacceptable", value: unacceptable, sub: "of " + total + " items", color: C.bad },
    { label: "Not Reviewed", value: notReviewed, sub: reviewedPct + "% reviewed so far", color: C.warn },
  ]);
  doc.y = cardsY + 20;

  // ---- Results by department (stacked bars) -------------------------------
  ensureSpace(doc, 24);
  doc.y = sectionHeading(doc, "Results by Department", doc.y);
  doc.y = drawDeptBars(doc, MARGIN, doc.y, CONTENT_W, deptStats);
  doc.y += 16;

  // ---- Department health radar --------------------------------------------
  const radarNeeded = 210;
  ensureSpace(doc, radarNeeded);
  doc.y = sectionHeading(doc, "Department Health (pass rate)", doc.y);
  const radarCx = MARGIN + CONTENT_W / 2;
  const radarCy = doc.y + 92;
  drawRadar(doc, radarCx, radarCy, 68, deptStats);
  doc.y = radarCy + 92 + 8;

  // ---- Top issues ------------------------------------------------------------
  if (unacceptable > 0) {
    ensureSpace(doc, 30);
    doc.y = sectionHeading(doc, "Top Issues (unacceptable items by department)", doc.y);
    doc.y = drawTopIssues(doc, MARGIN, doc.y, CONTENT_W, deptStats);
    doc.y += 10;
  }

  // ---- Non-Conformance Log ----------------------------------------------
  doc.addPage();
  doc.y = sectionHeading(doc, "Non-Conformance Log", MARGIN);
  const openItems = items.filter((i) => i.status === "U");

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
    const shiftText = "Shift: " + shiftName(settings, item.shift) + "    Supervisor Acknowledgment: " + (item.initials || "Pending");

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

    // Photo evidence, if this deviation has one attached — sized to fit
    // within a modest box inside the card rather than at full resolution.
    let photoImg = null, photoW = 0, photoH = 0, photoLabelH = 0;
    if (item.photo_path && fs.existsSync(item.photo_path)) {
      try {
        photoImg = doc.openImage(item.photo_path);
        const maxW = 200, maxH = 150;
        const scale = Math.min(maxW / photoImg.width, maxH / photoImg.height, 1);
        photoW = Math.round(photoImg.width * scale);
        photoH = Math.round(photoImg.height * scale);
        doc.font("Helvetica-Bold").fontSize(7.6);
        photoLabelH = doc.heightOfString("PHOTO EVIDENCE", { width: cw });
      } catch (e) {
        photoImg = null; // unreadable/missing file on disk — skip silently, text fields still render
      }
    }
    const photoBlockH = photoImg ? fieldGap + photoLabelH + 3 + photoH : 0;
    const boxH = headerH + descH + fieldGap + caH + fieldGap + pmH + fieldGap + shiftH + photoBlockH + 4;

    ensureSpace(doc, boxH + 10);
    const boxY = doc.y;
    doc.rect(MARGIN, boxY, 3, boxH).fill(C.bad);

    doc.font("Helvetica-Bold").fontSize(10.5).fillColor(C.ink).text("#" + item.id + "  " + shortLabel(item.section), cx, boxY, { width: cw - 90 });

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

    if (photoImg) {
      ly = doc.y + fieldGap;
      doc.font("Helvetica-Bold").fontSize(7.6).fillColor(C.inkFaint).text(
        "PHOTO EVIDENCE", cx, ly, { width: cw, characterSpacing: 0.3, lineBreak: false }
      );
      const imgY = doc.y + 3;
      doc.image(photoImg, cx, imgY, { width: photoW, height: photoH });
      doc.y = imgY + photoH;
    }

    doc.y = boxY + boxH + 10;
  });

  // ---- Full Checklist Appendix ----------------------------------------------
  doc.addPage();
  doc.y = sectionHeading(doc, "Full Checklist (all " + total + " items)", MARGIN);
  drawFullChecklist(doc, deptStats);

  // ---- Audit Trend ------------------------------------------------------------
  doc.addPage();
  doc.y = sectionHeading(doc, "Audit Trend — Unacceptable Items Over Time", MARGIN);
  doc.y = drawAuditTrendChart(doc, MARGIN, doc.y + 6, CONTENT_W, snapshots);
  doc.y += 18;

  ensureSpace(doc, 30);
  doc.y = sectionHeading(doc, "Recurring Issues (most frequently flagged)", doc.y);
  doc.y = drawRecurringIssues(doc, MARGIN, doc.y, CONTENT_W, recurringIssues);

  // ---- Sign-off ------------------------------------------------------------
  ensureSpace(doc, 90);
  doc.moveDown(0.6);
  doc.moveTo(MARGIN, doc.y).lineTo(PAGE_W - MARGIN, doc.y).lineWidth(0.8).stroke(C.line);
  doc.y += 12;
  doc.font("Helvetica-Bold").fontSize(12).fillColor(C.ink).text("SQF Sign-Off");
  doc.font("Helvetica").fontSize(10).fillColor(C.inkMuted);
  doc.text("QA Lead / Tech Initials: " + (settings.qa_initials || "—"));
  doc.text("Reviewed By (SQF Practitioner): " + (settings.reviewed_by || "—"));
  doc.text("Date: " + (settings.reviewed_date || "—"));

  doc.moveDown(1.2);
  doc.fontSize(8).fillColor(C.inkFaint).text(
    "VF-0033-00 GMP Audit Form · Written by Michael Asante · Revise Date " + (settings.revision_date || "—")
  );

  doc.end();
}

module.exports = { generatePdf };
