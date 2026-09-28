const { Pool, types } = require('pg');
const config = require('./config');

// Keep DATE and TIMESTAMP (without time zone) as plain strings. Slot times are
// clinic-local wall-clock times and must not be shifted by the server's zone.
types.setTypeParser(1082, (v) => v); // date
types.setTypeParser(1114, (v) => v); // timestamp
types.setTypeParser(20, (v) => parseInt(v, 10)); // bigint (COUNT, SUM)

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  role          TEXT NOT NULL CHECK (role IN ('patient', 'doctor', 'admin')),
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  phone         TEXT,
  date_of_birth DATE,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (lower(email));
-- Staff must replace a temporary password at first sign-in.
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

-- Per-doctor permissions; admins switch these on and off.
CREATE TABLE IF NOT EXISTS doctor_profiles (
  user_id                  INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  specialty                TEXT,
  bio                      TEXT,
  can_manage_availability  BOOLEAN NOT NULL DEFAULT TRUE,
  can_check_in             BOOLEAN NOT NULL DEFAULT TRUE,
  can_record_results       BOOLEAN NOT NULL DEFAULT TRUE,
  can_view_patient_history BOOLEAN NOT NULL DEFAULT TRUE,
  can_cancel_appointments  BOOLEAN NOT NULL DEFAULT FALSE
);
-- Professional registration (e.g. GMC number) printed on reports and certificates.
ALTER TABLE doctor_profiles ADD COLUMN IF NOT EXISTS registration_number TEXT;

CREATE TABLE IF NOT EXISTS clinics (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  address       TEXT NOT NULL,
  city          TEXT NOT NULL,
  phone         TEXT,
  opening_hours TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which clinics each doctor may work at (assigned by an admin).
CREATE TABLE IF NOT EXISTS doctor_clinics (
  doctor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  PRIMARY KEY (doctor_id, clinic_id)
);

CREATE TABLE IF NOT EXISTS tests (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  description      TEXT,
  preparation      TEXT,
  price_pence      INTEGER NOT NULL CHECK (price_pence >= 0),
  duration_minutes INTEGER NOT NULL DEFAULT 15,
  turnaround       TEXT,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE
);

-- A block of time a doctor works at a clinic; it is split into bookable slots.
CREATE TABLE IF NOT EXISTS availability (
  id           SERIAL PRIMARY KEY,
  doctor_id    INTEGER NOT NULL REFERENCES users(id),
  clinic_id    INTEGER NOT NULL REFERENCES clinics(id),
  date         DATE NOT NULL,
  start_time   TEXT NOT NULL,
  end_time     TEXT NOT NULL,
  slot_minutes INTEGER NOT NULL,
  created_by   INTEGER REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- starts_at / ends_at are clinic-local wall-clock times.
CREATE TABLE IF NOT EXISTS slots (
  id              SERIAL PRIMARY KEY,
  availability_id INTEGER NOT NULL REFERENCES availability(id) ON DELETE CASCADE,
  doctor_id       INTEGER NOT NULL REFERENCES users(id),
  clinic_id       INTEGER NOT NULL REFERENCES clinics(id),
  starts_at       TIMESTAMP NOT NULL,
  ends_at         TIMESTAMP NOT NULL,
  is_blocked      BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (doctor_id, starts_at)
);
CREATE INDEX IF NOT EXISTS idx_slots_clinic_start ON slots (clinic_id, starts_at);

CREATE TABLE IF NOT EXISTS appointments (
  id              SERIAL PRIMARY KEY,
  reference       TEXT NOT NULL UNIQUE,
  patient_id      INTEGER NOT NULL REFERENCES users(id),
  slot_id         INTEGER NOT NULL REFERENCES slots(id),
  test_id         INTEGER NOT NULL REFERENCES tests(id),
  status          TEXT NOT NULL CHECK (status IN
                    ('pending_payment', 'confirmed', 'checked_in', 'completed', 'cancelled', 'no_show', 'expired')),
  price_pence     INTEGER NOT NULL,
  hold_expires_at TIMESTAMPTZ,
  checked_in_at   TIMESTAMPTZ,
  checked_in_by   INTEGER REFERENCES users(id),
  completed_at    TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  cancel_reason   TEXT,
  doctor_notes    TEXT,
  result_summary  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- A slot can hold at most one live appointment: double booking is impossible at the DB level.
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_live_slot ON appointments (slot_id)
  WHERE status IN ('pending_payment', 'confirmed', 'checked_in', 'completed', 'no_show');
CREATE INDEX IF NOT EXISTS idx_appointments_patient ON appointments (patient_id);

-- What the doctor records during the appointment (vitals, history, findings, outcome).
CREATE TABLE IF NOT EXISTS consultations (
  appointment_id INTEGER PRIMARY KEY REFERENCES appointments(id) ON DELETE CASCADE,
  data           JSONB NOT NULL DEFAULT '{}',
  outcome        TEXT CHECK (outcome IN ('fit', 'fit_with_restrictions', 'unfit', 'referred')),
  recorded_by    INTEGER REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalised_at   TIMESTAMPTZ,
  amended_at     TIMESTAMPTZ,
  emailed_at     TIMESTAMPTZ,
  email_status   TEXT
);

CREATE TABLE IF NOT EXISTS payments (
  id             SERIAL PRIMARY KEY,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id),
  amount_pence   INTEGER NOT NULL,
  currency       TEXT NOT NULL,
  provider       TEXT NOT NULL DEFAULT 'stripe',
  checkout_session_id TEXT UNIQUE,
  payment_intent_id   TEXT,
  status         TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at        TIMESTAMPTZ,
  refunded_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_payments_appointment ON payments (appointment_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id),
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  INTEGER,
  details    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Used by connect-pg-simple for login sessions.
CREATE TABLE IF NOT EXISTS "session" (
  sid    VARCHAR NOT NULL PRIMARY KEY,
  sess   JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_expire ON "session" (expire);
`;

function createPool(connectionString = config.databaseUrl) {
  if (!connectionString) {
    throw new Error(config.envFileExists
      ? `DATABASE_URL is missing from ${config.envFile}. Add a line like DATABASE_URL=postgresql://... and save the file.`
      : `No .env file found at ${config.envFile}. Copy .env.example, name the copy exactly ".env" and fill in DATABASE_URL (see README).`);
  }
  return new Pool({
    connectionString,
    // Encrypted and certificate-checked, so the connection can't be intercepted by an impostor server.
    // DATABASE_SSL_VERIFY=false is only for hosts whose certificates can't be verified.
    ssl: config.databaseSsl(connectionString) ? { rejectUnauthorized: config.databaseSslVerify } : false,
    max: 10,
  });
}

async function migrate(pool) {
  await pool.query(SCHEMA);
}

/** Runs fn(client) inside a transaction, rolling back if it throws. */
async function transaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Small helpers so callers can write `await db.one(sql, params)`. */
function helpers(pool) {
  return {
    pool,
    query: (sql, params) => pool.query(sql, params),
    all: async (sql, params) => (await pool.query(sql, params)).rows,
    one: async (sql, params) => (await pool.query(sql, params)).rows[0],
    tx: (fn) => transaction(pool, fn),
  };
}

module.exports = { createPool, migrate, transaction, helpers };
