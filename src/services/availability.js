const time = require('../time');
const { audit } = require('./audit');

class ValidationError extends Error {}

const LIVE_STATUSES = `('pending_payment', 'confirmed', 'checked_in', 'completed', 'no_show')`;

/**
 * Publishes a block of working time for a doctor at a clinic and splits it
 * into bookable slots of slotMinutes each.
 */
async function createAvailability(db, { doctorId, clinicId, date, startTime, endTime, slotMinutes, createdBy }) {
  slotMinutes = parseInt(slotMinutes, 10);
  if (!time.isDate(date)) throw new ValidationError('Choose a valid date.');
  if (!time.isTime(startTime) || !time.isTime(endTime)) throw new ValidationError('Choose valid start and end times.');
  if (!Number.isInteger(slotMinutes) || slotMinutes < 5 || slotMinutes > 240) {
    throw new ValidationError('Slot length must be between 5 and 240 minutes.');
  }
  const start = time.toMinutes(startTime);
  const end = time.toMinutes(endTime);
  if (end <= start) throw new ValidationError('End time must be after start time.');
  if (end - start < slotMinutes) throw new ValidationError('The session is shorter than one slot.');
  if (date < time.todayLocal()) throw new ValidationError('You cannot add availability in the past.');
  if (date > time.addDays(time.todayLocal(), 180)) throw new ValidationError('Availability can be set up to 180 days ahead.');

  return db.tx(async (c) => {
    const assigned = await c.query(
      `SELECT 1 FROM doctor_clinics dc JOIN clinics cl ON cl.id = dc.clinic_id
        WHERE dc.doctor_id = $1 AND dc.clinic_id = $2 AND cl.is_active`,
      [doctorId, clinicId],
    );
    if (!assigned.rowCount) throw new ValidationError('This doctor is not assigned to that clinic.');

    // Serialise availability changes per doctor so two requests cannot overlap.
    await c.query('SELECT pg_advisory_xact_lock(1, $1)', [doctorId]);
    const overlap = await c.query(
      `SELECT start_time, end_time FROM availability WHERE doctor_id = $1 AND date = $2`,
      [doctorId, date],
    );
    for (const row of overlap.rows) {
      if (start < time.toMinutes(row.end_time) && time.toMinutes(row.start_time) < end) {
        throw new ValidationError(`This overlaps existing availability ${row.start_time}–${row.end_time} on that day.`);
      }
    }

    const { rows: [availability] } = await c.query(
      `INSERT INTO availability (doctor_id, clinic_id, date, start_time, end_time, slot_minutes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [doctorId, clinicId, date, startTime, endTime, slotMinutes, createdBy],
    );

    const now = time.nowLocal();
    let created = 0;
    for (let t = start; t + slotMinutes <= end; t += slotMinutes) {
      const startsAt = `${date} ${time.fromMinutes(t)}`;
      if (startsAt <= now) continue;
      await c.query(
        `INSERT INTO slots (availability_id, doctor_id, clinic_id, starts_at, ends_at) VALUES ($1, $2, $3, $4, $5)`,
        [availability.id, doctorId, clinicId, startsAt, `${date} ${time.fromMinutes(t + slotMinutes)}`],
      );
      created++;
    }
    if (!created) throw new ValidationError('Every slot in that session is already in the past.');
    await audit(c, createdBy, 'availability.create', 'availability', availability.id,
      { doctorId, clinicId, date, startTime, endTime, slotMinutes, slots: created });
    return { availability, slotsCreated: created };
  });
}

/** Removes a session, as long as nobody has booked into it. */
async function deleteAvailability(db, { availabilityId, doctorId, actorId }) {
  return db.tx(async (c) => {
    const { rows: [row] } = await c.query(
      `SELECT * FROM availability WHERE id = $1 ${doctorId ? 'AND doctor_id = $2' : ''}`,
      doctorId ? [availabilityId, doctorId] : [availabilityId],
    );
    if (!row) throw new ValidationError('Availability not found.');
    const booked = await c.query(
      `SELECT 1 FROM appointments a JOIN slots s ON s.id = a.slot_id
        WHERE s.availability_id = $1 AND a.status IN ${LIVE_STATUSES}`,
      [availabilityId],
    );
    if (booked.rowCount) {
      throw new ValidationError('Patients are booked into this session. Cancel their appointments or block the empty slots instead.');
    }
    // Keep history intact: slots referenced by old cancelled/expired appointments cannot be deleted.
    const referenced = await c.query(
      `SELECT 1 FROM appointments a JOIN slots s ON s.id = a.slot_id WHERE s.availability_id = $1`,
      [availabilityId],
    );
    if (referenced.rowCount) {
      await c.query('UPDATE slots SET is_blocked = TRUE WHERE availability_id = $1', [availabilityId]);
    } else {
      await c.query('DELETE FROM availability WHERE id = $1', [availabilityId]);
    }
    await audit(c, actorId, 'availability.delete', 'availability', availabilityId, { date: row.date });
  });
}

/** Blocks or unblocks one empty slot (e.g. for a break). */
async function setSlotBlocked(db, { slotId, doctorId, blocked, actorId }) {
  return db.tx(async (c) => {
    const { rows: [slot] } = await c.query(
      `SELECT * FROM slots WHERE id = $1 ${doctorId ? 'AND doctor_id = $2' : ''} FOR UPDATE`,
      doctorId ? [slotId, doctorId] : [slotId],
    );
    if (!slot) throw new ValidationError('Slot not found.');
    if (blocked) {
      const booked = await c.query(`SELECT 1 FROM appointments WHERE slot_id = $1 AND status IN ${LIVE_STATUSES}`, [slotId]);
      if (booked.rowCount) throw new ValidationError('That slot is booked; cancel the appointment first.');
    }
    await c.query('UPDATE slots SET is_blocked = $2 WHERE id = $1', [slotId, !!blocked]);
    await audit(c, actorId, blocked ? 'slot.block' : 'slot.unblock', 'slot', slotId);
  });
}

module.exports = { createAvailability, deleteAvailability, setSlotBlocked, ValidationError, LIVE_STATUSES };
