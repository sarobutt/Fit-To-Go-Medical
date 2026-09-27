// Integration-test harness: a real Postgres database (TEST_DATABASE_URL) and a fake Stripe.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://fitogo:fitogo@localhost:5432/fitogo_test';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
process.env.APP_URL = 'http://localhost:3000';

const request = require('supertest');
const bcrypt = require('bcryptjs');
const { createPool, migrate, helpers } = require('../src/db');
const { createApp } = require('../src/app');
const payments = require('../src/services/payments');
const mailer = require('../src/services/mailer');
const time = require('../src/time');

let currentDb;

/** In-memory stand-in for the parts of the Stripe SDK the app uses. */
function fakeStripe() {
  const sessions = new Map();
  const refundLog = [];
  let n = 0;
  return {
    sessions,
    refundLog,
    checkout: {
      sessions: {
        create: async (params) => {
          const id = `cs_test_${++n}`;
          const s = { id, url: `https://checkout.stripe.test/${id}`, status: 'open', payment_status: 'unpaid', params };
          sessions.set(id, s);
          return s;
        },
        retrieve: async (id) => sessions.get(id),
        expire: async (id) => { sessions.get(id).status = 'expired'; },
      },
    },
    refunds: {
      create: async (params) => { refundLog.push(params); return { id: `re_${refundLog.length}` }; },
    },
    webhooks: {
      constructEvent: (body, sig) => {
        if (sig !== 'valid') throw new Error('No signatures found matching the expected signature');
        return JSON.parse(body.toString());
      },
    },
    /** Simulates the patient paying on Stripe's page. */
    pay(id) {
      const s = sessions.get(id);
      Object.assign(s, { status: 'complete', payment_status: 'paid', payment_intent: `pi_${id}` });
      return s;
    },
  };
}

async function setup() {
  const pool = createPool();
  await migrate(pool);
  await pool.query(`TRUNCATE users, clinics, tests, availability, slots, appointments, payments, audit_log, doctor_profiles,
                    doctor_clinics, "session" RESTART IDENTITY CASCADE`);
  const db = helpers(pool);
  const stripe = fakeStripe();
  payments.setStripe(stripe);
  const mail = [];
  mailer.setTransport({ sendMail: async (message) => { mail.push(message); } });
  const app = createApp(pool);

  const hash = await bcrypt.hash('Password123!', 4);
  const mkUser = (role, name, email) => db.one(
    'INSERT INTO users (role, name, email, password_hash) VALUES ($1, $2, $3, $4) RETURNING *', [role, name, email, hash]);
  const admin = await mkUser('admin', 'Ada Admin', 'admin@test.io');
  const doctor = await mkUser('doctor', 'Dr Dee', 'doc@test.io');
  currentDb = db;
  const patient = await mkUser('patient', 'Pat One', 'pat@test.io');
  const patient2 = await mkUser('patient', 'Pat Two', 'pat2@test.io');
  await db.query('INSERT INTO doctor_profiles (user_id) VALUES ($1)', [doctor.id]);
  const clinic = await db.one(`INSERT INTO clinics (name, address, city) VALUES ('Central', '1 High St', 'Leeds') RETURNING *`);
  await db.query('INSERT INTO doctor_clinics VALUES ($1, $2)', [doctor.id, clinic.id]);
  const test = await db.one(`INSERT INTO tests (name, price_pence) VALUES ('Blood test', 4900) RETURNING *`);

  return { pool, db, app, stripe, mail, admin, doctor, patient, patient2, clinic, test };
}

const csrfFrom = (html) => html.match(/name="_csrf" value="([^"]+)"/)[1];

/**
 * A supertest agent signed in as `email`, with post$() for form posts.
 * Patients use /login; staff use /staff/login.
 */
async function login(app, email, { password = 'Password123!' } = {}) {
  const agent = request.agent(app);
  const user = await currentDb.one('SELECT role FROM users WHERE email = $1', [email]);
  const staff = user.role !== 'patient';
  const loginPath = staff ? '/staff/login' : '/login';
  let csrf = csrfFrom((await agent.get(loginPath)).text);
  const res = await agent.post(loginPath).type('form').send({ _csrf: csrf, email, password });
  if (res.status !== 302) throw new Error(`login failed for ${email}: ${res.status}`);
  // The session is regenerated on sign-in, so fetch the new token.
  csrf = csrfFrom((await agent.get('/tests')).text);
  agent.post$ = (url, body = {}) => agent.post(url).type('form').send({ _csrf: csrf, ...body });
  agent.csrf = csrf;
  return agent;
}

/** Adds a slot directly (bypasses "must be in the future" so we can test same-day flows). */
async function addSlot(db, { doctor, clinic, startsAt, endsAt }) {
  const av = await db.one(
    `INSERT INTO availability (doctor_id, clinic_id, date, start_time, end_time, slot_minutes)
     VALUES ($1, $2, $3, $4, $5, 15) RETURNING id`,
    [doctor.id, clinic.id, startsAt.slice(0, 10), startsAt.slice(11, 16), endsAt.slice(11, 16)]);
  return db.one(
    `INSERT INTO slots (availability_id, doctor_id, clinic_id, starts_at, ends_at) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [av.id, doctor.id, clinic.id, startsAt, endsAt]);
}

const inDays = (d, hhmm) => `${time.addDays(time.todayLocal(), d)} ${hhmm}`;

module.exports = { setup, login, addSlot, inDays, request, csrfFrom };
