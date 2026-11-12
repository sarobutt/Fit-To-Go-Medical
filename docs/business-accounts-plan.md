# Work with us as a business – plan

Status: **agreed design, not built yet.** Stage 1 is the next step.

Businesses sign up with Fit To Go medicals so their employees can have medicals and tests at our
clinics or at the business's own premises, with simple billing for the company.
The guiding rule is **flexibility**: every choice below is a setting, not something fixed in the code.

## Where it lives on the website

- New menu item **"For businesses"** (short enough for phones), page heading
  **"Work with us as a business"**.
- Also linked from the footer ("Company") and, optionally, a small band on the home page.

## How the system works today (for reference)

- An admin publishes a doctor's hours at a clinic; they are split into slots (10–60 minutes).
- **One slot = one person.** The database allows only one live booking per slot.
- Patients book and pay themselves (own account, card payment through Stripe).
- Doctors and admins check patients in on the day from the "Clinic day" list, then record the
  consultation; the report and certificate are generated as PDFs.
- Slots belong to a doctor, so two doctors on the same morning = two people seen in parallel.

Business testing keeps "one slot = one person". What changes is **who books, who pays, and how a
group is checked in**.

## Decisions agreed with the owner

### 1. Group size – any size
- No fixed limit: 2 people or 200.
- Businesses can ask before they know numbers ("about 30 drivers in March"). That arrives as a
  **request**, which an admin turns into real appointments once agreed.
- Capacity is flexible: add slots, days or extra doctors to a company session at any time.
  Names can be added, removed or swapped right up until check-in.

### 2. Employee details
- **Required:** name and date of birth (certificates need them; reception checks them against
  photo ID).
- **Optional:** email and phone. If given, the employee receives their own confirmation, reminder
  and – with consent – results. If not, everything goes to the company's coordinator.

### 3. Location – our clinic or theirs
The business chooses when requesting or booking:
- **At one of our clinics:** a company session using our doctors' time; its slots are reserved for
  that company and hidden from the public.
- **At their premises (we visit):** they give address, room and parking details and preferred
  dates. An admin creates an **on-site session** at that address. Optional travel/call-out fee per
  company.

### 4. Check-in – doctors and admins
- Both doctors and admins can check people in, at clinic and on-site sessions.
- A **company day list** shows every booked employee (Arrived / Not yet / No-show). Anyone booked in
  the session can be checked in at any time during it, in arrival order.
- Every check-in asks the user to confirm **photo ID matches name and date of birth**. There is
  deliberately **no "check everyone in" button**: the employer booked on the employees' behalf, so
  identity is confirmed one person at a time (otherwise a certificate could be issued in the wrong
  name).

### 5. No-shows – decided case by case
When someone is marked as a no-show, the doctor or admin chooses:
- **Charge** – full price or a set no-show fee, added to the company's invoice;
- **Reschedule** – pick a new slot, no charge;
- **Waive** – no charge, no new booking.

Each company has a default (from its agreement), pre-selected but always changeable. The choice is
recorded in the audit log and shown on the employer's summary.

### 6. Settings for each company

| Setting | Options |
|---|---|
| Prices | Standard / % discount / fixed price per test |
| Who pays | Company invoiced / employee pays / either |
| Invoicing | After each session / monthly |
| What the employer sees | Attendance only / + fit or unfit outcome / full results (only with the employee's consent) |
| No-show default | Charge / reschedule / waive |
| Location | Clinics only / on-site / both; optional travel fee |
| Who can book | Our admins only / the company's coordinator / employees with a company code |
| Tests and clinics | All, or a chosen list |
| Reminders | On / off |

## Medical confidentiality

- By default the employer sees only **attendance and the outcome** (fit / fit with restrictions /
  unfit).
- Detailed results go to the employer **only with the employee's explicit consent**, recorded at
  booking (UK GDPR; Access to Medical Reports Act 1988 for medical reports).
- Before Stage 2 goes live: update the privacy policy and consent wording, and add the new
  processing (company records, employee lists, employer access) to `docs/DPIA.md`.

## Build stages

Each stage works on its own.

### Stage 1 – the public side
- "For businesses" page in the new site style: hero, who it's for (e.g. haulage fleets, construction,
  recruitment agencies, care providers, staff who travel), what we offer (existing employer-relevant
  tests: pre-employment medicals, HGV/D4 driver medicals, blood tests, travel vaccination,
  fit-to-fly), why choose us, how it works, business FAQ.
- **Request form:** company name, contact name and job title, email, phone, industry, approximate
  headcount (or "not sure yet"), tests wanted, at our clinic or on site (with address), preferred
  dates, message, consent tickbox, spam protection (same as Careers).
- **Admin → Business requests:** list with status (New / Contacted / Agreed / Not proceeding) and
  an email alert to the clinic when a request arrives. Requests are covered by the privacy policy
  and removed after a set period.

### Stage 2 – running business sessions (by our admins)
- Company records with all the settings above.
- Employee list per company: type in, or paste/upload from a spreadsheet.
- Company sessions at a clinic or on site; slots reserved for the company. Add, remove and swap
  names; add slots, days or doctors.
- "Invoiced" payment type alongside Stripe, so company bookings are confirmed without card payment.
- Company check-in list for doctors and admins; the no-show choice (charge / reschedule / waive).
- Company invoices and attendance summaries as PDFs.

### Stage 3 – self-service for businesses
- Sign-in for company coordinators: request and book sessions, add names, see attendance.
- Company codes so employees can book themselves at the company price.
- Email reminders; text messages if wanted (needs an SMS provider).
- QR codes on confirmations for faster check-in.

## Changes to the system (summary)

- New data: companies (with settings), company employees, business requests, company sessions
  (clinic or on-site address), no-show decisions.
- Appointments gain: the company, who booked it, and a payment type (card or invoice).
- Slots can be reserved for one company.
- New pages: public business page and form; admin requests, companies, sessions and invoices;
  company check-in list. Stage 3 adds the coordinator area.
