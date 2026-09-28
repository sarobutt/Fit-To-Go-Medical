/**
 * "Forgot password" for patients: a single-use link, valid for one hour, sent by email.
 * The page never reveals whether an email address has an account.
 * Staff passwords are reset by an admin instead.
 */
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('../config');
const mailer = require('../services/mailer');
const { audit } = require('../services/audit');
const { tooManyAttempts, recordFailure } = require('../ratelimit');

const LINK_MINUTES = 60;
const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

module.exports = (db) => {
  const router = express.Router();

  router.get('/forgot-password', (req, res) => {
    res.render('auth/forgot', { title: 'Reset your password', sent: false, emailOn: mailer.emailConfigured() });
  });

  router.post('/forgot-password', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const key = `reset|${req.ip}`;
    if (tooManyAttempts(key, 5)) {
      res.locals.flash = [{ type: 'error', message: 'Too many requests. Please wait 15 minutes and try again.' }];
      return res.status(429).render('auth/forgot', { title: 'Reset your password', sent: false, emailOn: true });
    }
    recordFailure(key);

    const user = await db.one(
      `SELECT * FROM users WHERE lower(email) = $1 AND role = 'patient' AND is_active`, [email]);
    if (user && mailer.emailConfigured()) {
      const token = crypto.randomBytes(32).toString('base64url');
      await db.query(
        `INSERT INTO password_resets (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + make_interval(mins => $3))`, [user.id, hash(token), LINK_MINUTES]);
      const link = `${config.appUrl}/reset-password/${token}`;
      try {
        await mailer.send({
          to: user.email,
          subject: `Reset your ${config.siteName} password`,
          text: [
            `Dear ${user.name.split(' ')[0]},`, '',
            'We received a request to reset your password. Use this link within the next hour:', '', link, '',
            'If you didn\'t ask for this, you can ignore this email – your password won\'t change.', '',
            config.siteName,
          ].join('\n'),
        });
        await audit(db, user.id, 'auth.reset_requested', 'user', user.id, { ip: req.ip });
      } catch (err) {
        console.error('Password reset email failed:', err.message);
      }
    }
    // Same answer whether or not the account exists.
    res.render('auth/forgot', { title: 'Reset your password', sent: true, emailOn: mailer.emailConfigured() });
  });

  async function findReset(token) {
    return db.one(
      `SELECT r.*, u.email FROM password_resets r JOIN users u ON u.id = r.user_id
        WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.expires_at > now() AND u.is_active`,
      [hash(String(token || ''))]);
  }

  const invalid = (res) => res.status(400).render('error', {
    title: 'Link expired',
    message: 'This password reset link has expired or has already been used. Please request a new one.',
  });

  router.get('/reset-password/:token', async (req, res) => {
    if (!(await findReset(req.params.token))) return invalid(res);
    res.render('auth/reset', { title: 'Choose a new password', token: req.params.token });
  });

  router.post('/reset-password/:token', async (req, res) => {
    const reset = await findReset(req.params.token);
    if (!reset) return invalid(res);
    const password = String(req.body.new_password || '');
    let error = null;
    if (password.length < 8) error = 'Your password must be at least 8 characters.';
    else if (password !== req.body.confirm_password) error = 'The two passwords don\'t match.';
    if (error) {
      res.locals.flash = [{ type: 'error', message: error }];
      return res.status(400).render('auth/reset', { title: 'Choose a new password', token: req.params.token });
    }
    await db.tx(async (c) => {
      await c.query('UPDATE users SET password_hash = $2 WHERE id = $1', [reset.user_id, await bcrypt.hash(password, 12)]);
      // Use up this link and any others, and sign the account out everywhere.
      await c.query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [reset.user_id]);
      await c.query(`DELETE FROM "session" WHERE (sess->>'userId')::int = $1`, [reset.user_id]);
      await audit(c, reset.user_id, 'auth.reset_password', 'user', reset.user_id, { ip: req.ip });
    });
    req.flash('success', 'Your password has been changed. Please sign in with your new password.');
    res.redirect('/login');
  });

  return router;
};
