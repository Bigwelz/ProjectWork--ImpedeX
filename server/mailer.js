/* =============================================
   EIPS — Email Utility (server/mailer.js)
   Sends notification emails to students.
   Falls back to console logging if nodemailer
   is not installed or SMTP is not configured.
============================================= */

"use strict";

let transporter = null;

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "ImpedeX <noreply@impedex.edu.ng>";

function initMailer() {
  if (transporter !== null) return transporter;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.log("[mailer] SMTP not configured — emails will be logged to console.");
    return null;
  }
  try {
    const nodemailer = require("nodemailer");
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
    console.log("[mailer] SMTP transport created.");
    return transporter;
  } catch (err) {
    console.warn("[mailer] nodemailer not available:", err.message);
    return null;
  }
}

async function sendEmail(to, subject, html) {
  const transport = initMailer();
  if (!transport) {
    console.log(`[mailer] EMAIL TO: ${to}`);
    console.log(`[mailer] SUBJECT: ${subject}`);
    console.log(`[mailer] BODY: ${html}`);
    console.log("---");
    return { ok: true, demo: true };
  }
  try {
    await transporter.sendMail({ from: EMAIL_FROM, to, subject, html });
    return { ok: true };
  } catch (err) {
    console.error("[mailer] Failed to send email:", err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { sendEmail, initMailer };
