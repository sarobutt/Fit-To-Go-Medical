# Fit to go medical

A booking website for a medical-testing clinic. It has three kinds of user:

| Role | What they can do |
|---|---|
| **Patient** | Create an account and browse tests and clinics. Pick a live time slot and pay by card, Apple Pay or Google Pay through **Stripe Checkout**. See, pay for or cancel their bookings (cancelling gives an automatic refund up to 24 h before the appointment), and read their results. |
| **Doctor** | See the day's patients and **check them in** (or mark them as a no-show). Record clinical notes and a result summary for the patient, and see a patient's earlier visits. **Publish availability**, meaning sessions at their clinics that are split into bookable slots and can repeat weekly. Block or unblock single slots. |
| **Admin** (superuser) | See an overview dashboard: revenue, bookings per day, and how full each clinic is along with its completions, cancellations and no-shows. Manage clinics and tests/prices. Add doctors, **switch each doctor's permissions on and off**, and choose which clinics each doctor works at. View and edit **patient records** with their full appointment, result and payment history. Manage every appointment: check in, complete, cancel with a Stripe refund. Publish availability for any doctor. Deactivate any account or reset its password, add more admins, and read the full audit log. |

## Staff privacy & security

The doctor and admin areas are private:

- **Separate staff sign-in** at `/staff/login`. The public site doesn't link to it, and the patient sign-in refuses staff accounts.
- **Email and password sign-in** for doctors and admins. Only an admin can create staff accounts.
- **Hidden from everyone else.** Anyone not signed in as the right kind of staff gets "Page not found" on `/admin` and `/doctor` pages, so they can't tell the pages exist. Staff pages are never cached or indexed by search engines.
- **Temporary passwords must be replaced** at first sign-in with one of at least 12 characters. This applies to new staff accounts and password resets.
- **Automatic sign-out** after 30 minutes of inactivity (`STAFF_IDLE_MINUTES`).
- **Signed out everywhere** when an admin deactivates them or resets their password.
- **Limits on guessing:** after 5 wrong passwords they must wait 15 minutes. Failed staff sign-ins are recorded in the audit log.
- **Optional clinic-only access:** set `STAFF_ALLOWED_IPS` to your clinic's IP address(es) and staff pages only open from there.

**Forgotten password:** another admin opens the person's page and clicks **Reset password**. If the *only* admin is locked out, run this on the server:
`npm run staff:reset -- their@email.com`. It prints a new temporary password.

## Patients' data rights

- **Forgot password:** patients get a single-use link by email, valid for one hour. Only a scrambled (hashed) copy of the link is stored. The page never reveals whether an email address has an account. This needs email set up; without it, patients are told to contact the clinic.
- **Download my data:** under *My details*, patients download everything held about them as a file.
- **Delete my account:** patients send a request, which appears under **Admin → Requests** with the one-month reply deadline. When deletion is approved, **Remove personal details** on the patient's record strips their name, email, phone and date of birth and closes the account. Clinical and payment records stay, without a name attached, for the legally required retention period.
- **Privacy policy** at `/privacy`: a draft. Fill in everything in [square brackets] and have it checked. Then set `PRIVACY_POLICY_FINAL=true` to hide the "draft" notice.

## Consultation record, report and certificate

When a patient has been checked in, the doctor fills in the **consultation record** on the appointment page. They only fill in what applies to the test, and can **save progress** as they go:

- **Vital signs:** blood pressure, pulse, temperature, oxygen saturation, height and weight. BMI is worked out automatically.
- **Medical history:** medications, allergies (or "no known allergies"), existing conditions, smoking, alcohol, and recent illness or surgery.
- **Test findings:** vision (right and left eye), colour vision, hearing, urinalysis, sample taken with its ID, and other examination findings.
- **Outcome:** Fit / Fit with restrictions / Unfit / Referred, plus restrictions and a "valid until" date.
- **Notes:** a summary for the patient, and private clinical notes that never appear on the patient's documents.

**Complete appointment & create documents** produces two PDFs:
- **Medical report:** everything recorded, signed by the doctor with their registration number.
- **Certificate:** a one-page statement of the outcome, for an airline or employer.

The patient downloads both from their account. They are also **emailed** to the patient, protected with the patient's date of birth (DDMMYYYY) as the password. If the patient has no date of birth on file, the email contains a link instead. Doctors and admins can open both PDFs and re-send the email. If a completed record needs correcting, the documents show that it was amended and when.

Set each doctor's registration number (e.g. GMC number) in **Admin → Doctors**. To turn on email, fill in the `SMTP_*` settings in `.env` (see `.env.example`).

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

**Easiest: Render Blueprint.** In Render, choose **New → Blueprint** and pick this repository. `render.yaml` sets everything up:
- only the `main` branch goes live
- the exact library versions from `package-lock.json` are installed
- Node 22 is used
- the site runs in an EU data centre
- a health check at `/healthz` keeps the old version running until a new one is working
- `SESSION_SECRET` is generated for you

Render then asks for the secret values listed below.

**Keeping it running safely.** GitHub runs all the tests on every change (`.github/workflows/ci.yml`). Once a month, Dependabot opens a pull request with library updates. Merge anything into `main` only when its tests show ✅. If a deploy goes wrong, use **Rollback** in Render.

**Any other Node host**

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

Then sign in as the admin at `https://YOUR-DOMAIN/staff/login`, go to **Doctors → Add doctor**, and assign each doctor their clinics and permissions. Doctors then publish their availability, and patients can start booking.

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

Demo logins (created by `--demo`, for local use only). Patients sign in at `/login`. Staff sign in at **`/staff/login`** and are asked to set up an authenticator app the first time:

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
