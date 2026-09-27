/**
 * Consultation form, completion and documents. Shared by the doctor and admin areas;
 * `findAppointment` decides which appointments the signed-in user may touch.
 */
const bookings = require('../services/bookings');
const consultation = require('../services/consultation');
const reports = require('../services/reports');
const mailer = require('../services/mailer');
const { ValidationError } = require('../services/availability');
const { audit } = require('../services/audit');
const { notFound } = require('../auth');

const text = (v) => String(v ?? '').trim().slice(0, 5000) || null;

function sendPdf(res, doc) {
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `inline; filename="${doc.filename}"`,
    'Cache-Control': 'no-store',
  });
  res.send(doc.buffer);
}

function emailFlash(req, result) {
  if (result.status === 'sent') req.flash('success', 'The report and certificate have been emailed to the patient.');
  else if (result.status === 'not_configured') req.flash('info', 'Email isn\'t set up yet, so the patient can download the report and certificate from their account.');
  else if (result.status === 'failed') req.flash('error', 'The email couldn\'t be sent. The patient can still download the documents from their account.');
}

/**
 * @param router express router to add routes to
 * @param base   URL prefix of the area ('/doctor' or '/admin')
 * @param findAppointment async (req, id) => appointment row (with status) or null
 * @param canEdit (req) => boolean
 */
function consultationRoutes(router, db, { base, findAppointment, canEdit }) {
  router.post('/appointments/:id/consultation', async (req, res) => {
    const id = parseInt(req.params.id, 10) || 0;
    const appt = await findAppointment(req, id);
    if (!appt) return notFound(res);
    if (!canEdit(req)) throw new ValidationError('You don\'t have permission to record results.');
    const finishing = req.body.action === 'complete';

    if (appt.status === 'checked_in') {
      const data = consultation.parse(req.body, { final: finishing });
      if (!finishing) {
        await consultation.save(db, { appointmentId: id, data, actorId: req.user.id });
        await db.query('UPDATE appointments SET doctor_notes = $2, result_summary = $3 WHERE id = $1',
          [id, text(req.body.doctor_notes), text(req.body.result_summary)]);
        req.flash('success', 'Saved. You can carry on and complete the appointment when ready.');
        return res.redirect(`${base}/appointments/${id}`);
      }
      await bookings.complete(db, {
        appointmentId: id, actorId: req.user.id, notes: text(req.body.doctor_notes), result: text(req.body.result_summary),
      });
      await consultation.save(db, { appointmentId: id, data, actorId: req.user.id, finalise: true });
      req.flash('success', 'Appointment completed. The medical report and certificate are ready.');
      emailFlash(req, await reports.emailToPatient(db, id, { mailer, actorId: req.user.id }));
      return res.redirect(`${base}/appointments/${id}`);
    }

    if (appt.status === 'completed') {
      // Correcting a completed record: it must still be complete, and the documents show it was amended.
      const data = consultation.parse(req.body, { final: true });
      await consultation.save(db, { appointmentId: id, data, actorId: req.user.id });
      await db.query('UPDATE appointments SET doctor_notes = $2, result_summary = $3 WHERE id = $1',
        [id, text(req.body.doctor_notes), text(req.body.result_summary)]);
      req.flash('success', 'Record amended. The report and certificate now show the corrected details.');
      return res.redirect(`${base}/appointments/${id}`);
    }
    throw new ValidationError('Check the patient in before recording the consultation.');
  });

  for (const [path, build] of [['report.pdf', reports.medicalReport], ['certificate.pdf', reports.certificate]]) {
    router.get(`/appointments/:id/${path}`, async (req, res) => {
      const id = parseInt(req.params.id, 10) || 0;
      if (!(await findAppointment(req, id))) return notFound(res);
      const doc = await build(db, id);
      if (!doc) return notFound(res);
      await audit(db, req.user.id, `document.view_${path.replace('.pdf', '')}`, 'appointment', id);
      sendPdf(res, doc);
    });
  }

  router.post('/appointments/:id/email-results', async (req, res) => {
    const id = parseInt(req.params.id, 10) || 0;
    if (!(await findAppointment(req, id))) return notFound(res);
    const result = await reports.emailToPatient(db, id, { mailer, actorId: req.user.id });
    if (result.status === 'not_ready') throw new ValidationError('Complete the appointment before sending results.');
    emailFlash(req, result);
    res.redirect(`${base}/appointments/${id}`);
  });
}

module.exports = { consultationRoutes, sendPdf };
