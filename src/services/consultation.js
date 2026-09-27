/**
 * The consultation record a doctor fills in during the appointment.
 * FIELDS drives the form, validation and both PDFs, so a question is added in one place.
 */
const { ValidationError } = require('./availability');
const { audit } = require('./audit');
const time = require('../time');

const OUTCOMES = {
  fit: 'Fit',
  fit_with_restrictions: 'Fit with restrictions',
  unfit: 'Unfit',
  referred: 'Referred for further assessment',
};

const NORMAL_ABNORMAL = { normal: 'Normal', abnormal: 'Abnormal', not_tested: 'Not tested' };
const SMOKING = { never: 'Never smoked', ex: 'Ex-smoker', current: 'Current smoker' };

// type: number (with min/max), text, textarea, choice, checkbox, date
const SECTIONS = [
  {
    key: 'vitals',
    title: 'Vital signs',
    fields: [
      { key: 'bp_systolic', label: 'Blood pressure – systolic', unit: 'mmHg', type: 'number', min: 50, max: 260 },
      { key: 'bp_diastolic', label: 'Blood pressure – diastolic', unit: 'mmHg', type: 'number', min: 30, max: 160 },
      { key: 'pulse', label: 'Pulse', unit: 'bpm', type: 'number', min: 20, max: 250 },
      { key: 'temperature', label: 'Temperature', unit: '°C', type: 'number', min: 30, max: 45, step: 0.1 },
      { key: 'spo2', label: 'Oxygen saturation (SpO2)', unit: '%', type: 'number', min: 50, max: 100 },
      { key: 'height_cm', label: 'Height', unit: 'cm', type: 'number', min: 40, max: 250, step: 0.1 },
      { key: 'weight_kg', label: 'Weight', unit: 'kg', type: 'number', min: 2, max: 400, step: 0.1 },
    ],
  },
  {
    key: 'history',
    title: 'Medical history',
    fields: [
      { key: 'medications', label: 'Current medications', type: 'textarea', placeholder: 'Name, dose and how often – or "None"' },
      { key: 'no_known_allergies', label: 'No known allergies', type: 'checkbox' },
      { key: 'allergies', label: 'Allergies', type: 'textarea', placeholder: 'Allergy and reaction' },
      { key: 'conditions', label: 'Existing medical conditions', type: 'textarea' },
      { key: 'smoking', label: 'Smoking', type: 'choice', options: SMOKING },
      { key: 'smoking_details', label: 'Smoking details', type: 'text', placeholder: 'e.g. 10 a day, quit 2019' },
      { key: 'alcohol_units', label: 'Alcohol', unit: 'units / week', type: 'number', min: 0, max: 300 },
      { key: 'recent_illness', label: 'Recent illness, surgery or hospital stays', type: 'textarea' },
    ],
  },
  {
    key: 'findings',
    title: 'Test findings',
    fields: [
      { key: 'vision_right', label: 'Vision – right eye', type: 'text', placeholder: 'e.g. 6/6' },
      { key: 'vision_left', label: 'Vision – left eye', type: 'text', placeholder: 'e.g. 6/6' },
      { key: 'colour_vision', label: 'Colour vision', type: 'choice', options: NORMAL_ABNORMAL },
      { key: 'hearing', label: 'Hearing', type: 'choice', options: NORMAL_ABNORMAL },
      { key: 'urinalysis', label: 'Urinalysis', type: 'text', placeholder: 'e.g. NAD, or protein +' },
      { key: 'sample_type', label: 'Sample taken', type: 'text', placeholder: 'e.g. Nasal swab, venous blood' },
      { key: 'sample_id', label: 'Sample ID / lab reference', type: 'text' },
      { key: 'other_findings', label: 'Examination and other findings', type: 'textarea' },
    ],
  },
  {
    key: 'outcome',
    title: 'Outcome',
    fields: [
      { key: 'outcome', label: 'Outcome', type: 'choice', options: OUTCOMES, required: true },
      { key: 'restrictions', label: 'Restrictions / comments', type: 'textarea',
        placeholder: 'Required when the outcome is "Fit with restrictions"' },
      { key: 'valid_until', label: 'Certificate valid until', type: 'date' },
    ],
  },
];

const ALL_FIELDS = SECTIONS.flatMap((s) => s.fields);

function bmi(data) {
  const h = Number(data.height_cm) / 100;
  const w = Number(data.weight_kg);
  if (!h || !w) return null;
  return Math.round((w / (h * h)) * 10) / 10;
}

/** Turns submitted form values into a clean record. `final` enforces what's needed to complete. */
function parse(body, { final }) {
  const data = {};
  const errors = [];
  for (const f of ALL_FIELDS) {
    const raw = body[f.key];
    if (f.type === 'checkbox') {
      if (raw === 'on') data[f.key] = true;
      continue;
    }
    const value = String(raw ?? '').trim().slice(0, f.type === 'textarea' ? 3000 : 200);
    if (!value) continue;
    if (f.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n) || n < f.min || n > f.max) {
        errors.push(`${f.label} must be between ${f.min} and ${f.max}${f.unit ? ` ${f.unit}` : ''}.`);
        continue;
      }
      data[f.key] = n;
    } else if (f.type === 'choice') {
      if (!Object.hasOwn(f.options, value)) errors.push(`Choose a valid option for ${f.label.toLowerCase()}.`);
      else data[f.key] = value;
    } else if (f.type === 'date') {
      if (!time.isDate(value)) errors.push(`${f.label} must be a valid date.`);
      else data[f.key] = value;
    } else {
      data[f.key] = value;
    }
  }
  if (data.bp_systolic && data.bp_diastolic && data.bp_diastolic >= data.bp_systolic) {
    errors.push('Diastolic blood pressure must be lower than systolic.');
  }
  if (final) {
    if (!data.outcome) errors.push('Choose an outcome before completing the appointment.');
    if (data.outcome === 'fit_with_restrictions' && !data.restrictions) {
      errors.push('Describe the restrictions for a "Fit with restrictions" outcome.');
    }
  }
  if (errors.length) throw new ValidationError(errors.join(' '));
  return data;
}

async function load(db, appointmentId) {
  return db.one('SELECT * FROM consultations WHERE appointment_id = $1', [appointmentId]);
}

/** Saves the record. If the appointment was already completed, the change is marked as an amendment. */
async function save(db, { appointmentId, data, actorId, finalise = false }) {
  const existing = await load(db, appointmentId);
  const amending = Boolean(existing?.finalised_at);
  await db.query(
    `INSERT INTO consultations (appointment_id, data, outcome, recorded_by, finalised_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() END)
     ON CONFLICT (appointment_id) DO UPDATE SET
       data = EXCLUDED.data, outcome = EXCLUDED.outcome, recorded_by = EXCLUDED.recorded_by, updated_at = now(),
       finalised_at = COALESCE(consultations.finalised_at, EXCLUDED.finalised_at),
       amended_at = CASE WHEN consultations.finalised_at IS NOT NULL THEN now() ELSE consultations.amended_at END`,
    [appointmentId, JSON.stringify(data), data.outcome || null, actorId, finalise]);
  await audit(db, actorId, amending ? 'consultation.amend' : (finalise ? 'consultation.finalise' : 'consultation.save'),
    'appointment', appointmentId);
  return { amending };
}

/** Human-readable value for a field, or null when blank. */
function display(field, data) {
  const v = data[field.key];
  if (v === undefined || v === null || v === '') return null;
  if (field.type === 'checkbox') return v ? 'Yes' : null;
  if (field.type === 'choice') return field.options[v] || v;
  if (field.type === 'date') return time.formatDate(v);
  return field.unit ? `${v} ${field.unit}` : String(v);
}

/** Section rows for display: [{ title, rows: [[label, value], ...] }], blank answers left out. */
function summary(data) {
  return SECTIONS.map((section) => {
    const rows = [];
    for (const f of section.fields) {
      if (f.key === 'bp_diastolic') continue;
      if (f.key === 'bp_systolic') {
        if (data.bp_systolic || data.bp_diastolic) {
          rows.push(['Blood pressure', `${data.bp_systolic ?? '–'} / ${data.bp_diastolic ?? '–'} mmHg`]);
        }
        continue;
      }
      if (f.key === 'no_known_allergies') {
        if (data.no_known_allergies && !data.allergies) rows.push(['Allergies', 'No known allergies']);
        continue;
      }
      const value = display(f, data);
      if (value) rows.push([f.label, value]);
      if (f.key === 'weight_kg' && bmi(data)) rows.push(['Body mass index (BMI)', String(bmi(data))]);
    }
    return { title: section.title, rows };
  }).filter((s) => s.rows.length);
}

module.exports = { SECTIONS, OUTCOMES, bmi, parse, load, save, summary };
