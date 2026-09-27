const express = require('express');
const payments = require('../services/payments');
const bookings = require('../services/bookings');
const { requireRole } = require('../auth');

module.exports = (db) => {
  const router = express.Router();

  // Stripe redirects here after payment. The webhook is the source of truth, but
  // we also confirm here so the patient sees their booking straight away.
  router.get('/success', requireRole('patient'), async (req, res) => {
    const sessionId = String(req.query.session_id || '');
    const payment = await db.one(
      `SELECT p.* FROM payments p JOIN appointments a ON a.id = p.appointment_id
        WHERE p.checkout_session_id = $1 AND a.patient_id = $2`,
      [sessionId, req.user.id],
    );
    if (!payment) {
      req.flash('error', 'We could not find that payment.');
      return res.redirect('/patient/appointments');
    }
    const session = await payments.retrieveCheckoutSession(sessionId);
    await bookings.applyPaidCheckout(db, session);
    const appt = await db.one('SELECT status FROM appointments WHERE id = $1', [payment.appointment_id]);
    if (appt.status === 'confirmed') {
      req.flash('success', 'Payment received – your appointment is confirmed.');
    } else if (appt.status === 'pending_payment') {
      req.flash('info', 'Your payment is being processed. We will confirm your booking shortly.');
    } else {
      req.flash('error', 'That time was taken before your payment completed, so it has been refunded in full.');
    }
    res.redirect(`/patient/appointments/${payment.appointment_id}`);
  });

  router.get('/cancelled', requireRole('patient'), (req, res) => {
    req.flash('info', 'Payment was not completed. Your slot is held for a short while – you can pay from the booking below.');
    const id = parseInt(req.query.appointment, 10);
    res.redirect(Number.isInteger(id) ? `/patient/appointments/${id}` : '/patient/appointments');
  });

  return router;
};
