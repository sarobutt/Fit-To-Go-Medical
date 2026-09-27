const config = require('./config');
const { createPool, migrate } = require('./db');
const { createApp } = require('./app');

async function main() {
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
