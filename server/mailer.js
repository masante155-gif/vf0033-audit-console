const nodemailer = require("nodemailer");

let transporter = null;
let transporterError = null;

function isConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
  if (!isConfigured()) return null;
  if (transporter) return transporter;
  try {
    const port = Number(process.env.SMTP_PORT || 587);
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: port,
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    return transporter;
  } catch (e) {
    transporterError = e;
    return null;
  }
}

async function sendMail({ to, subject, text, html }) {
  if (!isConfigured()) {
    throw new Error(
      "Email sending isn't configured yet. Set SMTP_HOST, SMTP_USER, and SMTP_PASS (and optionally SMTP_PORT / SMTP_FROM) in the server's environment variables."
    );
  }
  const t = getTransporter();
  if (!t) throw new Error("Couldn't set up the mail server connection: " + (transporterError && transporterError.message));
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  await t.sendMail({ from, to, subject, text, html });
}

module.exports = { sendMail, isConfigured };
