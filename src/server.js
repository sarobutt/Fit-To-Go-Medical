const bcrypt = require('bcryptjs');
const config = require('./config');
const { createPool, migrate } = require('./db');
const { createApp } = require('./app');

/** On the live site, stop with a clear message rather than run with settings that would be unsafe. */
function checkProductionSettings() {
  if (!config.isProduction) return;
  const problems = [];
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    problems.push('SESSION_SECRET must be set to a random string of at least 32 characters.');
  }
  if (!config.appUrl.startsWith('https://')) problems.push('APP_URL must start with https://');
  if (!config.stripeSecretKey || !config.stripeWebhookSecret) {
    problems.push('STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET must be set.');
  }
  if (problems.length) throw new Error(`Not starting - fix these settings first:\n- ${problems.join('\n- ')}`);
}

/**
 * First start of a fresh database: create the first administrator from ADMIN_EMAIL / ADMIN_PASSWORD.
 * That password only works once - they must choose a new one at first sign-in.
 * No sample clinics, tests or demo accounts are added.
 */
async function ensureFirstAdmin(pool) {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  const { rowCount } = await pool.query(`SELECT 1 FROM users WHERE role = 'admin' LIMIT 1`);
  if (rowCount) return;
  if (!email || password.length < 12) {
    console.warn('No administrator yet. Set ADMIN_EMAIL and ADMIN_PASSWORD (12+ characters) and restart to create one.');
    return;
  }
  await pool.query(
    `INSERT INTO users (role, name, email, password_hash, must_change_password)
     VALUES ('admin', 'Clinic Administrator', $1, $2, TRUE)`, [email, await bcrypt.hash(password, 12)]);
  console.log(`Created the first administrator (${email}). Sign in at ${config.appUrl}/staff/login.`);
}

async function main() {
  checkProductionSettings();
  const pool = createPool();
  await migrate(pool);
  await ensureFirstAdmin(pool);
  const app = createApp(pool);
  app.listen(config.port, () => {
    console.log(`${config.siteName} running at ${config.appUrl}`);
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
