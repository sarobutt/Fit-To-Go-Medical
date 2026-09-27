/**
 * Sets up the database and creates the first administrator, clinics and tests.
 *   npm run seed            -> admin + starter clinics & tests (safe to re-run)
 *   npm run seed -- --demo  -> also demo doctors, a demo patient and two weeks of slots
 */
const bcrypt = require('bcryptjs');
const { createPool, migrate, helpers } = require('./db');
const { createAvailability } = require('./services/availability');
const time = require('./time');

const CLINICS = [
  ['Fit to go medical – City Centre', '12 King Street', 'Manchester', '0161 555 0101', 'Mon–Fri 8am–6pm, Sat 9am–1pm'],
  ['Fit to go medical – Airport', 'Terminal 2 Arrivals Hall', 'Manchester', '0161 555 0202', 'Every day 6am–10pm'],
  ['Fit to go medical – Northside', '48 Oldham Road', 'Rochdale', '01706 555 0303', 'Mon–Fri 9am–5pm'],
];

const TESTS = [
  ['Fit-to-Fly PCR Test', 'Certified PCR swab with a signed fit-to-fly certificate accepted by airlines.', 'Avoid eating, drinking or brushing teeth 30 minutes before your swab.', 8900, 15, '24 hours'],
  ['Pre-Employment Medical', 'Full occupational health medical with vision, hearing, BP and urinalysis.', 'Bring photo ID, glasses/contact lenses and any employer forms.', 12000, 30, 'Same day'],
  ['Full Blood Count', 'Checks red cells, white cells and platelets to screen for a wide range of conditions.', 'No fasting needed. Drink plenty of water beforehand.', 4900, 15, '48 hours'],
  ['Sports & Fitness Medical', 'Cardiovascular screening, ECG and musculoskeletal check before competitive sport.', 'Wear comfortable clothing.', 14900, 30, 'Same day'],
  ['HGV / D4 Driver Medical', 'DVLA D4 medical for lorry, bus and coach licences.', 'Bring your D4 form, photo ID and glasses if you wear them.', 6500, 20, 'Same day'],
  ['Travel Vaccination Consultation', 'Personalised travel health advice and vaccination plan.', 'Bring your travel itinerary and vaccination records.', 3500, 15, 'Immediate'],
];

async function seed({ demo = false } = {}) {
  const pool = createPool();
  await migrate(pool);
  const db = helpers(pool);

  try {
    const adminEmail = (process.env.ADMIN_EMAIL || 'admin@fittogo.test').toLowerCase();
    const adminPassword = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
    if (!(await db.one(`SELECT 1 FROM users WHERE role = 'admin'`))) {
      await db.query(`INSERT INTO users (role, name, email, password_hash) VALUES ('admin', 'Clinic Administrator', $1, $2)`,
        [adminEmail, await bcrypt.hash(adminPassword, 12)]);
      console.log(`Created administrator ${adminEmail}${process.env.ADMIN_PASSWORD ? '' : ` (password: ${adminPassword} – change it after signing in)`}`);
    }

    if (!(await db.one('SELECT 1 FROM clinics'))) {
      for (const c of CLINICS) {
        await db.query('INSERT INTO clinics (name, address, city, phone, opening_hours) VALUES ($1, $2, $3, $4, $5)', c);
      }
      console.log(`Created ${CLINICS.length} clinics`);
    }
    if (!(await db.one('SELECT 1 FROM tests'))) {
      for (const t of TESTS) {
        await db.query(
          'INSERT INTO tests (name, description, preparation, price_pence, duration_minutes, turnaround) VALUES ($1, $2, $3, $4, $5, $6)', t);
      }
      console.log(`Created ${TESTS.length} tests`);
    }

    if (demo) await seedDemo(db);
  } finally {
    await pool.end();
  }
}

async function seedDemo(db) {
  if (await db.one(`SELECT 1 FROM users WHERE role = 'doctor'`)) {
    console.log('Demo doctors already exist – skipping demo data');
    return;
  }
  const password = await bcrypt.hash('Doctor123!', 12);
  const clinics = await db.all('SELECT id FROM clinics ORDER BY id');
  const doctors = [
    ['Dr Amina Hassan', 'amina@fittogo.test', 'General Practitioner', [0, 1]],
    ['Dr James Walker', 'james@fittogo.test', 'Occupational Health', [0, 2]],
  ];
  for (const [name, email, specialty, clinicIdx] of doctors) {
    const u = await db.one(`INSERT INTO users (role, name, email, password_hash) VALUES ('doctor', $1, $2, $3) RETURNING id`,
      [name, email, password]);
    await db.query('INSERT INTO doctor_profiles (user_id, specialty) VALUES ($1, $2)', [u.id, specialty]);
    for (const i of clinicIdx) {
      if (clinics[i]) await db.query('INSERT INTO doctor_clinics VALUES ($1, $2)', [u.id, clinics[i].id]);
    }
    for (let d = 0; d < 14; d++) {
      const date = time.addDays(time.todayLocal(), d);
      const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
      if (weekday === 0) continue;
      const clinicId = clinics[clinicIdx[d % clinicIdx.length]].id;
      try {
        await createAvailability(db, {
          doctorId: u.id, clinicId, date, startTime: '09:00', endTime: weekday === 6 ? '13:00' : '17:00',
          slotMinutes: 20, createdBy: u.id,
        });
      } catch {
        // e.g. all of today's slots are already in the past
      }
    }
  }
  await db.query(`INSERT INTO users (role, name, email, password_hash, phone, date_of_birth)
                  VALUES ('patient', 'Sam Patient', 'patient@fittogo.test', $1, '07700 900123', '1990-04-12')`,
  [await bcrypt.hash('Patient123!', 12)]);
  console.log('Created demo doctors (amina@ / james@fittogo.test, password Doctor123!) with 2 weeks of slots');
  console.log('Created demo patient patient@fittogo.test (password Patient123!)');
}

if (require.main === module) {
  seed({ demo: process.argv.includes('--demo') }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { seed };
