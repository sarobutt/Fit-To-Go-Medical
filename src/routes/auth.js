const express = require('express');
const bcrypt = require('bcryptjs');
const { homeFor, isStaff } = require('../auth');
const { tooManyAttempts, recordFailure, clearFailures } = require('../ratelimit');
const config = require('../config');
const { audit } = require('../services/audit');
const time = require('../time');
const { backUrl } = require('../util');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Compared against when the email is unknown, so response time doesn't reveal which emails have accounts.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

async function checkPassword(user, password) {
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  return Boolean(user && ok);
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
    const passwordOk = await checkPassword(user, password);
    // Staff sign in at /staff/login. Someone who got a staff password right is pointed there;
    // anyone else just sees the usual message, so the page doesn't reveal which emails are staff.
    if (passwordOk && isStaff(user)) {
      return res.redirect(303, '/staff/login?from=patient');
    }
    if (!passwordOk) {
      recordFailure(key);
      res.locals.flash = [{ type: 'error', message: 'Email or password is incorrect.' }];
      return res.status(401).render('auth/login', { title: 'Sign in', email });
    }
    if (!user.is_active) {
      res.locals.flash = [{ type: 'error', message: 'This account has been deactivated. Please contact the clinic.' }];
      return res.status(403).render('auth/login', { title: 'Sign in', email });
    }
    clearFailures(key);
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
    const minLength = isStaff(req.user) ? config.staffMinPasswordLength : 8;
    if (!(await bcrypt.compare(String(req.body.current_password || ''), row.password_hash))) {
      req.flash('error', 'Your current password is incorrect.');
    } else if (next.length < minLength) {
      req.flash('error', `New password must be at least ${minLength} characters.`);
    } else {
      await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user.id, await bcrypt.hash(next, 12)]);
      await audit(db, req.user.id, 'auth.change_password', 'user', req.user.id);
      req.flash('success', 'Password changed.');
    }
    res.redirect(back);
  });

  router.post('/logout', (req, res, next) => {
    const staff = isStaff(req.user);
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie('ftg.sid');
      res.redirect(staff ? '/staff/login' : '/');
    });
  });

  return router;
};

module.exports.checkPassword = checkPassword;
