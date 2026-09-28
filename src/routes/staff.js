/** Staff (doctor & admin) sign-in with email and password, and replacing a temporary password. */
const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { homeFor, isStaff, notFound } = require('../auth');
const { checkPassword, endOtherSessions } = require('./auth');
const { clearFailures, signInKeys, blocked, recordAll } = require('../ratelimit');
const { audit } = require('../services/audit');

module.exports = (db) => {
  const router = express.Router();

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
    if (req.query.from === 'patient') {
      res.locals.flash = [...res.locals.flash, {
        type: 'info', message: 'Doctors and admins sign in on this page. Please enter your email and password again.',
      }];
    }
    res.render('staff/login', { title: 'Staff sign in', email: '' });
  });

  router.post('/login', async (req, res, next) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const keys = signInKeys('staff', email, req.ip);
    const fail = (status, message) => {
      res.locals.flash = [{ type: 'error', message }];
      res.status(status).render('staff/login', { title: 'Staff sign in', email });
    };
    if (blocked(keys)) return fail(429, 'Too many attempts. Please wait 15 minutes and try again.');

    const user = await db.one('SELECT * FROM users WHERE lower(email) = $1', [email]);
    const ok = await checkPassword(user, password);
    if (!ok || !isStaff(user) || !user.is_active) {
      recordAll(keys);
      if (user && isStaff(user)) await audit(db, user.id, 'auth.staff_login_failed', 'user', user.id, { ip: req.ip });
      return fail(401, 'Email or password is incorrect.');
    }
    clearFailures(keys[0][0]);
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
    await endOtherSessions(db, req.user.id, req.sessionID);
    await audit(db, req.user.id, 'auth.change_password', 'user', req.user.id);
    req.flash('success', 'Password updated.');
    res.redirect(homeFor(req.user));
  });

  return router;
};
