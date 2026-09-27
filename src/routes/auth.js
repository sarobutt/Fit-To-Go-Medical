const express = require('express');
const bcrypt = require('bcryptjs');
const { homeFor } = require('../auth');
const { audit } = require('../services/audit');
const time = require('../time');
const { backUrl } = require('../util');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Simple in-memory brake on password guessing: 10 failures per email+IP per 15 minutes.
const failures = new Map();
function tooManyAttempts(key) {
  const entry = failures.get(key);
  if (!entry || entry.until < Date.now()) return false;
  return entry.count >= 10;
}
function recordFailure(key) {
  const entry = failures.get(key);
  if (!entry || entry.until < Date.now()) failures.set(key, { count: 1, until: Date.now() + 15 * 60_000 });
  else entry.count++;
}

function signIn(req, user, cb) {
  const returnTo = req.session.returnTo;
  req.session.regenerate((err) => {
    if (err) return cb(err);
    req.session.userId = user.id;
    cb(null, returnTo && returnTo.startsWith(`/${user.role}`) ? returnTo : homeFor(user));
  });
}

module.exports = (db) => {
  const router = express.Router();

  router.get('/login', (req, res) => {
    if (req.user) return res.redirect(homeFor(req.user));
    res.render('auth/login', { title: 'Sign in', email: '' });
  });

  router.post('/login', async (req, res, next) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const key = `${email}|${req.ip}`;
    if (tooManyAttempts(key)) {
      res.locals.flash = [{ type: 'error', message: 'Too many attempts. Please wait 15 minutes and try again.' }];
      return res.status(429).render('auth/login', { title: 'Sign in', email });
    }
    const user = await db.one('SELECT * FROM users WHERE lower(email) = $1', [email]);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      recordFailure(key);
      res.locals.flash = [{ type: 'error', message: 'Email or password is incorrect.' }];
      return res.status(401).render('auth/login', { title: 'Sign in', email });
    }
    if (!user.is_active) {
      res.locals.flash = [{ type: 'error', message: 'This account has been deactivated. Please contact the clinic.' }];
      return res.status(403).render('auth/login', { title: 'Sign in', email });
    }
    failures.delete(key);
    await audit(db, user.id, 'auth.login', 'user', user.id);
    signIn(req, user, (err, dest) => (err ? next(err) : res.redirect(dest)));
  });

  router.get('/register', (req, res) => {
    if (req.user) return res.redirect(homeFor(req.user));
    res.render('auth/register', { title: 'Create an account', form: {} });
  });

  router.post('/register', async (req, res, next) => {
    const form = {
      name: String(req.body.name || '').trim(),
      email: String(req.body.email || '').trim().toLowerCase(),
      phone: String(req.body.phone || '').trim(),
      date_of_birth: String(req.body.date_of_birth || '').trim(),
    };
    const password = String(req.body.password || '');
    const errors = [];
    if (form.name.length < 2) errors.push('Please enter your full name.');
    if (!EMAIL.test(form.email)) errors.push('Please enter a valid email address.');
    if (password.length < 8) errors.push('Password must be at least 8 characters.');
    if (password !== req.body.confirm_password) errors.push('Passwords do not match.');
    if (form.date_of_birth && (!time.isDate(form.date_of_birth) || form.date_of_birth > time.todayLocal())) {
      errors.push('Please enter a valid date of birth.');
    }
    if (!errors.length && await db.one('SELECT 1 FROM users WHERE lower(email) = $1', [form.email])) {
      errors.push('An account with that email already exists. Try signing in.');
    }
    if (errors.length) {
      res.locals.flash = errors.map((message) => ({ type: 'error', message }));
      return res.status(400).render('auth/register', { title: 'Create an account', form });
    }
    const user = await db.one(
      `INSERT INTO users (role, name, email, password_hash, phone, date_of_birth)
       VALUES ('patient', $1, $2, $3, $4, $5) RETURNING *`,
      [form.name, form.email, await bcrypt.hash(password, 12), form.phone || null, form.date_of_birth || null],
    );
    await audit(db, user.id, 'auth.register', 'user', user.id);
    signIn(req, user, (err, dest) => {
      if (err) return next(err);
      req.flash('success', `Welcome to ${req.app.locals.siteName}, ${user.name.split(' ')[0]}!`);
      res.redirect(dest);
    });
  });

  router.post('/account/password', async (req, res) => {
    if (!req.user) return res.redirect('/login');
    const back = backUrl(req, homeFor(req.user));
    const row = await db.one('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const next = String(req.body.new_password || '');
    if (!(await bcrypt.compare(String(req.body.current_password || ''), row.password_hash))) {
      req.flash('error', 'Your current password is incorrect.');
    } else if (next.length < 8) {
      req.flash('error', 'New password must be at least 8 characters.');
    } else {
      await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user.id, await bcrypt.hash(next, 12)]);
      await audit(db, req.user.id, 'auth.change_password', 'user', req.user.id);
      req.flash('success', 'Password changed.');
    }
    res.redirect(back);
  });

  router.post('/logout', (req, res, next) => {
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie('ftg.sid');
      res.redirect('/');
    });
  });

  return router;
};
