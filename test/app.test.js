const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, login, addSlot, inDays, request } = require('./helpers');
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

  const anon = await request(ctx.app).get('/admin');
  assert.equal(anon.status, 302);
  assert.equal(anon.headers.location, '/login');

  const patient = await login(ctx.app, 'pat@test.io');
  assert.equal((await patient.get('/admin')).status, 403);
  assert.equal((await patient.get('/doctor')).status, 403);
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

  // Deactivating the doctor signs them out.
  await admin.post$(`/admin/users/${ctx.doctor.id}/toggle`);
  const after = await doc.get('/doctor');
  assert.equal(after.status, 302);
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
