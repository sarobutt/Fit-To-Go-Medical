const fs = require('node:fs');
const path = require('node:path');

// Always read .env from the project folder, wherever the command is run from.
const envFile = path.join(__dirname, '..', '.env');
require('dotenv').config({ path: envFile, quiet: true });

const env = process.env;

function isLocalHost(connectionString) {
  try {
    const { hostname } = new URL(connectionString);
    return ['localhost', '127.0.0.1', '::1', ''].includes(hostname);
  } catch {
    return false;
  }
}

module.exports = {
  siteName: env.SITE_NAME || 'Fit to go medical',
  port: parseInt(env.PORT || '3000', 10),
  appUrl: (env.APP_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  isProduction: env.NODE_ENV === 'production',
  sessionSecret: env.SESSION_SECRET || 'dev-only-secret-change-me',

  envFile,
  envFileExists: fs.existsSync(envFile),
  databaseUrl: env.DATABASE_URL,
  // Hosted Postgres (Neon, Supabase, Render, Railway...) needs SSL; a local database usually does not.
  databaseSsl(connectionString) {
    if (env.DATABASE_SSL === 'true') return true;
    if (env.DATABASE_SSL === 'false') return false;
    return !isLocalHost(connectionString);
  },
  databaseSslVerify: env.DATABASE_SSL_VERIFY !== 'false',

  // Clinic wall-clock zone: slot times are stored and shown in this zone.
  timeZone: env.CLINIC_TIMEZONE || 'Europe/London',
  currency: (env.CURRENCY || 'gbp').toLowerCase(),

  stripeSecretKey: env.STRIPE_SECRET_KEY,
  stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,

  // Outgoing email (for sending reports to patients). Leave SMTP_HOST empty to turn email off.
  smtp: {
    host: env.SMTP_HOST,
    port: parseInt(env.SMTP_PORT || '587', 10),
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.MAIL_FROM || `${env.SITE_NAME || 'Fit to go medical'} <no-reply@example.com>`,
  },

  // Stripe Checkout sessions last at least 30 minutes, so the slot is held that long.
  holdMinutes: 30,
  // Staff (doctors & admins) are signed out after this much inactivity.
  staffIdleMinutes: parseInt(env.STAFF_IDLE_MINUTES || '30', 10),
  staffMinPasswordLength: 12,
  // Optional: comma-separated IP addresses allowed to reach staff pages (e.g. the clinic's connection).
  staffAllowedIps: (env.STAFF_ALLOWED_IPS || '').split(',').map((s) => s.trim()).filter(Boolean),

  // Patients may cancel (with a full refund) up to this many hours before the appointment.
  cancellationHours: parseInt(env.CANCELLATION_HOURS || '24', 10),
};
