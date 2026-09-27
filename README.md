# Fit to go medical

A booking website for a medical-testing clinic. It has three kinds of user:

| Role | What they can do |
|---|---|
| **Patient** | Create an account and browse tests and clinics. Pick a live time slot and pay by card, Apple Pay or Google Pay through **Stripe Checkout**. See, pay for or cancel their bookings (cancelling gives an automatic refund up to 24 h before the appointment), and read their results. |
| **Doctor** | See the day's patients and **check them in** (or mark them as a no-show). Record clinical notes and a result summary for the patient, and see a patient's earlier visits. **Publish availability**, meaning sessions at their clinics that are split into bookable slots and can repeat weekly. Block or unblock single slots. |
| **Admin** (superuser) | See an overview dashboard: revenue, bookings per day, and how full each clinic is along with its completions, cancellations and no-shows. Manage clinics and tests/prices. Add doctors, **switch each doctor's permissions on and off**, and choose which clinics each doctor works at. View and edit **patient records** with their full appointment, result and payment history. Manage every appointment: check in, complete, cancel with a Stripe refund. Publish availability for any doctor. Deactivate any account or reset its password, add more admins, and read the full audit log. |

Doctor permissions an admin controls: *manage availability & slots*, *check patients in*, *record notes & results*, *view patient history*, *cancel appointments (with refund)*.

## Tech stack

- **Node.js 20+ / Express 5** with server-rendered EJS pages. There is no front-end build step.
- **PostgreSQL** as the online database. Neon, Supabase, Render, Railway, AWS RDS or any other Postgres host works. Login sessions are stored in the database too.
- **Stripe Checkout** for payments, with a **webhook** that confirms bookings and **refunds** through the Stripe API.
- Security: bcrypt password hashes, CSRF tokens on every form, Helmet security headers, role and permission checks on every route, a login-attempt brake, and an audit trail.

## How booking and payment works

1. The patient picks a slot. The slot is **held for 30 minutes** and the patient is sent to Stripe Checkout.
2. Stripe calls `POST /webhooks/stripe` with `checkout.session.completed` and the booking becomes **Confirmed**. The success page also checks with Stripe, so the patient sees the confirmation immediately.
3. If the checkout expires or is abandoned, the slot is released.
4. If a payment arrives after the slot has already gone to someone else, it is **refunded automatically**.
5. The database has a unique index that makes double-booking a slot impossible.

## Going live

### 1. Create the online database

Create a Postgres database on your chosen host, e.g. [Neon](https://neon.tech) or [Supabase](https://supabase.com) (both have free tiers). Copy its **connection string**, e.g. `postgres://user:pass@ep-xyz.eu-west-2.aws.neon.tech/neondb?sslmode=require`.

The tables are created automatically the first time the app or the seed script runs.

### 2. Set up Stripe

1. In the [Stripe dashboard](https://dashboard.stripe.com/apikeys), copy your **secret key**. Use `sk_test_...` while testing and `sk_live_...` when you go live.
2. Go to **Developers → Webhooks → Add endpoint** and enter:
   - URL: `https://YOUR-DOMAIN/webhooks/stripe`
   - Events: `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`
3. Copy the endpoint's **signing secret** (`whsec_...`).

### 3. Deploy the website

Any Node host works: Render, Railway, Fly.io, Heroku, or a VPS. Set these environment variables (see `.env.example`):

| Variable | Value |
|---|---|
| `DATABASE_URL` | your Postgres connection string |
| `STRIPE_SECRET_KEY` | `sk_live_...` / `sk_test_...` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` |
| `APP_URL` | your public address, e.g. `https://fittogomedical.co.uk` |
| `SESSION_SECRET` | a long random string |
| `NODE_ENV` | `production` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | the first administrator's login |

Optional variables: `CURRENCY` (default `gbp`), `CLINIC_TIMEZONE` (default `Europe/London`), `CANCELLATION_HOURS` (default `24`), `SITE_NAME`.

- Build command: `npm install`
- Start command: `npm start`
- Run once after the first deploy: `npm run seed`. This creates the admin account plus starter clinics and tests, which you can then edit in the admin area.

Then sign in as the admin, go to **Doctors → Add doctor**, and assign each doctor their clinics and permissions. Doctors then publish their availability, and patients can start booking.

## Running locally

```bash
cp .env.example .env              # fill in DATABASE_URL and the Stripe test keys
npm install
npm run seed -- --demo            # admin, clinics, tests + demo doctors, patient & 2 weeks of slots
npm run dev                       # http://localhost:3000
```

To receive Stripe webhooks locally, install the [Stripe CLI](https://stripe.com/docs/stripe-cli) and run
`stripe listen --forward-to localhost:3000/webhooks/stripe`. Put the `whsec_...` it prints into `.env`.
Test card: `4242 4242 4242 4242`, any future date and any CVC.

Demo logins (created by `--demo`, for local use only):

| Role | Email | Password |
|---|---|---|
| Admin | admin@fittogo.test | ChangeMe123! (or your `ADMIN_PASSWORD`) |
| Doctor | amina@fittogo.test / james@fittogo.test | Doctor123! |
| Patient | patient@fittogo.test | Patient123! |

## Tests

The integration tests run against a real Postgres database and a fake Stripe client:

```bash
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/fitogo_test npm test
```

⚠️ The test run **wipes** that database, so never point it at your live one.

## Project layout

```
src/
  server.js, app.js      app bootstrap, middleware, error handling
  config.js, db.js       settings; Postgres pool + schema
  auth.js                sessions, roles, doctor permissions, CSRF
  services/              bookings (hold → pay → confirm → check-in → complete), availability & slots, Stripe, audit
  routes/                public, auth, patient, doctor, admin, payments, webhooks
  seed.js                first admin + starter data
views/                   EJS pages per role
public/                  CSS, JS, favicon
test/                    integration tests
```
