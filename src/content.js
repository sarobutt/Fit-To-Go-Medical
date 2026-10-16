/**
 * Starter search content. Search terms are the other names people type into Google for each test;
 * they're filled in only for tests with these exact names and only where none are set yet.
 * The guides are created as unpublished drafts for the clinic to check and edit before publishing.
 */

const SEARCH_TERMS = {
  'fit-to-fly pcr test': 'fit to fly certificate, fit to fly test, PCR test for travel, travel PCR test, covid test for travel, pre-departure test',
  'pre-employment medical': 'pre-employment health check, occupational health medical, work medical, employment medical, fitness to work assessment',
  'full blood count': 'FBC blood test, full blood count test, private blood test, anaemia blood test',
  'sports & fitness medical': 'sports medical, athlete medical, pre-participation screening, fitness medical, ECG for sport',
  'hgv / d4 driver medical': 'D4 medical, HGV medical, LGV medical, PCV medical, bus driver medical, taxi driver medical, DVLA medical',
  'travel vaccination consultation': 'travel vaccinations, travel clinic, travel jabs, vaccines for travel, travel health advice',
};

const GUIDES = [
  {
    title: 'What is a fit-to-fly certificate and when do you need one?',
    summary: 'What a fit-to-fly certificate is, who asks for one, and how to get one in time for your flight.',
    search_terms: 'fit to fly certificate, fit to fly letter, do I need a fit to fly certificate, fit to fly test',
    body: `A fit-to-fly certificate is a document signed by a doctor that confirms you are well enough to travel by air, or that records the result of a test an airline or destination asks for.

## Who asks for one?

- **Airlines**, for example if you are pregnant beyond a certain stage, have recently had surgery or been unwell, or travel with a medical condition or equipment.
- **Some destinations**, which may ask for a recent test result before you arrive.
- **Employers and tour operators**, for work trips or organised travel.

Rules change and differ between airlines and countries. Always check your airline's own requirements and the UK government's foreign travel advice at gov.uk/foreign-travel-advice before you book a test.

## When should I book?

Many requirements say the certificate or test must be dated within a set number of days or hours of departure. Check that time window first, then book an appointment that lets your result arrive in time. Our appointment page shows the usual time for results for each test.

## What happens at the appointment?

A doctor checks your details and asks about your health. If a test is needed, a sample is taken. Bring photo ID, ideally your passport, so the details on your certificate match your travel documents.

## Getting your certificate

When your appointment is complete, your certificate appears in your online account to download and print, and we email you a copy.`,
  },
  {
    title: 'What happens at a pre-employment medical?',
    summary: 'The checks usually included in a pre-employment or occupational health medical, and what to bring.',
    search_terms: 'pre-employment medical, what happens at a pre-employment medical, occupational health medical, work medical',
    body: `Some employers ask new staff to have a medical before they start, to make sure the job is safe for them and to plan any support they might need.

## What is usually checked?

Your employer may tell you exactly what they need. A typical pre-employment medical includes:

- a short questionnaire about your health and any medication
- blood pressure and pulse
- height, weight and body mass index (BMI)
- eyesight, and colour vision for some jobs
- hearing
- a urine test

## What should I bring?

- Photo ID
- Any forms your employer has given you
- Glasses or contact lenses, if you wear them
- A list of any medicines you take

## How long does it take?

Most appointments take around 30 minutes.

## What happens afterwards?

The doctor records the outcome. This is usually **fit**, **fit with restrictions** (for example, adjustments your employer should make) or, rarely, **unfit** for the specific role. You receive a report and a certificate in your online account, which you can share with your employer.`,
  },
  {
    title: 'HGV and bus driver (D4) medicals: what to bring',
    summary: 'How the D4 medical for lorry, bus and coach licences works, and how to prepare so it goes smoothly.',
    search_terms: 'D4 medical, HGV medical, what to bring to a D4 medical, DVLA D4 form, bus driver medical',
    body: `If you are applying for, or renewing, a lorry, bus or coach licence, the DVLA asks for a medical examination report, called the D4 form, completed by a doctor.

## What to bring

- **The D4 form.** You can order it from the DVLA or get it via gov.uk.
- **Photo ID**, such as your driving licence or passport.
- **Glasses or contact lenses**, if you wear them for driving.
- **A list of your medicines**, and details of any medical conditions, hospital letters or specialist contacts.

## What happens at the appointment?

The doctor goes through the medical sections of the D4 form with you. This usually includes your medical history, eyesight and blood pressure, checked against the DVLA's medical standards for these licences.

## After the appointment

The doctor signs the completed form. The DVLA must receive it within a set time after the doctor signs it, so send your application promptly. The current guidance is on gov.uk.

If the doctor finds something that may affect your fitness to drive, they will explain it to you and what to do next.`,
  },
];

/** Fills in starter content: search terms for the default tests and draft guides. Safe to run repeatedly. */
async function addStarterContent(q) {
  for (const [name, terms] of Object.entries(SEARCH_TERMS)) {
    await q.query('UPDATE tests SET search_terms = $2 WHERE lower(name) = $1 AND search_terms IS NULL', [name, terms]);
  }
  const { rowCount } = await q.query('SELECT 1 FROM guides LIMIT 1');
  if (rowCount) return;
  const { slugify } = require('./seo');
  for (const g of GUIDES) {
    await q.query(
      `INSERT INTO guides (title, slug, summary, body, search_terms, is_published) VALUES ($1, $2, $3, $4, $5, FALSE)
       ON CONFLICT (slug) DO NOTHING`,
      [g.title, slugify(g.title), g.summary, g.body, g.search_terms]);
  }
}

module.exports = { SEARCH_TERMS, GUIDES, addStarterContent };
