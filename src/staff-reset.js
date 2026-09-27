/**
 * Emergency access for a locked-out doctor or administrator (e.g. the only
 * admin lost their phone). Run on the server with access to the database:
 *   npm run staff:reset -- someone@example.com
 * Gives them a new temporary password and clears their two-step sign-in.
 */
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { createPool, migrate } = require('./db');

async function main(email) {
  if (!email) throw new Error('Usage: npm run staff:reset -- someone@example.com');
  const pool = createPool();
  try {
    await migrate(pool);
    const password = crypto.randomBytes(12).toString('base64url');
    const { rows: [user] } = await pool.query(
      `UPDATE users SET password_hash = $2, must_change_password = TRUE, is_active = TRUE,
              totp_secret = NULL, totp_enabled = FALSE, totp_last_step = NULL
        WHERE lower(email) = lower($1) AND role IN ('doctor', 'admin') RETURNING id, name, role`,
      [email, await bcrypt.hash(password, 12)]);
    if (!user) throw new Error(`No doctor or administrator with email ${email}.`);
    await pool.query(`DELETE FROM "session" WHERE (sess->>'userId')::int = $1`, [user.id]);
    await pool.query(
      `INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES (NULL, 'user.emergency_reset', 'user', $1, $2)`,
      [user.id, JSON.stringify({ via: 'command line' })]);
    console.log(`Reset ${user.name} (${user.role}).`);
    console.log(`Temporary password: ${password}`);
    console.log('They sign in at /staff/login, choose a new password and set up two-step sign-in again.');
  } finally {
    await pool.end();
  }
}

main(process.argv[2]).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
