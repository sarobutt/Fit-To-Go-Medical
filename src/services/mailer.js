/**
 * Sends email through any SMTP provider (Gmail, Outlook, Resend, SendGrid, Mailgun...).
 * If SMTP isn't configured, emails are skipped and patients download documents from their account.
 */
const nodemailer = require('nodemailer');
const config = require('../config');

let transport;

function getTransport() {
  if (transport !== undefined) return transport;
  transport = config.smtp.host
    ? nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    })
    : null;
  return transport;
}

/** Tests swap in a fake transport. */
function setTransport(fake) {
  transport = fake;
}

function emailConfigured() {
  return Boolean(getTransport());
}

async function send(message) {
  const t = getTransport();
  if (!t) return { skipped: true };
  await t.sendMail({ from: config.smtp.from, ...message });
  return { sent: true };
}

module.exports = { send, setTransport, emailConfigured };
