const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, login, addSlot, inDays, request, csrfFrom, STAFF_SECRET } = require('./helpers');
const totp = require('../src/totp');
const time = require('../src/time');

let ctx;
beforeEach(async () => {
  if (ctx) await ctx.pool.end();
  ctx = await setup();
});
after(async () => ctx && ctx.pool.end());

function webhook(app, event, sig = 'valid') {
  return request(app).post('/webhooks/stripe').set('stripe-signature', sig).set('content-type', 'application/json')
    .send(JSON.stringify(event));
}

async function bookAndPay({ agent, slot }) {
  const res = await agent.post$('/patient/book', { slot_id: slot.id, test_id: ctx.test.id });
  assert.equal(res.status, 303);
  assert.match(res.headers.location, /^https:\/\/checkout\.stripe\.test\/cs_test_/);
  const sessionId = res.headers.location.split('/').pop();
  return sessionId;
}

test('public pages render and role areas are protected', async () => {
  const home = await request(ctx.app).get('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /Fit to go medical/);
  assert.match(home.text, /Blood test/);

  // Staff areas look like they don't exist to visitors and patients.
  for (const path of ['/admin', '/admin/patients', '/doctor', '/doctor/availability']) {
    assert.equal((await request(ctx.app).get(path)).status, 404, path);
  }
  assert.doesNotMatch(home.text, /staff\/login/);

  const patient = await login(ctx.app, 'pat@test.io');
  assert.equal((await patient.get('/admin')).status, 404);
  assert.equal((await patient.get('/doctor')).status, 404);
  assert.equal((await patient.get('/patient')).status, 200);
});

test('form posts without a CSRF token are rejected', async () => {
  const agent = await login(ctx.app, 'pat@test.io');
  const res = await agent.post('/patient/profile').type('form').send({ name: 'Hacker' });
  assert.equal(res.status, 403);
});

test('patient registers, books, pays via Stripe and the booking is confirmed', async () => {
  const slot = await addSlot(ctx.db, { ...ctx, startsAt: inDays(3, '10:00'), endsAt: inDays(3, '10:15') });

  const agent = request.agent(ctx.app);
  const page = await agent.get('/register');
  const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  const reg = await agent.post('/register').type('form').send({
    _csrf: csrf, name: 'New Person', email: 'new@test.io', password: 'longpassword', confirm_password: 'longpassword',
  });
  assert.equal(reg.status, 302);
  assert.equal(reg.headers.location, '/patient');

  const booking = await agent.get(`/patient/book?test=${ctx.test.id}&clinic=${ctx.clinic.id}`);
  assert.match(booking.text, /10:00/);
  const token = booking.text.match(/name="_csrf" value="([^"]+)"/)[1];
  const res = await agent.post('/patient/book').type('form').send({ _csrf: token, slot_id: slot.id, test_id: ctx.test.id });
  assert.equal(res.status, 303);
  const sessionId = res.headers.location.split('/').pop();
  const created = ctx.stripe.sessions.get(sessionId);
  assert.equal(created.params.line_items[0].price_data.unit_amount, 4900);
  assert.equal(created.params.customer_email, 'new@test.io');

  // Slot is held while paying: nobody else can see it.
  const other = await login(ctx.app, 'pat2@test.io');
  const view = await other.get(`/patient/book?clinic=${ctx.clinic.id}&date=${slot.starts_at.slice(0, 10)}`);
  assert.doesNotMatch(view.text, /name="slot_id" value="\d+"/);
  const clash = await other.post$('/patient/book', { slot_id: slot.id, test_id: ctx.test.id });
  assert.equal(clash.status, 302); // bounced back with an error

  ctx.stripe.pay(sessionId);
  const back = await agent.get(`/payments/success?session_id=${sessionId}`);
  assert.equal(back.status, 302);
  const appt = await ctx.db.one('SELECT * FROM appointments');
  assert.equal(appt.status, 'confirmed');
  const pay = await ctx.db.one('SELECT * FROM payments');
  assert.equal(pay.status, 'paid');
  assert.equal(pay.payment_intent_id, `pi_${sessionId}`);

  const detail = await agent.get(back.headers.location);
  assert.match(detail.text, /Payment received/);
  assert.match(detail.text, /Confirmed/);
});

test('Stripe webhook confirms payment, is idempotent, and rejects bad signatures', async () => {
  const slot = await addSlot(ctx.db, { ...ctx, startsAt: inDays(2, '11:00'), endsAt: inDays(2, '11:15') });
  const agent = await login(ctx.app, 'pat@test.io');
  const sessionId = await bookAndPay({ agent, slot });
  const session = ctx.stripe.pay(sessionId);

  const bad = await webhook(ctx.app, { type: 'checkout.session.completed', data: { object: session } }, 'forged');
  assert.equal(bad.status, 400);
  assert.equal((await ctx.db.one('SELECT status FROM appointments')).status, 'pending_payment');

  for (let i = 0; i < 2; i++) {
    const ok = await webhook(ctx.app, { type: 'checkout.session.completed', data: { object: session } });
    assert.equal(ok.status, 200);
  }
  assert.equal((await ctx.db.one('SELECT status FROM appointments')).status, 'confirmed');
  assert.equal((await ctx.db.one(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'appointment.paid'`)).n, 1);
});

test('expired checkout releases the slot for someone else', async () => {
  const slot = await addSlot(ctx.db, { ...ctx, startsAt: inDays(2, '12:00'), endsAt: inDays(2, '12:15') });
  const agent = await login(ctx.app, 'pat@test.io');
  const sessionId = await bookAndPay({ agent, slot });
  await webhook(ctx.app, { type: 'checkout.session.expired', data: { object: { id: sessionId } } });
  assert.equal((await ctx.db.one('SELECT status FROM appointments')).status, 'expired');

  const other = await login(ctx.app, 'pat2@test.io');
  const res = await other.post$('/patient/book', { slot_id: slot.id, test_id: ctx.test.id });
  assert.equal(res.status, 303);
});

test('payment arriving after the slot was re-booked is refunded automatically', async () => {
  const slot = await addSlot(ctx.db, { ...ctx, startsAt: inDays(2, '13:00'), endsAt: inDays(2, '13:15') });
  const first = await login(ctx.app, 'pat@test.io');
  const late = await bookAndPay({ agent: first, slot });
  await ctx.db.query(`UPDATE appointments SET status = 'expired'`);
  const second = await login(ctx.app, 'pat2@test.io');
  await bookAndPay({ agent: second, slot });

  const session = ctx.stripe.pay(late);
  await webhook(ctx.app, { type: 'checkout.session.completed', data: { object: session } });
  assert.deepEqual(ctx.stripe.refundLog.map((r) => r.payment_intent), [`pi_${late}`]);
  const rows = await ctx.db.all('SELECT status FROM appointments ORDER BY id');
  assert.deepEqual(rows.map((r) => r.status), ['cancelled', 'pending_payment']);
});

test('doctor publishes availability, checks a patient in and records results', async () => {
  const doc = await login(ctx.app, 'doc@test.io');
  const date = time.addDays(time.todayLocal(), 5);
  const res = await doc.post$('/doctor/availability', {
    clinic_id: ctx.clinic.id, date, start_time: '09:00', end_time: '10:00', slot_minutes: 20, repeat_weeks: 1,
  });
  assert.equal(res.status, 302);
  const n = await ctx.db.one('SELECT COUNT(*) AS n FROM slots');
  assert.equal(n.n, 6); // 3 slots x 2 weeks

  const overlap = await doc.post$('/doctor/availability', {
    clinic_id: ctx.clinic.id, date, start_time: '09:30', end_time: '11:00', slot_minutes: 30,
  });
  assert.equal(overlap.status, 302);
  assert.equal((await ctx.db.one('SELECT COUNT(*) AS n FROM availability')).n, 2);

  // A confirmed appointment today (inserted directly so the time can be in the past).
  const slot = await addSlot(ctx.db, { ...ctx, startsAt: `${time.todayLocal()} 00:00`, endsAt: `${time.todayLocal()} 00:15` });
  const appt = await ctx.db.one(
    `INSERT INTO appointments (reference, patient_id, slot_id, test_id, status, price_pence)
     VALUES ('FTG-TEST01', $1, $2, $3, 'confirmed', 4900) RETURNING id`, [ctx.patient.id, slot.id, ctx.test.id]);

  const day = await doc.get('/doctor');
  assert.match(day.text, /Pat One/);
  assert.equal((await doc.post$(`/doctor/appointments/${appt.id}/check-in`)).status, 302);
  assert.equal((await ctx.db.one('SELECT status FROM appointments WHERE id = $1', [appt.id])).status, 'checked_in');

  await doc.post$(`/doctor/appointments/${appt.id}/complete`, { doctor_notes: 'internal', result_summary: 'All normal' });
  const done = await ctx.db.one('SELECT * FROM appointments WHERE id = $1', [appt.id]);
  assert.equal(done.status, 'completed');
  assert.equal(done.result_summary, 'All normal');

  const pat = await login(ctx.app, 'pat@test.io');
  const page = await pat.get(`/patient/appointments/${appt.id}`);
  assert.match(page.text, /All normal/);
  assert.doesNotMatch(page.text, /internal/);
});

test('admin controls doctor permissions and clinic assignments', async () => {
  const admin = await login(ctx.app, 'admin@test.io');
  const res = await admin.post$(`/admin/doctors/${ctx.doctor.id}`, {
    name: 'Dr Dee', email: 'doc@test.io', can_check_in: 'on', clinic_ids: String(ctx.clinic.id),
  });
  assert.equal(res.status, 302);
  const profile = await ctx.db.one('SELECT * FROM doctor_profiles WHERE user_id = $1', [ctx.doctor.id]);
  assert.equal(profile.can_manage_availability, false);
  assert.equal(profile.can_check_in, true);

  const doc = await login(ctx.app, 'doc@test.io');
  const blocked = await doc.post$('/doctor/availability', {
    clinic_id: ctx.clinic.id, date: time.addDays(time.todayLocal(), 3), start_time: '09:00', end_time: '10:00', slot_minutes: 15,
  });
  assert.equal(blocked.status, 403);

  // Deactivating the doctor signs them out everywhere.
  await admin.post$(`/admin/users/${ctx.doctor.id}/toggle`);
  const after = await doc.get('/doctor');
  assert.equal(after.status, 404);
});

test('admin cancels with a Stripe refund; patient cannot cancel inside 24 hours', async () => {
  const soon = time.nowLocal() < `${time.todayLocal()} 20:00`
    ? { startsAt: inDays(0, '23:00'), endsAt: inDays(0, '23:15') }
    : { startsAt: inDays(1, '06:00'), endsAt: inDays(1, '06:15') };
  const slot = await addSlot(ctx.db, { ...ctx, ...soon });
  const pat = await login(ctx.app, 'pat@test.io');
  const sessionId = await bookAndPay({ agent: pat, slot });
  await pat.get(`/payments/success?session_id=${(ctx.stripe.pay(sessionId), sessionId)}`);
  const appt = await ctx.db.one('SELECT * FROM appointments');
  assert.equal(appt.status, 'confirmed');

  await pat.post$(`/patient/appointments/${appt.id}/cancel`);
  assert.equal((await ctx.db.one('SELECT status FROM appointments')).status, 'confirmed');

  const admin = await login(ctx.app, 'admin@test.io');
  await admin.post$(`/admin/appointments/${appt.id}/cancel`, { reason: 'Clinic closed', refund: 'on' });
  assert.equal((await ctx.db.one('SELECT status FROM appointments')).status, 'cancelled');
  assert.equal((await ctx.db.one('SELECT status FROM payments')).status, 'refunded');
  assert.equal(ctx.stripe.refundLog.length, 1);
});

test('admin dashboard and management pages render', async () => {
  const admin = await login(ctx.app, 'admin@test.io');
  for (const path of ['/admin', '/admin/appointments', '/admin/patients', `/admin/patients/${ctx.patient.id}`,
    '/admin/doctors', `/admin/doctors/${ctx.doctor.id}`, '/admin/doctors/new', '/admin/clinics', `/admin/clinics/${ctx.clinic.id}`,
    '/admin/tests', '/admin/availability', '/admin/payments', '/admin/audit', '/admin/admins',
    '/admin/appointments?from=2026-01-01&status=confirmed']) {
    const res = await admin.get(path);
    assert.equal(res.status, 200, path);
  }
  const created = await admin.post$('/admin/clinics', { name: 'East', address: '2 Road', city: 'York' });
  assert.equal(created.status, 302);
  const priced = await admin.post$('/admin/tests', { name: 'ECG', price: '65.50', duration_minutes: 20 });
  assert.equal(priced.status, 302);
  assert.equal((await ctx.db.one(`SELECT price_pence FROM tests WHERE name = 'ECG'`)).price_pence, 6550);
});

test('staff cannot use the patient sign-in, and need their phone code at the staff sign-in', async () => {
  // Correct staff password on the patient page is refused like a wrong password.
  const agent = request.agent(ctx.app);
  let csrf = csrfFrom((await agent.get('/login')).text);
  const res = await agent.post('/login').type('form').send({ _csrf: csrf, email: 'admin@test.io', password: 'Password123!' });
  assert.equal(res.status, 401);
  assert.equal((await agent.get('/admin')).status, 404);

  // Password alone is not enough at the staff sign-in.
  csrf = csrfFrom((await agent.get('/staff/login')).text);
  const step1 = await agent.post('/staff/login').type('form').send({ _csrf: csrf, email: 'admin@test.io', password: 'Password123!' });
  assert.equal(step1.headers.location, '/staff/verify');
  assert.equal((await agent.get('/admin')).status, 404);

  const wrong = await agent.post('/staff/verify').type('form').send({ _csrf: csrf, code: '000000' });
  assert.equal(wrong.headers.location, '/staff/verify');
  assert.equal((await agent.get('/admin')).status, 404);

  const code = totp.codeAt(STAFF_SECRET, totp.currentStep());
  const ok = await agent.post('/staff/verify').type('form').send({ _csrf: csrf, code });
  assert.equal(ok.headers.location, '/admin');
  assert.equal((await agent.get('/admin')).status, 200);

  // The same code can't be used again by someone else.
  const other = request.agent(ctx.app);
  const c2 = csrfFrom((await other.get('/staff/login')).text);
  await other.post('/staff/login').type('form').send({ _csrf: c2, email: 'admin@test.io', password: 'Password123!' });
  const replay = await other.post('/staff/verify').type('form').send({ _csrf: c2, code });
  assert.equal(replay.headers.location, '/staff/verify');

  // Patients can't sign in at the staff page either.
  const p = request.agent(ctx.app);
  const c3 = csrfFrom((await p.get('/staff/login')).text);
  const pat = await p.post('/staff/login').type('form').send({ _csrf: c3, email: 'pat@test.io', password: 'Password123!' });
  assert.equal(pat.status, 401);
});

test('new staff set up two-step sign-in and replace their temporary password', async () => {
  const admin = await login(ctx.app, 'admin@test.io');
  const created = await admin.post$('/admin/doctors', { name: 'Dr New', email: 'new@test.io', password: 'Temporary-pass1' });
  assert.equal(created.status, 302);

  const agent = request.agent(ctx.app);
  const csrf = csrfFrom((await agent.get('/staff/login')).text);
  const step1 = await agent.post('/staff/login').type('form').send({ _csrf: csrf, email: 'new@test.io', password: 'Temporary-pass1' });
  assert.equal(step1.headers.location, '/staff/setup');
  const setup = await agent.get('/staff/setup');
  assert.match(setup.text, /data:image\/png;base64/);
  const secret = setup.text.match(/<code class="secret">([^<]+)<\/code>/)[1].replace(/\s/g, '');
  const done = await agent.post('/staff/setup').type('form')
    .send({ _csrf: csrf, code: totp.codeAt(secret, totp.currentStep()) });
  assert.equal(done.status, 302);

  // Forced to change the temporary password before anything else.
  const home = await agent.get('/doctor');
  assert.equal(home.headers.location, '/staff/change-password');
  const page = await agent.get('/staff/change-password');
  const c2 = csrfFrom(page.text);
  const short = await agent.post('/staff/change-password').type('form').send({ _csrf: c2, new_password: 'short', confirm_password: 'short' });
  assert.equal(short.headers.location, '/staff/change-password');
  const good = await agent.post('/staff/change-password').type('form')
    .send({ _csrf: c2, new_password: 'a much longer passphrase', confirm_password: 'a much longer passphrase' });
  assert.equal(good.headers.location, '/doctor');
  assert.equal((await agent.get('/doctor')).status, 200);
  const row = await ctx.db.one(`SELECT totp_enabled, must_change_password FROM users WHERE email = 'new@test.io'`);
  assert.deepEqual(row, { totp_enabled: true, must_change_password: false });
});

test('staff are signed out after 30 minutes of inactivity', async () => {
  const doc = await login(ctx.app, 'doc@test.io');
  assert.equal((await doc.get('/doctor')).status, 200);
  await ctx.db.query(`UPDATE "session" SET sess = jsonb_set(sess::jsonb, '{lastSeen}', to_jsonb((extract(epoch from now()) * 1000 - 31 * 60000)::bigint))::json`);
  const res = await doc.get('/doctor');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/staff/login');
});
