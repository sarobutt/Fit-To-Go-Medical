const express = require('express');
const { requireRole } = require('../auth');
const bookings = require('../services/bookings');
const { ValidationError } = require('../services/availability');
const { audit } = require('../services/audit');
const time = require('../time');

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
        ORDER BY s.starts_at`, [req.user.id]);
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
    res.render('patient/appointment', {
      title: `Appointment ${appt.reference}`, appt, payments, canCancel: bookings.patientCanCancel(appt),
    });
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

  router.get('/profile', (req, res) => {
    res.render('patient/profile', { title: 'My details' });
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
