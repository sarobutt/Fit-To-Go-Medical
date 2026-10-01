const express = require('express');
const { requireRole } = require('../auth');
const bookings = require('../services/bookings');
const { ValidationError } = require('../services/availability');
const { audit } = require('../services/audit');
const time = require('../time');
const reports = require('../services/reports');
const { sendPdf } = require('./consultation');
const consultation = require('../services/consultation');

const APPOINTMENT_SELECT = `
  SELECT a.*, s.starts_at, s.ends_at, t.name AS test_name, t.preparation, t.turnaround,
         c.name AS clinic_name, c.address AS clinic_address, c.city AS clinic_city, c.phone AS clinic_phone,
         d.name AS doctor_name
    FROM appointments a
    JOIN slots s ON s.id = a.slot_id
    JOIN tests t ON t.id = a.test_id
    JOIN clinics c ON c.id = s.clinic_id
    JOIN users d ON d.id = s.doctor_id`;

module.exports = (db) => {
  const router = express.Router();
  router.use(requireRole('patient'));

  router.get('/', async (req, res) => {
    await bookings.sweepExpiredHolds(db);
    const upcoming = await db.all(
      `${APPOINTMENT_SELECT} WHERE a.patient_id = $1 AND a.status IN ('pending_payment', 'confirmed', 'checked_in')
          AND s.starts_at::date >= $2::date
        ORDER BY s.starts_at`, [req.user.id, time.todayLocal()]);
    const recent = await db.all(
      `${APPOINTMENT_SELECT} WHERE a.patient_id = $1 AND a.status = 'completed' ORDER BY s.starts_at DESC LIMIT 3`,
      [req.user.id]);
    res.render('patient/dashboard', { title: 'My dashboard', upcoming, recent });
  });

  router.get('/book', async (req, res) => {
    const tests = await db.all('SELECT * FROM tests WHERE is_active ORDER BY name');
    const clinics = await db.all('SELECT * FROM clinics WHERE is_active ORDER BY name');
    const testId = parseInt(req.query.test, 10) || null;
    const clinicId = parseInt(req.query.clinic, 10) || null;
    const clinic = clinics.find((c) => c.id === clinicId) || null;
    const dates = clinic ? await bookings.datesWithAvailability(db, clinic.id) : [];
    let date = time.isDate(req.query.date) ? req.query.date : null;
    if (clinic && !date && dates.length) date = dates[0].date;
    const slots = clinic && date ? await bookings.availableSlots(db, clinic.id, date) : [];
    res.render('patient/book', {
      title: 'Book a test', tests, clinics, testId, clinic, dates, date, slots,
      test: tests.find((t) => t.id === testId) || null,
      change: ['test', 'clinic'].includes(req.query.change) ? req.query.change : null,
    });
  });

  router.post('/book', async (req, res) => {
    const slotId = parseInt(req.body.slot_id, 10);
    const testId = parseInt(req.body.test_id, 10);
    if (!slotId || !testId) throw new ValidationError('Please choose a test and a time.');
    const { checkoutUrl } = await bookings.startBooking(db, { patient: req.user, slotId, testId });
    res.redirect(303, checkoutUrl);
  });

  router.get('/appointments', async (req, res) => {
    await bookings.sweepExpiredHolds(db);
    const appointments = await db.all(
      `${APPOINTMENT_SELECT} WHERE a.patient_id = $1 ORDER BY s.starts_at DESC`, [req.user.id]);
    res.render('patient/appointments', { title: 'My appointments', appointments });
  });

  router.get('/appointments/:id', async (req, res) => {
    const appt = await db.one(`${APPOINTMENT_SELECT} WHERE a.id = $1 AND a.patient_id = $2`,
      [parseInt(req.params.id, 10) || 0, req.user.id]);
    if (!appt) return res.status(404).render('error', { title: 'Not found', message: 'Appointment not found.' });
    const payments = await db.all('SELECT * FROM payments WHERE appointment_id = $1 ORDER BY id', [appt.id]);
    const record = await consultation.load(db, appt.id);
    res.render('patient/appointment', {
      record,
      title: `Appointment ${appt.reference}`, appt, payments, canCancel: bookings.patientCanCancel(appt),
    });
  });

  for (const [path, build] of [['report.pdf', reports.medicalReport], ['certificate.pdf', reports.certificate]]) {
    router.get(`/appointments/:id/${path}`, async (req, res) => {
      const own = await db.one(`SELECT id FROM appointments WHERE id = $1 AND patient_id = $2 AND status = 'completed'`,
        [parseInt(req.params.id, 10) || 0, req.user.id]);
      const doc = own && await build(db, own.id);
      if (!doc) return res.status(404).render('error', { title: 'Not found', message: 'That document isn\'t available.' });
      sendPdf(res, doc);
    });
  }

  // "Add to calendar": a standard .ics file that phones and Outlook/Google Calendar open directly.
  router.get('/appointments/:id/calendar.ics', async (req, res) => {
    const appt = await db.one(`${APPOINTMENT_SELECT} WHERE a.id = $1 AND a.patient_id = $2`,
      [parseInt(req.params.id, 10) || 0, req.user.id]);
    if (!appt) return res.status(404).render('error', { title: 'Not found', message: 'Appointment not found.' });
    const esc = (v) => String(v || '').replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
    const stamp = (v) => v.slice(0, 16).replace(/[-:]/g, '').replace(' ', 'T') + '00';
    const now = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    const tz = req.app.locals.timeZone;
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${esc(req.app.locals.siteName)}//Booking//EN`, 'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${appt.reference}@fit-to-go-medical`,
      `DTSTAMP:${now}`,
      `DTSTART;TZID=${tz}:${stamp(appt.starts_at)}`,
      `DTEND;TZID=${tz}:${stamp(appt.ends_at)}`,
      `SUMMARY:${esc(`${appt.test_name} – ${req.app.locals.siteName}`)}`,
      `LOCATION:${esc(`${appt.clinic_name}, ${appt.clinic_address}, ${appt.clinic_city}`)}`,
      `DESCRIPTION:${esc(`Reference ${appt.reference}. Bring photo ID and arrive 10 minutes early.${appt.preparation ? ` Before you come: ${appt.preparation}` : ''}`)}`,
      'BEGIN:VALARM', 'TRIGGER:-PT2H', 'ACTION:DISPLAY', 'DESCRIPTION:Appointment in 2 hours', 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR', '',
    ].join('\r\n');
    res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="${appt.reference}.ics"` });
    res.send(ics);
  });

  router.post('/appointments/:id/pay', async (req, res) => {
    const url = await bookings.resumeCheckout(db, { appointmentId: parseInt(req.params.id, 10) || 0, patientId: req.user.id });
    res.redirect(303, url);
  });

  router.post('/appointments/:id/cancel', async (req, res) => {
    const appt = await db.one(`${APPOINTMENT_SELECT} WHERE a.id = $1 AND a.patient_id = $2`,
      [parseInt(req.params.id, 10) || 0, req.user.id]);
    if (!appt) throw new ValidationError('Appointment not found.');
    if (!bookings.patientCanCancel(appt)) {
      throw new ValidationError(`Appointments can only be cancelled online up to ${req.app.locals.cancellationHours} hours before. Please call the clinic.`);
    }
    const { refunded } = await bookings.cancelAppointment(db, {
      appointmentId: appt.id, actor: req.user, reason: 'Cancelled by patient', refund: true,
    });
    req.flash('success', refunded ? 'Appointment cancelled. Your refund is on its way (usually 5–10 working days).' : 'Booking cancelled.');
    res.redirect(`/patient/appointments/${appt.id}`);
  });

  router.get('/profile', async (req, res) => {
    const openRequest = await db.one(
      `SELECT * FROM data_requests WHERE user_id = $1 AND status = 'open' ORDER BY id DESC LIMIT 1`, [req.user.id]);
    res.render('patient/profile', { title: 'My details', openRequest });
  });

  // Right of access: everything held about the patient, as a file they can keep.
  router.get('/my-data.json', async (req, res) => {
    const id = req.user.id;
    const profile = await db.one(
      'SELECT name, email, phone, date_of_birth, created_at FROM users WHERE id = $1', [id]);
    const appointments = await db.all(
      `SELECT a.reference, a.status, t.name AS test, s.starts_at, c.name AS clinic, d.name AS doctor,
              a.price_pence, a.result_summary, a.checked_in_at, a.completed_at, a.cancelled_at, a.cancel_reason,
              a.created_at, co.outcome, co.data AS consultation
         FROM appointments a
         JOIN slots s ON s.id = a.slot_id JOIN tests t ON t.id = a.test_id
         JOIN clinics c ON c.id = s.clinic_id JOIN users d ON d.id = s.doctor_id
         LEFT JOIN consultations co ON co.appointment_id = a.id AND co.finalised_at IS NOT NULL
        WHERE a.patient_id = $1 AND a.status <> 'expired' ORDER BY s.starts_at`, [id]);
    const paymentRows = await db.all(
      `SELECT a.reference, p.amount_pence, p.currency, p.status, p.paid_at, p.refunded_at
         FROM payments p JOIN appointments a ON a.id = p.appointment_id
        WHERE a.patient_id = $1 AND p.status IN ('paid', 'refunded') ORDER BY p.created_at`, [id]);
    await audit(db, id, 'patient.export_data', 'user', id);
    res.set('Content-Disposition', 'attachment; filename="my-fit-to-go-data.json"');
    res.json({
      exported_at: new Date().toISOString(),
      note: 'Your personal data held by the clinic. Doctors\' private clinical notes are available on request from the clinic.',
      profile, appointments, payments: paymentRows,
    });
  });

  // Right to erasure: recorded for an admin, because medical records must be kept for a legal minimum period.
  router.post('/delete-request', async (req, res) => {
    const existing = await db.one(
      `SELECT 1 FROM data_requests WHERE user_id = $1 AND status = 'open'`, [req.user.id]);
    if (!existing) {
      await db.query(`INSERT INTO data_requests (user_id, kind, details) VALUES ($1, 'deletion', $2)`,
        [req.user.id, String(req.body.details || '').trim().slice(0, 1000) || null]);
      await audit(db, req.user.id, 'patient.request_deletion', 'user', req.user.id);
    }
    req.flash('success', 'We\'ve received your request. The clinic will reply within one month.');
    res.redirect('/patient/profile');
  });

  router.post('/profile', async (req, res) => {
    const name = String(req.body.name || '').trim();
    const phone = String(req.body.phone || '').trim();
    const dob = String(req.body.date_of_birth || '').trim();
    if (name.length < 2) throw new ValidationError('Please enter your full name.');
    if (dob && (!time.isDate(dob) || dob > time.todayLocal())) throw new ValidationError('Please enter a valid date of birth.');
    await db.query('UPDATE users SET name = $2, phone = $3, date_of_birth = $4 WHERE id = $1',
      [req.user.id, name, phone || null, dob || null]);
    await audit(db, req.user.id, 'user.update_profile', 'user', req.user.id);
    req.flash('success', 'Your details have been saved.');
    res.redirect('/patient/profile');
  });

  return router;
};

module.exports.APPOINTMENT_SELECT = APPOINTMENT_SELECT;
