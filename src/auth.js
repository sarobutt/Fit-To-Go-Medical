const crypto = require('node:crypto');
const config = require('./config');

const DOCTOR_PERMISSIONS = {
  can_manage_availability: 'Manage availability & slots',
  can_check_in: 'Check patients in',
  can_record_results: 'Record notes & results',
  can_view_patient_history: 'View patient history',
  can_cancel_appointments: 'Cancel appointments (with refund)',
};

const STAFF_ROLES = ['doctor', 'admin'];
const isStaff = (user) => Boolean(user && STAFF_ROLES.includes(user.role));

/** Page shown for staff areas to anyone who isn't allowed in, so they don't learn the pages exist. */
function notFound(res) {
  return res.status(404).render('error', { title: 'Page not found', message: 'We could not find that page.' });
}

/**
 * Loads the signed-in user (and doctor permissions) onto req.user / res.locals.user.
 * Staff are signed out after a period of inactivity and must replace a temporary password first.
 */
function loadUser(db) {
  return async (req, res, next) => {
    res.locals.user = null;
    if (!req.session.userId) return next();
    try {
      const user = await db.one(
        `SELECT u.id, u.role, u.name, u.email, u.phone, u.date_of_birth, u.is_active, u.must_change_password,
                dp.can_manage_availability, dp.can_check_in, dp.can_record_results,
                dp.can_view_patient_history, dp.can_cancel_appointments, dp.specialty
           FROM users u LEFT JOIN doctor_profiles dp ON dp.user_id = u.id
          WHERE u.id = $1`,
        [req.session.userId],
      );
      if (!user || !user.is_active) {
        return req.session.regenerate(() => next());
      }
      if (isStaff(user)) {
        const now = Date.now();
        const idleLimit = config.staffIdleMinutes * 60_000;
        // A staff session must come from the staff sign-in and still be fresh.
        if (!req.session.staffVerified || now - (req.session.lastSeen || 0) > idleLimit) {
          return req.session.regenerate((err) => {
            if (err) return next(err);
            req.flash('info', 'You were signed out after a period of inactivity. Please sign in again.');
            res.redirect('/staff/login');
          });
        }
        req.session.lastSeen = now;
        const allowed = ['/staff/change-password', '/logout'];
        if (user.must_change_password && !allowed.includes(req.path)) {
          return res.redirect('/staff/change-password');
        }
      }
      req.user = user;
      res.locals.user = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Staff pages are hidden (404) from anyone outside the optional clinic IP allow-list, and never indexed. */
function staffArea(req, res, next) {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Cache-Control', 'no-store');
  if (config.staffAllowedIps.length && !config.staffAllowedIps.includes(req.ip)) return notFound(res);
  next();
}

/**
 * Only signed-in staff with one of `roles` get through. Visitors and patients see "Page not found";
 * staff signed in with the other role are sent back to their own area with an explanation.
 */
function requireStaff(...roles) {
  return (req, res, next) => {
    if (isStaff(req.user) && !roles.includes(req.user.role)) {
      const area = roles.includes('admin') ? 'admin' : 'doctor';
      req.flash('info', `The ${area} pages are only for ${area} accounts. You're signed in as ${req.user.role === 'admin' ? 'an admin' : 'a doctor'} (${req.user.email}). To use them, sign out and sign in at /staff/login with ${area === 'admin' ? 'an admin' : 'a doctor'}'s email.`);
      return res.redirect(homeFor(req.user));
    }
    if (!req.user || !roles.includes(req.user.role)) return notFound(res);
    next();
  };
}

/** Patient pages: sign-in prompt for visitors. */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      req.session.returnTo = req.originalUrl;
      req.flash('info', 'Please sign in to continue.');
      return res.redirect('/login');
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).render('error', { title: 'Not allowed', message: 'You do not have access to that page.' });
    }
    next();
  };
}

/** Doctor-only guard for a permission an admin can switch off. */
function requirePermission(permission) {
  return (req, res, next) => {
    if (req.user?.role === 'doctor' && req.user[permission]) return next();
    return res.status(403).render('error', {
      title: 'Permission needed',
      message: `An administrator has not given you permission to: ${DOCTOR_PERMISSIONS[permission].toLowerCase()}.`,
    });
  };
}

/** Session-based CSRF token, required on every form POST. */
function csrf(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  if (req.method === 'POST') {
    const sent = String(req.body?._csrf || '');
    const expected = req.session.csrfToken;
    if (sent.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected))) {
      return res.status(403).render('error', {
        title: 'Form expired', message: 'Your session changed while the form was open. Please go back and try again.',
      });
    }
  }
  next();
}

/** Minimal flash messages stored on the session. */
function flash(req, res, next) {
  req.flash = (type, message) => {
    req.session.flash = [...(req.session.flash || []), { type, message }];
  };
  res.locals.flash = req.session.flash || [];
  delete req.session.flash;
  next();
}

function homeFor(user) {
  return { patient: '/patient', doctor: '/doctor', admin: '/admin' }[user.role] || '/';
}

module.exports = {
  DOCTOR_PERMISSIONS, STAFF_ROLES, isStaff, notFound, loadUser, staffArea, requireStaff, requireRole, requirePermission,
  csrf, flash, homeFor,
};
