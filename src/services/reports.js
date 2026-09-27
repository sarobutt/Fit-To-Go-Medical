/**
 * Builds the two documents a patient receives after their appointment:
 * a full medical report and a one-page certificate.
 */
const crypto = require('node:crypto');
const PDFDocument = require('pdfkit');
const config = require('../config');
const time = require('../time');
const consultation = require('./consultation');
const { audit } = require('./audit');

const BRAND = '#0f766e';
const INK = '#13201f';
const MUTED = '#5b6b69';
const RULE = '#d9e3e1';

/** Everything the documents need about one appointment. */
async function loadForDocuments(db, appointmentId) {
  const appt = await db.one(
    `SELECT a.*, s.starts_at, s.ends_at, t.name AS test_name,
            c.name AS clinic_name, c.address AS clinic_address, c.city AS clinic_city, c.phone AS clinic_phone,
            d.name AS doctor_name, dp.registration_number, dp.specialty,
            p.name AS patient_name, p.email AS patient_email, p.phone AS patient_phone, p.date_of_birth
       FROM appointments a
       JOIN slots s ON s.id = a.slot_id
       JOIN tests t ON t.id = a.test_id
       JOIN clinics c ON c.id = s.clinic_id
       JOIN users d ON d.id = s.doctor_id
       LEFT JOIN doctor_profiles dp ON dp.user_id = d.id
       JOIN users p ON p.id = a.patient_id
      WHERE a.id = $1`, [appointmentId]);
  if (!appt) return null;
  const record = await consultation.load(db, appointmentId);
  return { appt, record };
}

/** DDMMYYYY from a date of birth, used as the password on emailed copies. */
function dobPassword(dob) {
  if (!dob) return null;
  const [y, m, d] = String(dob).slice(0, 10).split('-');
  return `${d}${m}${y}`;
}

function newDocument(title, password) {
  const options = {
    size: 'A4',
    margins: { top: 50, bottom: 60, left: 50, right: 50 },
    info: { Title: title, Author: config.siteName, Subject: 'Confidential medical document' },
    bufferPages: true,
  };
  if (password) {
    Object.assign(options, {
      userPassword: password,
      ownerPassword: crypto.randomBytes(16).toString('hex'),
      permissions: { printing: 'highResolution' },
      pdfVersion: '1.7ext3',
    });
  }
  return new PDFDocument(options);
}

function toBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

function header(doc, { appt, heading }) {
  const { left } = doc.page.margins;
  const width = doc.page.width - left - doc.page.margins.right;
  doc.rect(0, 0, doc.page.width, 8).fill(BRAND);
  doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(18).text(config.siteName, left, 30);
  doc.fillColor(MUTED).font('Helvetica').fontSize(9)
    .text([appt.clinic_name, `${appt.clinic_address}, ${appt.clinic_city}`, appt.clinic_phone].filter(Boolean).join('  ·  '),
      left, 52, { width });
  doc.moveTo(left, 72).lineTo(left + width, 72).lineWidth(1).strokeColor(RULE).stroke();
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(16).text(heading, left, 88, { width });
  doc.moveDown(0.6);
}

function footers(doc, appt, amended) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const { left, right, bottom } = doc.page.margins;
    const y = doc.page.height - bottom + 20;
    const text = `Confidential medical document  ·  Ref ${appt.reference}`
      + `${amended ? `  ·  Amended ${time.formatDateTime(amended)}` : ''}  ·  Page ${i + 1} of ${range.count}`;
    doc.page.margins.bottom = 0; // allow writing in the footer area without adding a page
    doc.fillColor(MUTED).font('Helvetica').fontSize(8)
      .text(text, left, y, { width: doc.page.width - left - right, align: 'center', lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
}

function ensureSpace(doc, needed) {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

function sectionTitle(doc, title) {
  ensureSpace(doc, 50);
  const { left } = doc.page.margins;
  doc.moveDown(0.8);
  doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(11).text(title.toUpperCase(), left, doc.y, { characterSpacing: 0.6 });
  const y = doc.y + 3;
  doc.moveTo(left, y).lineTo(doc.page.width - doc.page.margins.right, y).lineWidth(0.75).strokeColor(RULE).stroke();
  doc.y = y + 8;
}

/** Label/value rows in two columns; long values wrap and push the next row down. */
function rows(doc, pairs) {
  const { left } = doc.page.margins;
  const labelWidth = 170;
  const valueX = left + labelWidth + 10;
  const valueWidth = doc.page.width - doc.page.margins.right - valueX;
  for (const [label, value] of pairs) {
    doc.font('Helvetica').fontSize(10);
    const h = Math.max(doc.heightOfString(label, { width: labelWidth }), doc.heightOfString(value, { width: valueWidth }));
    ensureSpace(doc, h + 6);
    const y = doc.y;
    doc.fillColor(MUTED).text(label, left, y, { width: labelWidth });
    doc.fillColor(INK).text(value, valueX, y, { width: valueWidth });
    doc.y = y + h + 5;
  }
}

function patientRows(appt) {
  return [
    ['Patient', appt.patient_name],
    ['Date of birth', appt.date_of_birth ? time.formatDate(appt.date_of_birth) : 'Not recorded'],
    ['Email', appt.patient_email],
    ...(appt.patient_phone ? [['Phone', appt.patient_phone]] : []),
  ];
}

function appointmentRows(appt) {
  return [
    ['Test', appt.test_name],
    ['Date of examination', time.formatDateTime(appt.starts_at)],
    ['Clinic', appt.clinic_name],
    ['Examining doctor', doctorLine(appt)],
    ['Reference', appt.reference],
  ];
}

function doctorLine(appt) {
  return appt.registration_number ? `${appt.doctor_name} (Reg. no. ${appt.registration_number})` : appt.doctor_name;
}

function signature(doc, appt, record) {
  ensureSpace(doc, 90);
  const { left } = doc.page.margins;
  doc.moveDown(2);
  const y = doc.y;
  doc.moveTo(left, y + 28).lineTo(left + 220, y + 28).lineWidth(0.75).strokeColor(INK).stroke();
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text(doctorLine(appt), left, y + 34);
  doc.fillColor(MUTED).font('Helvetica').fontSize(9)
    .text(`Examining doctor${appt.specialty ? `, ${appt.specialty}` : ''}`, left, doc.y)
    .text(`Signed electronically on ${time.formatDateTime(record.finalised_at)}`, left, doc.y);
}

/** Full report: patient, appointment, every recorded answer, outcome and result summary. */
async function medicalReport(db, appointmentId, { password } = {}) {
  const loaded = await loadForDocuments(db, appointmentId);
  if (!loaded?.record?.finalised_at) return null;
  const { appt, record } = loaded;
  const doc = newDocument(`Medical report ${appt.reference}`, password);
  header(doc, { appt, heading: `Medical report – ${appt.test_name}` });

  sectionTitle(doc, 'Patient');
  rows(doc, patientRows(appt));
  sectionTitle(doc, 'Appointment');
  rows(doc, appointmentRows(appt));
  for (const section of consultation.summary(record.data)) {
    sectionTitle(doc, section.title);
    rows(doc, section.rows);
  }
  if (appt.result_summary) {
    sectionTitle(doc, 'Doctor\'s summary');
    doc.fillColor(INK).font('Helvetica').fontSize(10).text(appt.result_summary, { width: doc.page.width - 100 });
  }
  signature(doc, appt, record);
  footers(doc, appt, record.amended_at);
  return { filename: `${appt.reference}-medical-report.pdf`, buffer: await toBuffer(doc) };
}

/** One-page certificate stating the outcome, without the detailed health answers. */
async function certificate(db, appointmentId, { password } = {}) {
  const loaded = await loadForDocuments(db, appointmentId);
  if (!loaded?.record?.finalised_at) return null;
  const { appt, record } = loaded;
  const data = record.data || {};
  const doc = newDocument(`Medical certificate ${appt.reference}`, password);
  header(doc, { appt, heading: `Medical certificate – ${appt.test_name}` });
  const { left } = doc.page.margins;
  const width = doc.page.width - left - doc.page.margins.right;

  doc.fillColor(INK).font('Helvetica').fontSize(11).text(
    `This is to certify that ${appt.patient_name}${appt.date_of_birth ? `, born ${time.formatDate(appt.date_of_birth)},` : ''} `
    + `was examined at ${appt.clinic_name} on ${time.formatDateTime(appt.starts_at)} for a ${appt.test_name}, `
    + 'and on the basis of that examination was assessed as:', left, doc.y + 8, { width, lineGap: 3 });

  const boxY = doc.y + 18;
  doc.roundedRect(left, boxY, width, 58, 6).lineWidth(1.5).strokeColor(BRAND).stroke();
  doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(22)
    .text((consultation.OUTCOMES[data.outcome] || '').toUpperCase(), left, boxY + 18, { width, align: 'center' });
  doc.y = boxY + 76;

  const details = [];
  if (data.restrictions) details.push(['Restrictions / comments', data.restrictions]);
  if (data.valid_until) details.push(['Valid until', time.formatDate(data.valid_until)]);
  if (data.sample_type) details.push(['Sample taken', data.sample_id ? `${data.sample_type} (ID ${data.sample_id})` : data.sample_type]);
  details.push(['Reference', appt.reference], ['Date issued', time.formatDateTime(record.finalised_at)]);
  rows(doc, details);

  signature(doc, appt, record);
  doc.moveDown(2);
  doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(
    `To confirm this certificate is genuine, contact ${appt.clinic_name}${appt.clinic_phone ? ` on ${appt.clinic_phone}` : ''} `
    + `quoting reference ${appt.reference}.`, left, doc.y, { width });
  footers(doc, appt, record.amended_at);
  return { filename: `${appt.reference}-certificate.pdf`, buffer: await toBuffer(doc) };
}

/**
 * Emails both documents to the patient. Attachments are protected with the patient's date of birth
 * (DDMMYYYY). Without a date of birth on file, the email only says the results are ready to download.
 * Records the outcome on the consultation so staff can see whether it was sent.
 */
async function emailToPatient(db, appointmentId, { mailer, actorId }) {
  const loaded = await loadForDocuments(db, appointmentId);
  if (!loaded?.record?.finalised_at) return { status: 'not_ready' };
  const { appt } = loaded;
  const setStatus = (status, sent) => db.query(
    `UPDATE consultations SET email_status = $2, emailed_at = CASE WHEN $3 THEN now() ELSE emailed_at END
      WHERE appointment_id = $1`, [appointmentId, status, sent]);

  if (!mailer.emailConfigured()) {
    await setStatus('Email not set up – patient can download from their account', false);
    return { status: 'not_configured' };
  }
  const password = dobPassword(appt.date_of_birth);
  const link = `${config.appUrl}/patient/appointments/${appt.id}`;
  const first = appt.patient_name.split(' ')[0];
  const lines = [`Dear ${first},`, '',
    `Your ${appt.test_name} at ${appt.clinic_name} on ${time.formatDate(appt.starts_at)} is complete.`];
  let attachments = [];
  if (password) {
    const [report, cert] = await Promise.all([
      medicalReport(db, appointmentId, { password }), certificate(db, appointmentId, { password })]);
    attachments = [report, cert].map((d) => ({ filename: d.filename, content: d.buffer, contentType: 'application/pdf' }));
    lines.push('', 'Your medical report and certificate are attached.',
      'To keep them private, the PDFs are protected with a password: your date of birth as DDMMYYYY',
      '(for example 12 April 1990 would be 12041990).');
  } else {
    lines.push('', 'Your medical report and certificate are ready to download from your account.');
  }
  lines.push('', `You can also download them any time here: ${link}`, '', `Kind regards,`, config.siteName,
    '', 'This email contains confidential medical information. If you received it by mistake, please delete it.');

  try {
    await mailer.send({
      to: appt.patient_email,
      subject: `Your ${appt.test_name} results – ${config.siteName} (ref ${appt.reference})`,
      text: lines.join('\n'),
      attachments,
    });
    await setStatus(password ? 'Sent with attachments' : 'Sent (download link only – no date of birth on file)', true);
    await audit(db, actorId, 'results.emailed', 'appointment', appointmentId, { to: appt.patient_email });
    return { status: 'sent' };
  } catch (err) {
    console.error('Email failed:', err.message);
    await setStatus(`Sending failed: ${err.message.slice(0, 150)}`, false);
    return { status: 'failed' };
  }
}

module.exports = { medicalReport, certificate, loadForDocuments, dobPassword, emailToPatient };
