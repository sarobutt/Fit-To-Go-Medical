const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const { requireStaff, DOCTOR_PERMISSIONS } = require('../auth');
const bookings = require('../services/bookings');
const availability = require('../services/availability');
const { ValidationError, LIVE_STATUSES } = availability;
const { createRepeating } = require('./doctor');
const { audit } = require('../services/audit');
const time = require('../time');
const { backUrl } = require('../util');
const consultation = require('../services/consultation');
const { consultationRoutes, takeDraft } = require('./consultation');

/** Signs a user out everywhere by deleting their stored sessions. */
async function endSessions(db, userId) {
  await db.query(`DELETE FROM "session" WHERE (sess->>'userId')::int = $1`, [userId]);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const id = (v) => parseInt(v, 10) || 0;
const text = (v, max = 2000) => String(v ?? '').trim().slice(0, max);
const bool = (v) => v === 'on' || v === 'true' || v === '1';

function toPence(value) {
  const n = Number(String(value).replace(/[£$€,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > 100000) throw new ValidationError('Enter a valid price.');
  return Math.round(n * 100);
}

function temporaryPassword() {
  return crypto.randomBytes(9).toString('base64url');
}

const APPOINTMENT_SELECT = `
  SELECT a.*, s.starts_at, s.ends_at, s.doctor_id, s.clinic_id, t.name AS test_name,
         c.name AS clinic_name, d.name AS doctor_name, p.name AS patient_name, p.email AS patient_email
    FROM appointments a
    JOIN slots s ON s.id = a.slot_id
    JOIN tests t ON t.id = a.test_id
    JOIN clinics c ON c.id = s.clinic_id
    JOIN users d ON d.id = s.doctor_id
    JOIN users p ON p.id = a.patient_id`;

module.exports = (db) => {
  const router = express.Router();
  router.use(requireStaff('admin'));
  // Shown as a number next to "Data requests" in the admin menu.
  router.use(async (req, res, next) => {
    res.locals.openRequests = (await db.one(`SELECT COUNT(*) AS n FROM data_requests WHERE status = 'open'`)).n;
    next();
  });

  // ---------- Dashboard ----------
  router.get('/', async (req, res) => {
    await bookings.sweepExpiredHolds(db);
    const today = time.todayLocal();
    const from30 = time.addDays(today, -29);
    const now = time.nowLocal();

    const kpis = await db.one(
      `SELECT
         (SELECT COALESCE(SUM(amount_pence), 0) FROM payments
           WHERE status = 'paid' AND paid_at >= date_trunc('month', now())) AS revenue_month,
         (SELECT COALESCE(SUM(amount_pence), 0) FROM payments WHERE status = 'refunded'
           AND refunded_at >= date_trunc('month', now())) AS refunded_month,
         (SELECT COUNT(*) FROM appointments a JOIN slots s ON s.id = a.slot_id
           WHERE a.status IN ('confirmed', 'checked_in') AND s.starts_at >= $1 AND s.starts_at::date <= $2) AS upcoming_7d,
         (SELECT COUNT(*) FROM users WHERE role = 'patient') AS patients,
         (SELECT COUNT(*) FROM users WHERE role = 'patient' AND created_at >= now() - interval '30 days') AS new_patients,
         (SELECT COUNT(*) FROM appointments a JOIN slots s ON s.id = a.slot_id
           WHERE s.starts_at::date = $3 AND a.status IN ('confirmed', 'checked_in', 'completed', 'no_show')) AS today_total,
         (SELECT COUNT(*) FROM appointments a JOIN slots s ON s.id = a.slot_id
           WHERE s.starts_at::date = $3 AND a.status IN ('checked_in', 'completed')) AS today_seen`,
      [now, time.addDays(today, 7), today]);

    const clinics = await db.all(
      `SELECT c.id, c.name, c.city, c.is_active,
              COUNT(DISTINCT s.id) FILTER (WHERE NOT s.is_blocked) AS slots,
              COUNT(a.id) FILTER (WHERE a.status IN ('confirmed', 'checked_in', 'completed', 'no_show')) AS booked,
              COUNT(a.id) FILTER (WHERE a.status = 'completed') AS completed,
              COUNT(a.id) FILTER (WHERE a.status = 'cancelled') AS cancelled,
              COUNT(a.id) FILTER (WHERE a.status = 'no_show') AS no_shows,
              COALESCE(SUM(a.price_pence) FILTER (WHERE a.status IN ('confirmed', 'checked_in', 'completed', 'no_show')), 0) AS revenue
         FROM clinics c
         LEFT JOIN slots s ON s.clinic_id = c.id AND s.starts_at::date BETWEEN $1 AND $2
         LEFT JOIN appointments a ON a.slot_id = s.id
        GROUP BY c.id ORDER BY c.name`, [from30, time.addDays(today, 7)]);

    const daily = await db.all(
      `SELECT d::date AS day, COUNT(a.id) AS n
         FROM generate_series($1::date, $2::date, interval '1 day') d
         LEFT JOIN appointments a ON a.created_at::date = d::date
              AND a.status NOT IN ('expired', 'pending_payment')
        GROUP BY d ORDER BY d`, [time.addDays(today, -13), today]);

    const topTests = await db.all(
      `SELECT t.name, COUNT(a.id) AS n, COALESCE(SUM(a.price_pence), 0) AS revenue
         FROM tests t LEFT JOIN appointments a ON a.test_id = t.id
              AND a.status IN ('confirmed', 'checked_in', 'completed', 'no_show') AND a.created_at >= now() - interval '30 days'
        GROUP BY t.id ORDER BY n DESC, t.name LIMIT 6`);

    const todayList = await db.all(
      `${APPOINTMENT_SELECT} WHERE s.starts_at::date = $1 AND a.status NOT IN ('expired', 'pending_payment')
        ORDER BY s.starts_at LIMIT 50`, [today]);

    res.render('admin/dashboard', { title: 'Overview', kpis, clinics, daily, topTests, todayList });
  });

  // ---------- Clinics ----------
  router.get('/clinics', async (req, res) => {
    const clinics = await db.all(
      `SELECT c.*, COUNT(dc.doctor_id) AS doctors FROM clinics c
         LEFT JOIN doctor_clinics dc ON dc.clinic_id = c.id GROUP BY c.id ORDER BY c.name`);
    res.render('admin/clinics', { title: 'Clinics', clinics });
  });

  router.get('/clinics/new', (req, res) => {
    res.render('admin/clinic-form', { title: 'New clinic', clinic: {}, doctors: [] });
  });

  function clinicFields(body) {
    const f = {
      name: text(body.name, 200), address: text(body.address, 500), city: text(body.city, 100),
      phone: text(body.phone, 50), opening_hours: text(body.opening_hours, 500),
    };
    if (!f.name || !f.address || !f.city) throw new ValidationError('Name, address and city are required.');
    return f;
  }

  router.post('/clinics', async (req, res) => {
    const f = clinicFields(req.body);
    const clinic = await db.one(
      `INSERT INTO clinics (name, address, city, phone, opening_hours) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [f.name, f.address, f.city, f.phone || null, f.opening_hours || null]);
    await audit(db, req.user.id, 'clinic.create', 'clinic', clinic.id, f);
    req.flash('success', 'Clinic created.');
    res.redirect(`/admin/clinics/${clinic.id}`);
  });

  router.get('/clinics/:id', async (req, res) => {
    const clinic = await db.one('SELECT * FROM clinics WHERE id = $1', [id(req.params.id)]);
    if (!clinic) return res.status(404).render('error', { title: 'Not found', message: 'Clinic not found.' });
    const doctors = await db.all(
      `SELECT u.id, u.name, u.is_active FROM users u JOIN doctor_clinics dc ON dc.doctor_id = u.id
        WHERE dc.clinic_id = $1 ORDER BY u.name`, [clinic.id]);
    res.render('admin/clinic-form', { title: clinic.name, clinic, doctors });
  });

  router.post('/clinics/:id', async (req, res) => {
    const f = clinicFields(req.body);
    await db.query(
      `UPDATE clinics SET name = $2, address = $3, city = $4, phone = $5, opening_hours = $6 WHERE id = $1`,
      [id(req.params.id), f.name, f.address, f.city, f.phone || null, f.opening_hours || null]);
    await audit(db, req.user.id, 'clinic.update', 'clinic', id(req.params.id), f);
    req.flash('success', 'Clinic saved.');
    res.redirect(`/admin/clinics/${id(req.params.id)}`);
  });

  router.post('/clinics/:id/toggle', async (req, res) => {
    const clinic = await db.one('UPDATE clinics SET is_active = NOT is_active WHERE id = $1 RETURNING *', [id(req.params.id)]);
    if (!clinic) throw new ValidationError('Clinic not found.');
    await audit(db, req.user.id, clinic.is_active ? 'clinic.activate' : 'clinic.deactivate', 'clinic', clinic.id);
    req.flash('success', clinic.is_active ? 'Clinic reopened for bookings.' : 'Clinic closed to new bookings.');
    res.redirect(backUrl(req, '/admin/clinics'));
  });

  // ---------- Tests ----------
  router.get('/tests', async (req, res) => {
    const tests = await db.all(
      `SELECT t.*, COUNT(a.id) FILTER (WHERE a.status IN ('confirmed', 'checked_in', 'completed')) AS bookings
         FROM tests t LEFT JOIN appointments a ON a.test_id = t.id GROUP BY t.id ORDER BY t.name`);
    res.render('admin/tests', { title: 'Tests & pricing', tests });
  });

  router.get('/tests/new', (req, res) => res.render('admin/test-form', { title: 'New test', test: {} }));

  function testFields(body) {
    const f = {
      name: text(body.name, 200), description: text(body.description), preparation: text(body.preparation),
      price_pence: toPence(body.price), duration_minutes: parseInt(body.duration_minutes, 10), turnaround: text(body.turnaround, 200),
    };
    if (!f.name) throw new ValidationError('Test name is required.');
    if (!Number.isInteger(f.duration_minutes) || f.duration_minutes < 5 || f.duration_minutes > 240) {
      throw new ValidationError('Duration must be between 5 and 240 minutes.');
    }
    return f;
  }

  router.post('/tests', async (req, res) => {
    const f = testFields(req.body);
    const t = await db.one(
      `INSERT INTO tests (name, description, preparation, price_pence, duration_minutes, turnaround)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [f.name, f.description, f.preparation, f.price_pence, f.duration_minutes, f.turnaround]);
    await audit(db, req.user.id, 'test.create', 'test', t.id, f);
    req.flash('success', 'Test created.');
    res.redirect('/admin/tests');
  });

  router.post('/tests/set-all-prices', async (req, res) => {
    const pence = toPence(req.body.price);
    if (pence <= 0) throw new ValidationError('Enter a price above £0.');
    const { rowCount } = await db.query('UPDATE tests SET price_pence = $1', [pence]);
    await audit(db, req.user.id, 'test.set_all_prices', 'test', null, { price_pence: pence, tests: rowCount });
    req.flash('success', `All ${rowCount} tests now cost ${req.app.locals.money(pence)}. Existing bookings keep the price they paid.`);
    res.redirect('/admin/tests');
  });

  router.get('/tests/:id', async (req, res) => {
    const test = await db.one('SELECT * FROM tests WHERE id = $1', [id(req.params.id)]);
    if (!test) return res.status(404).render('error', { title: 'Not found', message: 'Test not found.' });
    res.render('admin/test-form', { title: test.name, test });
  });

  router.post('/tests/:id', async (req, res) => {
    const f = testFields(req.body);
    await db.query(
      `UPDATE tests SET name = $2, description = $3, preparation = $4, price_pence = $5, duration_minutes = $6, turnaround = $7
        WHERE id = $1`,
      [id(req.params.id), f.name, f.description, f.preparation, f.price_pence, f.duration_minutes, f.turnaround]);
    await audit(db, req.user.id, 'test.update', 'test', id(req.params.id), f);
    req.flash('success', 'Test saved. Existing bookings keep the price they paid.');
    res.redirect('/admin/tests');
  });

  router.post('/tests/:id/toggle', async (req, res) => {
    const t = await db.one('UPDATE tests SET is_active = NOT is_active WHERE id = $1 RETURNING *', [id(req.params.id)]);
    if (!t) throw new ValidationError('Test not found.');
    await audit(db, req.user.id, t.is_active ? 'test.activate' : 'test.deactivate', 'test', t.id);
    req.flash('success', t.is_active ? `${t.name} is bookable again.` : `${t.name} hidden from booking.`);
    res.redirect('/admin/tests');
  });

  // ---------- Doctors & permissions ----------
  router.get('/doctors', async (req, res) => {
    const doctors = await db.all(
      `SELECT u.*, dp.*, u.id AS id,
              (SELECT string_agg(c.name, ', ' ORDER BY c.name) FROM doctor_clinics dc JOIN clinics c ON c.id = dc.clinic_id
                WHERE dc.doctor_id = u.id) AS clinic_names
         FROM users u JOIN doctor_profiles dp ON dp.user_id = u.id
        WHERE u.role = 'doctor' ORDER BY u.is_active DESC, u.name`);
    res.render('admin/doctors', { title: 'Doctors', doctors, permissions: DOCTOR_PERMISSIONS });
  });

  router.get('/doctors/new', async (req, res) => {
    const clinics = await db.all('SELECT * FROM clinics ORDER BY name');
    const draft = takeDoctorDraft(req, '/admin/doctors/new');
    res.render('admin/doctor-form', {
      title: 'Add a doctor',
      doctor: draft || { can_manage_availability: true, can_check_in: true, can_record_results: true, can_view_patient_history: true },
      clinics, assigned: draft ? draft.clinic_ids : [], permissions: DOCTOR_PERMISSIONS, stats: null,
    });
  });

  /**
   * GMC reference numbers are 7 digits. Accepts "GMC 1234567" or spaces, and stores just the digits.
   * Required for every doctor, and no two doctors may share one.
   */
  async function checkGmc(body, doctorId = 0) {
    const gmc = String(body.registration_number || '').replace(/\D/g, '');
    if (!/^\d{7}$/.test(gmc)) throw new ValidationError('Enter the doctor\'s GMC number – 7 digits, e.g. 1234567.');
    const taken = await db.one(
      `SELECT u.name FROM doctor_profiles dp JOIN users u ON u.id = dp.user_id
        WHERE dp.registration_number = $1 AND dp.user_id <> $2`, [gmc, doctorId]);
    if (taken) throw new ValidationError(`GMC number ${gmc} is already used by ${taken.name}.`);
    return gmc;
  }

  /** Runs a doctor form handler; on a validation problem, keeps what was typed and shows the form again. */
  function keepDoctorForm(handler, formUrl) {
    return async (req, res, next) => {
      try {
        await handler(req, res);
      } catch (err) {
        if (!(err instanceof ValidationError)) return next(err);
        const { _csrf, password, ...values } = req.body;
        req.session.doctorDraft = { key: formUrl(req), values };
        req.flash('error', err.message);
        res.redirect(formUrl(req));
      }
    };
  }

  function takeDoctorDraft(req, key) {
    const draft = req.session.doctorDraft;
    if (!draft || draft.key !== key) return null;
    delete req.session.doctorDraft;
    const v = draft.values;
    return {
      ...v,
      clinic_ids: [].concat(v.clinic_ids || []).map(id),
      ...Object.fromEntries(Object.keys(DOCTOR_PERMISSIONS).map((p) => [p, bool(v[p])])),
    };
  }

  async function saveDoctorSettings(c, doctorId, body) {
    const perms = Object.keys(DOCTOR_PERMISSIONS);
    await c.query(
      `UPDATE doctor_profiles SET specialty = $2, bio = $3, registration_number = $4,
              ${perms.map((p, i) => `${p} = $${i + 5}`).join(', ')}
        WHERE user_id = $1`,
      [doctorId, text(body.specialty, 200) || null, text(body.bio) || null, body.gmc,
        ...perms.map((p) => bool(body[p]))]);
    const clinicIds = [].concat(body.clinic_ids || []).map(id).filter(Boolean);
    await c.query('DELETE FROM doctor_clinics WHERE doctor_id = $1', [doctorId]);
    for (const cid of clinicIds) {
      await c.query('INSERT INTO doctor_clinics (doctor_id, clinic_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [doctorId, cid]);
    }
  }

  router.post('/doctors', keepDoctorForm(async (req, res) => {
    const name = text(req.body.name, 200);
    const email = text(req.body.email, 200).toLowerCase();
    if (name.length < 2 || !EMAIL.test(email)) throw new ValidationError('Enter the doctor\'s name and a valid email.');
    if (await db.one('SELECT 1 FROM users WHERE lower(email) = $1', [email])) throw new ValidationError('That email is already in use.');
    const gmc = await checkGmc(req.body);
    const password = text(req.body.password, 200) || temporaryPassword();
    if (password.length < 8) throw new ValidationError('Password must be at least 8 characters.');
    const doctor = await db.tx(async (c) => {
      const { rows: [u] } = await c.query(
        `INSERT INTO users (role, name, email, password_hash, phone, must_change_password)
         VALUES ('doctor', $1, $2, $3, $4, TRUE) RETURNING id`,
        [name, email, await bcrypt.hash(password, 12), text(req.body.phone, 50) || null]);
      await c.query('INSERT INTO doctor_profiles (user_id) VALUES ($1)', [u.id]);
      await saveDoctorSettings(c, u.id, { ...req.body, gmc });
      await audit(c, req.user.id, 'doctor.create', 'user', u.id, { email, gmc });
      return u;
    });
    req.flash('success', `Doctor account created. They sign in at ${req.app.locals.staffLoginUrl} with ${email} and the temporary password ${password}. Share it privately – they'll be asked to choose their own password.`);
    res.redirect(`/admin/doctors/${doctor.id}`);
  }, () => '/admin/doctors/new'));

  router.get('/doctors/:id', async (req, res) => {
    const doctor = await db.one(
      `SELECT u.*, dp.* , u.id AS id FROM users u JOIN doctor_profiles dp ON dp.user_id = u.id WHERE u.id = $1`, [id(req.params.id)]);
    if (!doctor) return res.status(404).render('error', { title: 'Not found', message: 'Doctor not found.' });
    const clinics = await db.all('SELECT * FROM clinics ORDER BY name');
    const assigned = (await db.all('SELECT clinic_id FROM doctor_clinics WHERE doctor_id = $1', [doctor.id])).map((r) => r.clinic_id);
    const stats = await db.one(
      `SELECT COUNT(*) FILTER (WHERE a.status = 'completed') AS completed,
              COUNT(*) FILTER (WHERE a.status IN ('confirmed', 'checked_in') AND s.starts_at >= $2) AS upcoming,
              COUNT(*) FILTER (WHERE a.status = 'no_show') AS no_shows
         FROM appointments a JOIN slots s ON s.id = a.slot_id WHERE s.doctor_id = $1`, [doctor.id, time.nowLocal()]);
    const draft = takeDoctorDraft(req, `/admin/doctors/${doctor.id}`);
    res.render('admin/doctor-form', {
      title: doctor.name, doctor: draft ? { ...doctor, ...draft, id: doctor.id } : doctor, clinics,
      assigned: draft ? draft.clinic_ids : assigned, permissions: DOCTOR_PERMISSIONS, stats,
    });
  });

  router.post('/doctors/:id', keepDoctorForm(async (req, res) => {
    const doctorId = id(req.params.id);
    const name = text(req.body.name, 200);
    const email = text(req.body.email, 200).toLowerCase();
    if (name.length < 2 || !EMAIL.test(email)) throw new ValidationError('Enter the doctor\'s name and a valid email.');
    if (await db.one('SELECT 1 FROM users WHERE lower(email) = $1 AND id <> $2', [email, doctorId])) {
      throw new ValidationError('That email is already in use.');
    }
    const gmc = await checkGmc(req.body, doctorId);
    await db.tx(async (c) => {
      const { rowCount } = await c.query(
        `UPDATE users SET name = $2, email = $3, phone = $4 WHERE id = $1 AND role = 'doctor'`,
        [doctorId, name, email, text(req.body.phone, 50) || null]);
      if (!rowCount) throw new ValidationError('Doctor not found.');
      await saveDoctorSettings(c, doctorId, { ...req.body, gmc });
      await audit(c, req.user.id, 'doctor.update', 'user', doctorId, { gmc,
        permissions: Object.fromEntries(Object.keys(DOCTOR_PERMISSIONS).map((p) => [p, bool(req.body[p])])),
      });
    });
    req.flash('success', 'Doctor settings saved.');
    res.redirect(`/admin/doctors/${doctorId}`);
  }, (req) => `/admin/doctors/${id(req.params.id)}`));

  // ---------- Any user: activate/deactivate, reset password ----------
  router.post('/users/:id/toggle', async (req, res) => {
    const userId = id(req.params.id);
    if (userId === req.user.id) throw new ValidationError('You cannot deactivate your own account.');
    const u = await db.one('UPDATE users SET is_active = NOT is_active WHERE id = $1 RETURNING *', [userId]);
    if (!u) throw new ValidationError('User not found.');
    if (!u.is_active) await endSessions(db, u.id);
    await audit(db, req.user.id, u.is_active ? 'user.activate' : 'user.deactivate', 'user', u.id);
    req.flash('success', u.is_active ? `${u.name} can sign in again.` : `${u.name} has been deactivated and can no longer sign in.`);
    res.redirect(backUrl(req, '/admin'));
  });

  router.post('/users/:id/reset-password', async (req, res) => {
    const password = temporaryPassword();
    const u = await db.one(
      `UPDATE users SET password_hash = $2, must_change_password = (role <> 'patient') WHERE id = $1 RETURNING name, email`,
      [id(req.params.id), await bcrypt.hash(password, 12)]);
    if (!u) throw new ValidationError('User not found.');
    if (id(req.params.id) !== req.user.id) await endSessions(db, id(req.params.id));
    await audit(db, req.user.id, 'user.reset_password', 'user', id(req.params.id));
    req.flash('success', `New temporary password for ${u.email}: ${password}`);
    res.redirect(backUrl(req, '/admin'));
  });

  // ---------- Administrators ----------
  router.get('/admins', async (req, res) => {
    const admins = await db.all(`SELECT * FROM users WHERE role = 'admin' ORDER BY name`);
    res.render('admin/admins', { title: 'Administrators', admins });
  });

  router.post('/admins', async (req, res) => {
    const name = text(req.body.name, 200);
    const email = text(req.body.email, 200).toLowerCase();
    if (name.length < 2 || !EMAIL.test(email)) throw new ValidationError('Enter a name and a valid email.');
    if (await db.one('SELECT 1 FROM users WHERE lower(email) = $1', [email])) throw new ValidationError('That email is already in use.');
    const password = temporaryPassword();
    const u = await db.one(
      `INSERT INTO users (role, name, email, password_hash, must_change_password) VALUES ('admin', $1, $2, $3, TRUE) RETURNING id`,
      [name, email, await bcrypt.hash(password, 12)]);
    await audit(db, req.user.id, 'admin.create', 'user', u.id, { email });
    req.flash('success', `Administrator created. They sign in at ${req.app.locals.staffLoginUrl} with ${email} and the temporary password ${password}. Share it privately.`);
    res.redirect('/admin/admins');
  });

  // ---------- Patients ----------
  router.get('/patients', async (req, res) => {
    const q = text(req.query.q, 100);
    const patients = await db.all(
      `SELECT u.*, COUNT(a.id) FILTER (WHERE a.status IN ('confirmed', 'checked_in', 'completed', 'no_show')) AS visits,
              MAX(s.starts_at) FILTER (WHERE a.status IN ('confirmed', 'checked_in', 'completed')) AS last_visit
         FROM users u
         LEFT JOIN appointments a ON a.patient_id = u.id
         LEFT JOIN slots s ON s.id = a.slot_id
        WHERE u.role = 'patient'
          AND ($1 = '' OR u.name ILIKE '%' || $1 || '%' OR u.email ILIKE '%' || $1 || '%' OR u.phone ILIKE '%' || $1 || '%')
        GROUP BY u.id ORDER BY u.created_at DESC LIMIT 200`, [q]);
    res.render('admin/patients', { title: 'Patients', patients, q });
  });

  router.get('/patients/:id', async (req, res) => {
    const patient = await db.one(`SELECT * FROM users WHERE id = $1 AND role = 'patient'`, [id(req.params.id)]);
    if (!patient) return res.status(404).render('error', { title: 'Not found', message: 'Patient not found.' });
    const appointments = await db.all(`${APPOINTMENT_SELECT} WHERE a.patient_id = $1 ORDER BY s.starts_at DESC`, [patient.id]);
    const payments = await db.all(
      `SELECT p.*, a.reference FROM payments p JOIN appointments a ON a.id = p.appointment_id
        WHERE a.patient_id = $1 ORDER BY p.created_at DESC`, [patient.id]);
    const openRequest = await db.one(
      `SELECT * FROM data_requests WHERE user_id = $1 AND status = 'open' ORDER BY id DESC LIMIT 1`, [patient.id]);
    await audit(db, req.user.id, 'patient.view_record', 'user', patient.id);
    res.render('admin/patient', { title: patient.name, patient, appointments, payments, openRequest });
  });

  router.post('/patients/:id', async (req, res) => {
    const patientId = id(req.params.id);
    const name = text(req.body.name, 200);
    const email = text(req.body.email, 200).toLowerCase();
    const dob = text(req.body.date_of_birth, 10);
    if (name.length < 2 || !EMAIL.test(email)) throw new ValidationError('Enter a name and a valid email.');
    if (dob && !time.isDate(dob)) throw new ValidationError('Enter a valid date of birth.');
    if (await db.one('SELECT 1 FROM users WHERE lower(email) = $1 AND id <> $2', [email, patientId])) {
      throw new ValidationError('That email is already in use.');
    }
    await db.query(
      `UPDATE users SET name = $2, email = $3, phone = $4, date_of_birth = $5 WHERE id = $1 AND role = 'patient'`,
      [patientId, name, email, text(req.body.phone, 50) || null, dob || null]);
    await audit(db, req.user.id, 'patient.update', 'user', patientId);
    req.flash('success', 'Patient details saved.');
    res.redirect(`/admin/patients/${patientId}`);
  });

  // ---------- Appointments ----------
  router.get('/appointments', async (req, res) => {
    await bookings.sweepExpiredHolds(db);
    const filters = {
      status: text(req.query.status, 30), clinic: id(req.query.clinic), doctor: id(req.query.doctor),
      from: time.isDate(req.query.from) ? req.query.from : '', to: time.isDate(req.query.to) ? req.query.to : '',
      q: text(req.query.q, 100),
    };
    const appointments = await db.all(
      `${APPOINTMENT_SELECT}
        WHERE ($1 = '' OR a.status = $1) AND ($2 = 0 OR s.clinic_id = $2) AND ($3 = 0 OR s.doctor_id = $3)
          AND ($4::date IS NULL OR s.starts_at::date >= $4::date) AND ($5::date IS NULL OR s.starts_at::date <= $5::date)
          AND ($6 = '' OR a.reference ILIKE '%' || $6 || '%' OR p.name ILIKE '%' || $6 || '%' OR p.email ILIKE '%' || $6 || '%')
        ORDER BY s.starts_at DESC LIMIT 300`,
      [filters.status, filters.clinic, filters.doctor, filters.from || null, filters.to || null, filters.q]);
    const clinics = await db.all('SELECT id, name FROM clinics ORDER BY name');
    const doctors = await db.all(`SELECT id, name FROM users WHERE role = 'doctor' ORDER BY name`);
    res.render('admin/appointments', { title: 'Appointments', appointments, filters, clinics, doctors });
  });

  router.get('/appointments/:id', async (req, res) => {
    const appt = await db.one(`${APPOINTMENT_SELECT} WHERE a.id = $1`, [id(req.params.id)]);
    if (!appt) return res.status(404).render('error', { title: 'Not found', message: 'Appointment not found.' });
    const payments = await db.all('SELECT * FROM payments WHERE appointment_id = $1 ORDER BY id', [appt.id]);
    const log = await db.all(
      `SELECT l.*, u.name AS user_name FROM audit_log l LEFT JOIN users u ON u.id = l.user_id
        WHERE l.entity = 'appointment' AND l.entity_id = $1 ORDER BY l.created_at`, [appt.id]);
    const record = await consultation.load(db, appt.id);
    res.render('admin/appointment', {
      title: `Appointment ${appt.reference}`, appt, payments, log, record, sections: consultation.SECTIONS, draft: takeDraft(req, appt.id),
    });
  });

  router.post('/appointments/:id/cancel', async (req, res) => {
    const apptId = id(req.params.id);
    const { refunded } = await bookings.cancelAppointment(db, {
      appointmentId: apptId, actor: req.user, reason: text(req.body.reason, 500) || 'Cancelled by the clinic',
      refund: bool(req.body.refund),
    });
    req.flash('success', refunded ? 'Appointment cancelled and payment refunded.' : 'Appointment cancelled.');
    res.redirect(`/admin/appointments/${apptId}`);
  });

  router.post('/appointments/:id/check-in', async (req, res) => {
    await bookings.checkIn(db, { appointmentId: id(req.params.id), actorId: req.user.id });
    req.flash('success', 'Patient checked in. The consultation record is below.');
    res.redirect(`/admin/appointments/${id(req.params.id)}#consultation`);
  });

  router.post('/appointments/:id/no-show', async (req, res) => {
    await bookings.markNoShow(db, { appointmentId: id(req.params.id), actorId: req.user.id });
    req.flash('info', 'Marked as no-show.');
    res.redirect(backUrl(req, '/admin/appointments'));
  });

  consultationRoutes(router, db, {
    base: '/admin',
    findAppointment: (req, id) => db.one('SELECT id, status FROM appointments WHERE id = $1', [id]),
    canEdit: () => true,
  });

  // ---------- Availability (for any doctor) ----------
  router.get('/availability', async (req, res) => {
    const doctorId = id(req.query.doctor);
    const clinicId = id(req.query.clinic);
    const sessions = await db.all(
      `SELECT av.*, c.name AS clinic_name, u.name AS doctor_name,
              COUNT(s.id) FILTER (WHERE NOT s.is_blocked) AS open_slots,
              COUNT(a.id) AS booked
         FROM availability av
         JOIN clinics c ON c.id = av.clinic_id JOIN users u ON u.id = av.doctor_id
         LEFT JOIN slots s ON s.availability_id = av.id
         LEFT JOIN appointments a ON a.slot_id = s.id AND a.status IN ${LIVE_STATUSES}
        WHERE av.date >= $1 AND ($2 = 0 OR av.doctor_id = $2) AND ($3 = 0 OR av.clinic_id = $3)
        GROUP BY av.id, c.name, u.name ORDER BY av.date, av.start_time LIMIT 500`,
      [time.todayLocal(), doctorId, clinicId]);
    const doctors = await db.all(`SELECT id, name FROM users WHERE role = 'doctor' AND is_active ORDER BY name`);
    const clinics = await db.all('SELECT id, name FROM clinics WHERE is_active ORDER BY name');
    const assignments = await db.all('SELECT doctor_id, clinic_id FROM doctor_clinics');
    res.render('admin/availability', {
      title: 'Availability', sessions, doctors, clinics, assignments, filters: { doctor: doctorId, clinic: clinicId },
      today: time.todayLocal(),
    });
  });

  router.post('/availability', async (req, res) => {
    const repeatWeeks = Math.min(Math.max(parseInt(req.body.repeat_weeks, 10) || 0, 0), 12);
    const { created, skipped } = await createRepeating(db, {
      doctorId: id(req.body.doctor_id), clinicId: id(req.body.clinic_id), date: req.body.date,
      startTime: req.body.start_time, endTime: req.body.end_time, slotMinutes: req.body.slot_minutes, createdBy: req.user.id,
    }, repeatWeeks);
    if (created.length) {
      req.flash('success', `Added ${created.length} session(s) with ${created.reduce((n, c) => n + c.slots, 0)} slot(s).`);
    }
    for (const s of skipped) req.flash('error', `Skipped ${s}`);
    res.redirect('/admin/availability');
  });

  router.get('/availability/:id', async (req, res) => {
    const session = await db.one(
      `SELECT av.*, c.name AS clinic_name, u.name AS doctor_name FROM availability av
         JOIN clinics c ON c.id = av.clinic_id JOIN users u ON u.id = av.doctor_id WHERE av.id = $1`, [id(req.params.id)]);
    if (!session) return res.status(404).render('error', { title: 'Not found', message: 'Session not found.' });
    const slots = await db.all(
      `SELECT s.*, a.id AS appointment_id, a.status, p.name AS patient_name
         FROM slots s
         LEFT JOIN appointments a ON a.slot_id = s.id AND a.status IN ${LIVE_STATUSES}
         LEFT JOIN users p ON p.id = a.patient_id
        WHERE s.availability_id = $1 ORDER BY s.starts_at`, [session.id]);
    res.render('doctor/session', { title: 'Session slots', session, slots, base: '/admin' });
  });

  router.post('/availability/:id/delete', async (req, res) => {
    await availability.deleteAvailability(db, { availabilityId: id(req.params.id), actorId: req.user.id });
    req.flash('success', 'Session removed.');
    res.redirect('/admin/availability');
  });

  router.post('/slots/:id/:action', async (req, res, next) => {
    if (!['block', 'unblock'].includes(req.params.action)) return next();
    await availability.setSlotBlocked(db, { slotId: id(req.params.id), blocked: req.params.action === 'block', actorId: req.user.id });
    res.redirect(backUrl(req, '/admin/availability'));
  });

  // ---------- Patients' data requests ----------
  router.get('/requests', async (req, res) => {
    const requests = await db.all(
      `SELECT r.*, u.name AS patient_name, u.email AS patient_email, u.role, rb.name AS resolved_by_name
         FROM data_requests r JOIN users u ON u.id = r.user_id LEFT JOIN users rb ON rb.id = r.resolved_by
        ORDER BY (r.status = 'open') DESC, r.created_at DESC LIMIT 200`);
    res.render('admin/requests', { title: 'Data requests', requests });
  });

  router.post('/requests/:id/resolve', async (req, res) => {
    const status = req.body.status === 'declined' ? 'declined' : 'done';
    const resolution = text(req.body.resolution, 1000);
    if (!resolution) throw new ValidationError('Write down what was done, so there is a record of it.');
    const r = await db.one(
      `UPDATE data_requests SET status = $2, resolution = $3, resolved_by = $4, resolved_at = now()
        WHERE id = $1 AND status = 'open' RETURNING *`, [id(req.params.id), status, resolution, req.user.id]);
    if (!r) throw new ValidationError('That request has already been dealt with.');
    await audit(db, req.user.id, `data_request.${status}`, 'user', r.user_id, { request: r.id });
    req.flash('success', 'Request updated.');
    res.redirect('/admin/requests');
  });

  /**
   * Removes a patient's identifying details and closes their account. Their appointment,
   * payment and clinical history stays (with no name attached) for the legally required retention period.
   */
  router.post('/patients/:id/anonymise', async (req, res) => {
    const patientId = id(req.params.id);
    if (text(req.body.confirm, 20).toUpperCase() !== 'DELETE') {
      throw new ValidationError('Type DELETE in the box to confirm.');
    }
    const live = await db.one(
      `SELECT 1 FROM appointments WHERE patient_id = $1 AND status IN ('pending_payment', 'confirmed', 'checked_in')`,
      [patientId]);
    if (live) throw new ValidationError('This patient has upcoming or open appointments. Cancel or complete them first.');
    const u = await db.one(
      `UPDATE users SET name = 'Deleted patient', email = 'deleted-' || id || '@invalid.example',
              phone = NULL, date_of_birth = NULL, is_active = FALSE, password_hash = $2
        WHERE id = $1 AND role = 'patient' RETURNING id`,
      [patientId, await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 4)]);
    if (!u) throw new ValidationError('Patient not found.');
    await endSessions(db, patientId);
    await db.query(`UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [patientId]);
    await db.query(
      `UPDATE data_requests SET status = 'done', resolved_by = $2, resolved_at = now(),
              resolution = COALESCE(resolution, 'Personal details removed and account closed.')
        WHERE user_id = $1 AND status = 'open'`, [patientId, req.user.id]);
    await audit(db, req.user.id, 'patient.anonymise', 'user', patientId);
    req.flash('success', 'The patient\'s personal details have been removed and their account closed.');
    res.redirect(`/admin/patients/${patientId}`);
  });

  // ---------- Payments & audit ----------
  router.get('/payments', async (req, res) => {
    const payments = await db.all(
      `SELECT p.*, a.reference, a.id AS appointment_id, u.name AS patient_name
         FROM payments p JOIN appointments a ON a.id = p.appointment_id JOIN users u ON u.id = a.patient_id
        ORDER BY p.created_at DESC LIMIT 300`);
    const totals = await db.one(
      `SELECT COALESCE(SUM(amount_pence) FILTER (WHERE status = 'paid'), 0) AS paid,
              COALESCE(SUM(amount_pence) FILTER (WHERE status = 'refunded'), 0) AS refunded
         FROM payments`);
    res.render('admin/payments', { title: 'Payments', payments, totals });
  });

  router.get('/audit', async (req, res) => {
    const entries = await db.all(
      `SELECT l.*, u.name AS user_name, u.role AS user_role FROM audit_log l LEFT JOIN users u ON u.id = l.user_id
        ORDER BY l.created_at DESC LIMIT 500`);
    res.render('admin/audit', { title: 'Audit log', entries });
  });

  return router;
};
