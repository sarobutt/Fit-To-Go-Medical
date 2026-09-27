require('dotenv').config({ quiet: true });

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

  databaseUrl: env.DATABASE_URL,
  // Hosted Postgres (Neon, Supabase, Render, Railway...) needs SSL; a local database usually does not.
  databaseSsl(connectionString) {
    if (env.DATABASE_SSL === 'true') return true;
    if (env.DATABASE_SSL === 'false') return false;
    return !isLocalHost(connectionString);
  },

  // Clinic wall-clock zone: slot times are stored and shown in this zone.
  timeZone: env.CLINIC_TIMEZONE || 'Europe/London',
  currency: (env.CURRENCY || 'gbp').toLowerCase(),

  stripeSecretKey: env.STRIPE_SECRET_KEY,
  stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,

  // Stripe Checkout sessions last at least 30 minutes, so the slot is held that long.
  holdMinutes: 30,
  // Patients may cancel (with a full refund) up to this many hours before the appointment.
  cancellationHours: parseInt(env.CANCELLATION_HOURS || '24', 10),
};
