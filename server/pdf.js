const PDFDocument = require("pdfkit");

function shiftName(settings, slot) {
  if (!slot) return "—";
  return settings["shift" + slot + "_name"] || ("Shift " + slot);
}

function generatePdf(res, { settings, items }) {
  const doc = new PDFDocument({ size: "LETTER", margin: 42 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="VF-0033-00-audit-' + (settings.audit_date || "draft").replace(/\//g, "-") + '.pdf"'
  );
  doc.pipe(res);

  doc.fontSize(18).font("Helvetica-Bold").text(settings.title || "Floor Audit Console");
  doc.fontSize(9).font("Helvetica").fillColor("#555").text(settings.eyebrow || "");
  doc.moveDown(0.5);
  doc.fontSize(10).fillColor("#000").font("Helvetica-Bold").text(
    "Auditor: " + (settings.auditor || "—") + "    Date: " + (settings.audit_date || "—")
  );
  doc.moveDown(1);

  const total = items.length;
  const accepted = items.filter((i) => i.status === "A").length;
  const unacceptable = items.filter((i) => i.status === "U").length;
  doc.font("Helvetica").fontSize(10).text(
    "Reviewed " + (accepted + unacceptable) + "/" + total +
    "   ·   Acceptable " + accepted +
    "   ·   Unacceptable " + unacceptable
  );
  doc.moveDown(1);

  const openItems = items.filter((i) => i.status === "U");
  doc.font("Helvetica-Bold").fontSize(13).text("Non-Conformance Log");
  doc.moveDown(0.3);

  if (openItems.length === 0) {
    doc.font("Helvetica").fontSize(10).fillColor("#333").text("No deviations logged.");
  }

  openItems.forEach((item) => {
    if (doc.y > 680) doc.addPage();
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#000").text(
      "#" + item.id + "  " + item.section
    );
    doc.font("Helvetica").fontSize(9.5).fillColor("#333");
    doc.text("Description: " + (item.description || item.text));
    doc.text("Corrective Action: " + (item.corrective_action || "—"));
    doc.text("Preventive Measures: " + (item.preventive_measures || "—"));
    doc.text(
      "Shift: " + shiftName(settings, item.shift) +
      "    Supervisor Acknowledgment: " + (item.initials || "NOT ACKNOWLEDGED")
    );
    doc.moveDown(0.6);
  });

  doc.moveDown(1);
  if (doc.y > 650) doc.addPage();
  doc.font("Helvetica-Bold").fontSize(12).fillColor("#000").text("SQF Sign-Off");
  doc.font("Helvetica").fontSize(10).fillColor("#333");
  doc.text("QA Lead / Tech Initials: " + (settings.qa_initials || "—"));
  doc.text("Reviewed By (SQF Practitioner): " + (settings.reviewed_by || "—"));
  doc.text("Date: " + (settings.reviewed_date || "—"));

  doc.moveDown(1.2);
  doc.fontSize(8).fillColor("#888").text(
    "VF-0033-00 GMP Audit Form · Written by Michael Asante · Revise Date " + (settings.revision_date || "—")
  );

  doc.end();
}

module.exports = { generatePdf };
