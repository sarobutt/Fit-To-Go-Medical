/**
 * Staff (doctor & admin) sign-in: password, then a 6-digit code from an
 * authenticator app. First-time staff scan a QR code to set the app up.
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const config = require('../config');
const totp = require('../totp');
const { homeFor, isStaff, notFound } = require('../auth');
const { checkPassword } = require('./auth');
const { tooManyAttempts, recordFailure, clearFailures } = require('../ratelimit');
const { audit } = require('../services/audit');

const PENDING_MINUTES = 5;
const MAX_CODE_ATTEMPTS = 5;

module.exports = (db) => {
  const router = express.Router();

  /** The staff member who has passed the password step but not the code step yet. */
  async function pendingStaff(req) {
    const p = req.session.pendingStaff;
    if (!p || Date.now() - p.at > PENDING_MINUTES * 60_000) return null;
    const user = await db.one(
      `SELECT * FROM users WHERE id = $1 AND is_active AND role IN ('doctor', 'admin')`, [p.id]);
    return user || null;
  }

  function restart(req, res, message) {
    delete req.session.pendingStaff;
    req.flash('error', message);
    res.redirect('/staff/login');
  }

  function completeSignIn(req, res, next, user) {
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = user.id;
      req.session.staffVerified = true;
      req.session.lastSeen = Date.now();
      res.redirect(homeFor(user));
    });
  }

  router.get('/login', (req, res) => {
    if (isStaff(req.user)) return res.redirect(homeFor(req.user));
    res.render('staff/login', { title: 'Staff sign in', email: '' });
  });

  router.post('/login', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const key = `staff|${email}|${req.ip}`;
    const fail = (status, message) => {
      res.locals.flash = [{ type: 'error', message }];
      res.status(status).render('staff/login', { title: 'Staff sign in', email });
    };
    if (tooManyAttempts(key, 5)) return fail(429, 'Too many attempts. Please wait 15 minutes and try again.');

    const user = await db.one('SELECT * FROM users WHERE lower(email) = $1', [email]);
    const ok = await checkPassword(user, password);
    if (!ok || !isStaff(user) || !user.is_active) {
      recordFailure(key);
      if (user && isStaff(user)) await audit(db, user.id, 'auth.staff_login_failed', 'user', user.id, { ip: req.ip });
      return fail(401, 'Email or password is incorrect.');
    }
    clearFailures(key);
    req.session.pendingStaff = { id: user.id, at: Date.now(), attempts: 0 };
    res.redirect(user.totp_enabled ? '/staff/verify' : '/staff/setup');
  });

  // ---------- First sign-in: connect an authenticator app ----------
  router.get('/setup', async (req, res) => {
    const user = await pendingStaff(req);
    if (!user) return restart(req, res, 'Please sign in again.');
    if (user.totp_enabled) return res.redirect('/staff/verify');
    req.session.pendingStaff.secret ||= totp.generateSecret();
    const { secret } = req.session.pendingStaff;
    const uri = totp.keyUri({ secret, account: user.email, issuer: config.siteName });
    const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
    res.render('staff/setup', { title: 'Set up two-step sign-in', qr, secret: secret.match(/.{1,4}/g).join(' ') });
  });

  router.post('/setup', async (req, res, next) => {
    const user = await pendingStaff(req);
    const pending = req.session.pendingStaff;
    if (!user || !pending?.secret) return restart(req, res, 'Please sign in again.');
    const step = totp.verify(pending.secret, req.body.code);
    if (step === null) {
      pending.attempts++;
      if (pending.attempts >= MAX_CODE_ATTEMPTS) return restart(req, res, 'Too many incorrect codes. Please sign in again.');
      req.flash('error', 'That code didn\'t match. Check your phone\'s clock is set automatically and try the newest code.');
      return res.redirect('/staff/setup');
    }
    await db.query(
      'UPDATE users SET totp_secret = $2, totp_enabled = TRUE, totp_last_step = $3 WHERE id = $1',
      [user.id, pending.secret, step]);
    await audit(db, user.id, 'auth.2fa_enabled', 'user', user.id);
    await audit(db, user.id, 'auth.staff_login', 'user', user.id, { ip: req.ip });
    completeSignIn(req, res, next, user);
  });

  // ---------- Every sign-in: enter the current code ----------
  router.get('/verify', async (req, res) => {
    const user = await pendingStaff(req);
    if (!user) return restart(req, res, 'Please sign in again.');
    if (!user.totp_enabled) return res.redirect('/staff/setup');
    res.render('staff/verify', { title: 'Enter your code' });
  });

  router.post('/verify', async (req, res, next) => {
    const user = await pendingStaff(req);
    const pending = req.session.pendingStaff;
    if (!user || !user.totp_enabled) return restart(req, res, 'Please sign in again.');
    const step = totp.verify(user.totp_secret, req.body.code, user.totp_last_step);
    // Record the used code atomically so the same code can't be replayed.
    const accepted = step !== null && (await db.query(
      `UPDATE users SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)`,
      [user.id, step])).rowCount === 1;
    if (!accepted) {
      pending.attempts++;
      await audit(db, user.id, 'auth.2fa_failed', 'user', user.id, { ip: req.ip });
      if (pending.attempts >= MAX_CODE_ATTEMPTS) return restart(req, res, 'Too many incorrect codes. Please sign in again.');
      req.flash('error', 'That code didn\'t work. Enter the newest 6-digit code from your authenticator app.');
      return res.redirect('/staff/verify');
    }
    await audit(db, user.id, 'auth.staff_login', 'user', user.id, { ip: req.ip });
    completeSignIn(req, res, next, user);
  });

  // ---------- Replace a temporary password ----------
  router.get('/change-password', (req, res) => {
    if (!isStaff(req.user)) return notFound(res);
    res.render('staff/change-password', { title: 'Choose a new password', minLength: config.staffMinPasswordLength });
  });

  router.post('/change-password', async (req, res) => {
    if (!isStaff(req.user)) return notFound(res);
    const password = String(req.body.new_password || '');
    const row = await db.one('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    let error = null;
    if (password.length < config.staffMinPasswordLength) {
      error = `Your password must be at least ${config.staffMinPasswordLength} characters.`;
    } else if (password !== req.body.confirm_password) {
      error = 'The two passwords don\'t match.';
    } else if (await bcrypt.compare(password, row.password_hash)) {
      error = 'Choose a different password from the temporary one.';
    }
    if (error) {
      req.flash('error', error);
      return res.redirect('/staff/change-password');
    }
    await db.query('UPDATE users SET password_hash = $2, must_change_password = FALSE WHERE id = $1',
      [req.user.id, await bcrypt.hash(password, 12)]);
    await audit(db, req.user.id, 'auth.change_password', 'user', req.user.id);
    req.flash('success', 'Password updated.');
    res.redirect(homeFor(req.user));
  });

  return router;
};
