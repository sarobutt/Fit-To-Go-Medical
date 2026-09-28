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

async function main() {
  checkProductionSettings();
  const pool = createPool();
  await migrate(pool);
  const app = createApp(pool);
  app.listen(config.port, () => {
    console.log(`${config.siteName} running at ${config.appUrl}`);
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
