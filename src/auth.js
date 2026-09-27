const crypto = require('node:crypto');

const DOCTOR_PERMISSIONS = {
  can_manage_availability: 'Manage availability & slots',
  can_check_in: 'Check patients in',
  can_record_results: 'Record notes & results',
  can_view_patient_history: 'View patient history',
  can_cancel_appointments: 'Cancel appointments (with refund)',
};

/** Loads the signed-in user (and doctor permissions) onto req.user / res.locals.user. */
function loadUser(db) {
  return async (req, res, next) => {
    res.locals.user = null;
    if (!req.session.userId) return next();
    try {
      const user = await db.one(
        `SELECT u.id, u.role, u.name, u.email, u.phone, u.date_of_birth, u.is_active,
                dp.can_manage_availability, dp.can_check_in, dp.can_record_results,
                dp.can_view_patient_history, dp.can_cancel_appointments, dp.specialty
           FROM users u LEFT JOIN doctor_profiles dp ON dp.user_id = u.id
          WHERE u.id = $1`,
        [req.session.userId],
      );
      if (!user || !user.is_active) {
        return req.session.regenerate(() => next());
      }
      req.user = user;
      res.locals.user = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

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

module.exports = { DOCTOR_PERMISSIONS, loadUser, requireRole, requirePermission, csrf, flash, homeFor };
