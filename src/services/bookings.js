const crypto = require('node:crypto');
const config = require('../config');
const time = require('../time');
const payments = require('./payments');
const { audit } = require('./audit');
const { ValidationError, LIVE_STATUSES } = require('./availability');

const STATUS_LABELS = {
  pending_payment: 'Awaiting payment',
  confirmed: 'Confirmed',
  checked_in: 'Checked in',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No show',
  expired: 'Payment not completed',
};

function newReference() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  return `FTG-${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')}`;
}

/** Releases slots held by checkouts that were abandoned. Runs lazily before slot lookups. */
async function sweepExpiredHolds(q) {
  const { rows } = await q.query(
    `UPDATE appointments SET status = 'expired'
      WHERE status = 'pending_payment' AND hold_expires_at < now() - interval '2 minutes'
      RETURNING id`,
  );
  if (rows.length) {
    await q.query(`UPDATE payments SET status = 'failed' WHERE status = 'pending' AND appointment_id = ANY($1)`,
      [rows.map((r) => r.id)]);
  }
}

/** Free, future, unblocked slots for a clinic on a given date. */
async function availableSlots(db, clinicId, date) {
  await sweepExpiredHolds(db);
  return db.all(
    `SELECT s.id, s.starts_at, s.ends_at, u.name AS doctor_name, dp.specialty
       FROM slots s
       JOIN users u ON u.id = s.doctor_id AND u.is_active
       LEFT JOIN doctor_profiles dp ON dp.user_id = u.id
       JOIN clinics c ON c.id = s.clinic_id AND c.is_active
      WHERE s.clinic_id = $1 AND s.starts_at::date = $2 AND s.starts_at > $3 AND NOT s.is_blocked
        AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = s.id AND a.status IN ${LIVE_STATUSES})
      ORDER BY s.starts_at, u.name`,
    [clinicId, date, time.nowLocal()],
  );
}

/** Dates in the next `days` days that have at least one free slot at the clinic. */
async function datesWithAvailability(db, clinicId, days = 60) {
  await sweepExpiredHolds(db);
  const rows = await db.all(
    `SELECT s.starts_at::date AS date, COUNT(*) AS free
       FROM slots s
       JOIN users u ON u.id = s.doctor_id AND u.is_active
      WHERE s.clinic_id = $1 AND s.starts_at > $2 AND s.starts_at::date <= $3 AND NOT s.is_blocked
        AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = s.id AND a.status IN ${LIVE_STATUSES})
      GROUP BY 1 ORDER BY 1`,
    [clinicId, time.nowLocal(), time.addDays(time.todayLocal(), days)],
  );
  return rows;
}

/**
 * Holds a slot for the patient and opens a Stripe Checkout session.
 * Returns { appointment, checkoutUrl }.
 */
async function startBooking(db, { patient, slotId, testId }) {
  const booked = await db.tx(async (c) => {
    await sweepExpiredHolds(c);
    const { rows: [slot] } = await c.query(
      `SELECT s.*, c.name AS clinic_name, c.is_active AS clinic_active, u.is_active AS doctor_active
         FROM slots s JOIN clinics c ON c.id = s.clinic_id JOIN users u ON u.id = s.doctor_id
        WHERE s.id = $1 FOR UPDATE OF s`,
      [slotId],
    );
    if (!slot || slot.is_blocked || !slot.clinic_active || !slot.doctor_active) {
      throw new ValidationError('That time is no longer available. Please pick another.');
    }
    if (slot.starts_at.slice(0, 16) <= time.nowLocal()) throw new ValidationError('That time has already passed.');

    const { rows: [test] } = await c.query('SELECT * FROM tests WHERE id = $1 AND is_active', [testId]);
    if (!test) throw new ValidationError('Please choose a test.');

    const clash = await c.query(
      `SELECT 1 FROM appointments a JOIN slots s ON s.id = a.slot_id
        WHERE a.patient_id = $1 AND s.starts_at = $2 AND a.status IN ('pending_payment', 'confirmed', 'checked_in')`,
      [patient.id, slot.starts_at],
    );
    if (clash.rowCount) throw new ValidationError('You already have an appointment at that time.');

    let appointment;
    try {
      ({ rows: [appointment] } = await c.query(
        `INSERT INTO appointments (reference, patient_id, slot_id, test_id, status, price_pence, hold_expires_at)
         VALUES ($1, $2, $3, $4, 'pending_payment', $5, now() + make_interval(mins => $6)) RETURNING *`,
        [newReference(), patient.id, slot.id, test.id, test.price_pence, config.holdMinutes],
      ));
    } catch (err) {
      if (err.code === '23505') throw new ValidationError('Someone has just booked that time. Please pick another.');
      throw err;
    }
    const { rows: [clinic] } = await c.query('SELECT * FROM clinics WHERE id = $1', [slot.clinic_id]);
    await audit(c, patient.id, 'appointment.hold', 'appointment', appointment.id, { reference: appointment.reference });
    return { appointment, slot, test, clinic };
  });

  let session;
  try {
    session = await payments.createCheckoutSession({ ...booked, patient });
  } catch (err) {
    await db.query(`UPDATE appointments SET status = 'expired' WHERE id = $1`, [booked.appointment.id]);
    throw err;
  }
  await db.query(
    `INSERT INTO payments (appointment_id, amount_pence, currency, checkout_session_id, status)
     VALUES ($1, $2, $3, $4, 'pending')`,
    [booked.appointment.id, booked.appointment.price_pence, config.currency, session.id],
  );
  return { appointment: booked.appointment, checkoutUrl: session.url };
}

/** Lets a patient resume paying for a held appointment. */
async function resumeCheckout(db, { appointmentId, patientId }) {
  const payment = await db.one(
    `SELECT p.* FROM payments p JOIN appointments a ON a.id = p.appointment_id
      WHERE a.id = $1 AND a.patient_id = $2 AND a.status = 'pending_payment' AND p.status = 'pending'
      ORDER BY p.id DESC LIMIT 1`,
    [appointmentId, patientId],
  );
  if (!payment) throw new ValidationError('This booking can no longer be paid for. Please book again.');
  const session = await payments.retrieveCheckoutSession(payment.checkout_session_id);
  if (session.status !== 'open' || !session.url) throw new ValidationError('This checkout has expired. Please book again.');
  return session.url;
}

/**
 * Applies a completed Stripe Checkout session. Called from both the webhook and
 * the success redirect, so it is idempotent.
 * Returns the appointment (or null if the session is unknown/unpaid).
 */
async function applyPaidCheckout(db, session) {
  if (!session || session.payment_status !== 'paid') return null;
  const paymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;

  const outcome = await db.tx(async (c) => {
    const { rows: [payment] } = await c.query(
      'SELECT * FROM payments WHERE checkout_session_id = $1 FOR UPDATE', [session.id]);
    if (!payment) return null;
    const { rows: [appt] } = await c.query('SELECT * FROM appointments WHERE id = $1 FOR UPDATE', [payment.appointment_id]);
    if (payment.status === 'paid' || payment.status === 'refunded') return { appt, refund: false };

    await c.query(
      `UPDATE payments SET status = 'paid', paid_at = now(), payment_intent_id = $2 WHERE id = $1`,
      [payment.id, paymentIntent],
    );

    if (appt.status === 'pending_payment' || appt.status === 'expired') {
      // An expired hold is revived if nobody took the slot meanwhile.
      await c.query('SAVEPOINT revive');
      try {
        const { rows: [updated] } = await c.query(
          `UPDATE appointments SET status = 'confirmed', hold_expires_at = NULL WHERE id = $1 RETURNING *`, [appt.id]);
        await audit(c, appt.patient_id, 'appointment.paid', 'appointment', appt.id, { amount: payment.amount_pence });
        return { appt: updated, refund: false };
      } catch (err) {
        if (err.code !== '23505') throw err;
        await c.query('ROLLBACK TO SAVEPOINT revive');
      }
    }
    // Paid for a slot that is gone (or an appointment already cancelled): refund it.
    return { appt, refund: true, paymentId: payment.id };
  });

  if (!outcome) return null;
  if (outcome.refund) {
    await payments.refund(paymentIntent, outcome.appt.reference);
    await db.query(`UPDATE payments SET status = 'refunded', refunded_at = now() WHERE id = $1`, [outcome.paymentId]);
    await db.query(
      `UPDATE appointments SET status = 'cancelled', cancelled_at = now(),
              cancel_reason = 'Slot was no longer available when payment completed - refunded automatically'
        WHERE id = $1 AND status IN ('pending_payment', 'expired')`,
      [outcome.appt.id]);
    await audit(db, null, 'payment.auto_refund', 'appointment', outcome.appt.id);
    return db.one('SELECT * FROM appointments WHERE id = $1', [outcome.appt.id]);
  }
  return outcome.appt;
}

/** Stripe told us a checkout expired unpaid: release the slot. */
async function applyExpiredCheckout(db, sessionId) {
  await db.tx(async (c) => {
    const { rows: [payment] } = await c.query(
      `UPDATE payments SET status = 'failed' WHERE checkout_session_id = $1 AND status = 'pending' RETURNING *`, [sessionId]);
    if (payment) {
      await c.query(`UPDATE appointments SET status = 'expired' WHERE id = $1 AND status = 'pending_payment'`,
        [payment.appointment_id]);
    }
  });
}

/**
 * Cancels an appointment, refunding any payment when `refund` is true.
 * `actor` is the user doing it (patient, doctor or admin).
 */
async function cancelAppointment(db, { appointmentId, actor, reason, refund = true }) {
  const { appt, payment } = await db.tx(async (c) => {
    const { rows: [a] } = await c.query('SELECT * FROM appointments WHERE id = $1 FOR UPDATE', [appointmentId]);
    if (!a) throw new ValidationError('Appointment not found.');
    if (!['pending_payment', 'confirmed'].includes(a.status)) {
      throw new ValidationError(`A ${STATUS_LABELS[a.status].toLowerCase()} appointment cannot be cancelled.`);
    }
    await c.query(
      `UPDATE appointments SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2 WHERE id = $1`,
      [a.id, reason || `Cancelled by ${actor.role}`]);
    const { rows: [p] } = await c.query(
      `SELECT * FROM payments WHERE appointment_id = $1 AND status IN ('pending', 'paid') ORDER BY id DESC LIMIT 1`, [a.id]);
    if (p && p.status === 'pending') await c.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [p.id]);
    await audit(c, actor.id, 'appointment.cancel', 'appointment', a.id, { reason, refund });
    return { appt: a, payment: p };
  });

  if (payment?.status === 'pending') await payments.expireCheckoutSession(payment.checkout_session_id);
  if (payment?.status === 'paid' && refund) {
    await payments.refund(payment.payment_intent_id, appt.reference);
    await db.query(`UPDATE payments SET status = 'refunded', refunded_at = now() WHERE id = $1`, [payment.id]);
    await audit(db, actor.id, 'payment.refund', 'appointment', appt.id, { amount: payment.amount_pence });
  }
  return { refunded: payment?.status === 'paid' && refund };
}

/** Whether a patient may still cancel (with refund) themselves. */
function patientCanCancel(appt) {
  if (appt.status === 'pending_payment') return true;
  if (appt.status !== 'confirmed') return false;
  return time.hoursBetween(time.nowLocal(), appt.starts_at.slice(0, 16)) >= config.cancellationHours;
}

async function transition(db, { appointmentId, from, to, actorId, set = '', params = [], doctorId }) {
  const { rows: [appt] } = await db.query(
    `UPDATE appointments a SET status = '${to}' ${set}
       FROM slots s
      WHERE a.id = $1 AND s.id = a.slot_id AND a.status = ANY($2) ${doctorId ? 'AND s.doctor_id = $3' : ''}
      RETURNING a.*`,
    [appointmentId, from, ...(doctorId ? [doctorId] : []), ...params],
  );
  if (!appt) throw new ValidationError('That appointment cannot be updated from its current state.');
  await audit(db, actorId, `appointment.${to}`, 'appointment', appointmentId);
  return appt;
}

async function checkIn(db, { appointmentId, actorId, doctorId }) {
  const appt = await db.one(
    'SELECT a.*, s.starts_at FROM appointments a JOIN slots s ON s.id = a.slot_id WHERE a.id = $1', [appointmentId]);
  if (appt && appt.starts_at.slice(0, 10) !== time.todayLocal()) {
    throw new ValidationError('Patients can only be checked in on the day of their appointment.');
  }
  const p = doctorId ? 4 : 3;
  return transition(db, {
    appointmentId, from: ['confirmed'], to: 'checked_in', actorId, doctorId,
    set: `, checked_in_at = now(), checked_in_by = $${p}`, params: [actorId],
  });
}

async function complete(db, { appointmentId, actorId, doctorId, notes, result }) {
  const p = doctorId ? 4 : 3;
  return transition(db, {
    appointmentId, from: ['checked_in'], to: 'completed', actorId, doctorId,
    set: `, completed_at = now(), doctor_notes = $${p}, result_summary = $${p + 1}`,
    params: [notes || null, result || null],
  });
}

async function markNoShow(db, { appointmentId, actorId, doctorId }) {
  return transition(db, { appointmentId, from: ['confirmed'], to: 'no_show', actorId, doctorId });
}

module.exports = {
  STATUS_LABELS, sweepExpiredHolds, availableSlots, datesWithAvailability, startBooking, resumeCheckout,
  applyPaidCheckout, applyExpiredCheckout, cancelAppointment, patientCanCancel, checkIn, complete, markNoShow,
};
