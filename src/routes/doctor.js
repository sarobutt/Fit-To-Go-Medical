const express = require('express');
const { requireStaff, requirePermission, DOCTOR_PERMISSIONS } = require('../auth');
const bookings = require('../services/bookings');
const availability = require('../services/availability');
const { ValidationError } = availability;
const time = require('../time');
const { backUrl } = require('../util');
const consultation = require('../services/consultation');
const { consultationRoutes } = require('./consultation');

const DAY_SELECT = `
  SELECT a.id, a.reference, a.status, a.checked_in_at, s.starts_at, s.ends_at,
         t.name AS test_name, c.name AS clinic_name, p.name AS patient_name, p.date_of_birth
    FROM appointments a
    JOIN slots s ON s.id = a.slot_id
    JOIN tests t ON t.id = a.test_id
    JOIN clinics c ON c.id = s.clinic_id
    JOIN users p ON p.id = a.patient_id`;

/** Creates a session on `date` and, optionally, on the same weekday for following weeks. */
async function createRepeating(db, input, repeatWeeks) {
  const created = [];
  const skipped = [];
  for (let w = 0; w <= repeatWeeks; w++) {
    const date = time.addDays(input.date, w * 7);
    try {
      const r = await availability.createAvailability(db, { ...input, date });
      created.push({ date, slots: r.slotsCreated });
    } catch (err) {
      if (!(err instanceof ValidationError) || repeatWeeks === 0) throw err;
      skipped.push(`${time.formatDate(date)}: ${err.message}`);
    }
  }
  return { created, skipped };
}

module.exports = (db) => {
  const router = express.Router();
  router.use(requireStaff('doctor'));

  router.get('/', async (req, res) => {
    const date = time.isDate(req.query.date) ? req.query.date : time.todayLocal();
    const appointments = await db.all(
      `${DAY_SELECT} WHERE s.doctor_id = $1 AND s.starts_at::date = $2 AND a.status NOT IN ('expired', 'pending_payment')
        ORDER BY s.starts_at`, [req.user.id, date]);
    const counts = await db.one(
      `SELECT COUNT(*) FILTER (WHERE a.status = 'confirmed') AS waiting,
              COUNT(*) FILTER (WHERE a.status = 'checked_in') AS checked_in,
              COUNT(*) FILTER (WHERE a.status = 'completed') AS completed
         FROM appointments a JOIN slots s ON s.id = a.slot_id
        WHERE s.doctor_id = $1 AND s.starts_at::date = $2`, [req.user.id, date]);
    const freeSlots = await db.one(
      `SELECT COUNT(*) AS n FROM slots s WHERE s.doctor_id = $1 AND s.starts_at::date = $2 AND NOT s.is_blocked
          AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = s.id AND a.status IN ${availability.LIVE_STATUSES})`,
      [req.user.id, date]);
    res.render('doctor/dashboard', {
      title: 'Clinic day', date, appointments, counts, freeSlots: freeSlots.n,
      isToday: date === time.todayLocal(), permissions: DOCTOR_PERMISSIONS,
    });
  });

  router.get('/appointments/:id', async (req, res) => {
    const appt = await db.one(
      `SELECT a.*, s.starts_at, s.ends_at, s.doctor_id, t.name AS test_name, t.preparation,
              c.name AS clinic_name, p.name AS patient_name, p.email AS patient_email,
              p.phone AS patient_phone, p.date_of_birth
         FROM appointments a JOIN slots s ON s.id = a.slot_id JOIN tests t ON t.id = a.test_id
         JOIN clinics c ON c.id = s.clinic_id JOIN users p ON p.id = a.patient_id
        WHERE a.id = $1 AND s.doctor_id = $2`,
      [parseInt(req.params.id, 10) || 0, req.user.id]);
    if (!appt) return res.status(404).render('error', { title: 'Not found', message: 'Appointment not found.' });
    const history = req.user.can_view_patient_history
      ? await db.all(
        `${DAY_SELECT.replace('a.checked_in_at,', 'a.checked_in_at, a.result_summary, a.doctor_notes,')}
          WHERE a.patient_id = $1 AND a.id <> $2 AND a.status = 'completed' ORDER BY s.starts_at DESC`,
        [appt.patient_id, appt.id])
      : null;
    const record = await consultation.load(db, appt.id);
    res.render('doctor/appointment', {
      title: `Appointment ${appt.reference}`, appt, history, record, sections: consultation.SECTIONS,
    });
  });

  router.post('/appointments/:id/check-in', requirePermission('can_check_in'), async (req, res) => {
    const id = parseInt(req.params.id, 10) || 0;
    await bookings.checkIn(db, { appointmentId: id, actorId: req.user.id, doctorId: req.user.id });
    // Go straight to the consultation record so the doctor can start filling it in.
    req.flash('success', 'Patient checked in. Fill in the consultation record below.');
    res.redirect(`/doctor/appointments/${id}#consultation`);
  });

  router.post('/appointments/:id/no-show', requirePermission('can_check_in'), async (req, res) => {
    await bookings.markNoShow(db, { appointmentId: parseInt(req.params.id, 10) || 0, actorId: req.user.id, doctorId: req.user.id });
    req.flash('info', 'Marked as no-show.');
    res.redirect(backUrl(req, '/doctor'));
  });

  consultationRoutes(router, db, {
    base: '/doctor',
    findAppointment: (req, id) => db.one(
      `SELECT a.id, a.status FROM appointments a JOIN slots s ON s.id = a.slot_id WHERE a.id = $1 AND s.doctor_id = $2`,
      [id, req.user.id]),
    canEdit: (req) => Boolean(req.user.can_record_results),
  });

  router.post('/appointments/:id/cancel', requirePermission('can_cancel_appointments'), async (req, res) => {
    const id = parseInt(req.params.id, 10) || 0;
    const own = await db.one('SELECT 1 FROM appointments a JOIN slots s ON s.id = a.slot_id WHERE a.id = $1 AND s.doctor_id = $2',
      [id, req.user.id]);
    if (!own) throw new ValidationError('Appointment not found.');
    const reason = String(req.body.reason || '').trim() || 'Cancelled by the clinic';
    const { refunded } = await bookings.cancelAppointment(db, { appointmentId: id, actor: req.user, reason, refund: true });
    req.flash('success', refunded ? 'Appointment cancelled and the patient refunded.' : 'Appointment cancelled.');
    res.redirect(`/doctor/appointments/${id}`);
  });

  router.get('/availability', async (req, res) => {
    const clinics = await db.all(
      `SELECT c.* FROM clinics c JOIN doctor_clinics dc ON dc.clinic_id = c.id
        WHERE dc.doctor_id = $1 AND c.is_active ORDER BY c.name`, [req.user.id]);
    const sessions = await db.all(
      `SELECT av.*, c.name AS clinic_name,
              COUNT(s.id) FILTER (WHERE NOT s.is_blocked) AS open_slots,
              COUNT(s.id) FILTER (WHERE s.is_blocked) AS blocked_slots,
              COUNT(a.id) AS booked
         FROM availability av
         JOIN clinics c ON c.id = av.clinic_id
         LEFT JOIN slots s ON s.availability_id = av.id
         LEFT JOIN appointments a ON a.slot_id = s.id AND a.status IN ${availability.LIVE_STATUSES}
        WHERE av.doctor_id = $1 AND av.date >= $2
        GROUP BY av.id, c.name ORDER BY av.date, av.start_time`, [req.user.id, time.todayLocal()]);
    res.render('doctor/availability', { title: 'My availability', clinics, sessions, today: time.todayLocal() });
  });

  router.post('/availability', requirePermission('can_manage_availability'), async (req, res) => {
    const repeatWeeks = Math.min(Math.max(parseInt(req.body.repeat_weeks, 10) || 0, 0), 12);
    const { created, skipped } = await createRepeating(db, {
      doctorId: req.user.id,
      clinicId: parseInt(req.body.clinic_id, 10) || 0,
      date: req.body.date,
      startTime: req.body.start_time,
      endTime: req.body.end_time,
      slotMinutes: req.body.slot_minutes,
      createdBy: req.user.id,
    }, repeatWeeks);
    const total = created.reduce((n, c) => n + c.slots, 0);
    if (created.length) req.flash('success', `Added ${created.length} session(s) with ${total} bookable slot(s).`);
    for (const s of skipped) req.flash('error', `Skipped ${s}`);
    res.redirect('/doctor/availability');
  });

  router.get('/availability/:id', async (req, res) => {
    const session = await db.one(
      `SELECT av.*, c.name AS clinic_name FROM availability av JOIN clinics c ON c.id = av.clinic_id
        WHERE av.id = $1 AND av.doctor_id = $2`, [parseInt(req.params.id, 10) || 0, req.user.id]);
    if (!session) return res.status(404).render('error', { title: 'Not found', message: 'Session not found.' });
    const slots = await db.all(
      `SELECT s.*, a.id AS appointment_id, a.status, p.name AS patient_name
         FROM slots s
         LEFT JOIN appointments a ON a.slot_id = s.id AND a.status IN ${availability.LIVE_STATUSES}
         LEFT JOIN users p ON p.id = a.patient_id
        WHERE s.availability_id = $1 ORDER BY s.starts_at`, [session.id]);
    res.render('doctor/session', { title: 'Session slots', session, slots, base: '/doctor' });
  });

  router.post('/availability/:id/delete', requirePermission('can_manage_availability'), async (req, res) => {
    await availability.deleteAvailability(db, {
      availabilityId: parseInt(req.params.id, 10) || 0, doctorId: req.user.id, actorId: req.user.id,
    });
    req.flash('success', 'Session removed.');
    res.redirect('/doctor/availability');
  });

  router.post('/slots/:id/:action', requirePermission('can_manage_availability'), async (req, res, next) => {
    if (!['block', 'unblock'].includes(req.params.action)) return next();
    await availability.setSlotBlocked(db, {
      slotId: parseInt(req.params.id, 10) || 0, doctorId: req.user.id,
      blocked: req.params.action === 'block', actorId: req.user.id,
    });
    res.redirect(backUrl(req, '/doctor/availability'));
  });

  router.get('/account', (req, res) => {
    res.render('account', { title: 'My account', permissions: DOCTOR_PERMISSIONS });
  });

  return router;
};

module.exports.createRepeating = createRepeating;
