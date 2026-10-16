const express = require('express');
const config = require('../config');
const seo = require('../seo');
const bookings = require('../services/bookings');

const money = (pence) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: config.currency.toUpperCase() })
  .format(pence / 100);

/** "Manchester", "Manchester & Rochdale", "Leeds, York & Hull" */
function listCities(clinics) {
  const cities = [...new Set(clinics.map((c) => c.city))];
  return cities.length <= 1 ? (cities[0] || '') : `${cities.slice(0, -1).join(', ')} & ${cities.at(-1)}`;
}

/** Search-result snippets are cut at about 155 characters. */
function snippet(text) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length <= 155 ? clean : `${clean.slice(0, 152).replace(/\s+\S*$/, '')}…`;
}

function testFaqs(test, clinics, cancellationHours) {
  return [
    [`How much does a ${test.name} cost?`,
      `${money(test.price_pence)}, paid securely online when you book. There are no extra fees.`],
    ['How long does the appointment take?', `About ${test.duration_minutes} minutes.`],
    ['When will I get my results?',
      `${test.turnaround ? `Results are usually ready within ${test.turnaround}. ` : ''}Your report and certificate appear in your online account as soon as the doctor completes your appointment.`],
    ['Do I need to prepare?', test.preparation || 'No special preparation is needed. Please bring photo ID.'],
    ['Can I cancel or change my booking?',
      `Yes. You can cancel online up to ${cancellationHours} hours before your appointment for a full refund.`],
    [`Where can I have a ${test.name}?`,
      clinics.length ? `At our clinics in ${listCities(clinics)}: ${clinics.map((c) => c.name).join(', ')}.` : 'Please check back soon.'],
  ];
}

function breadcrumbs(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: seo.absolute(path) })),
  };
}

module.exports = (db) => {
  const router = express.Router();
  const activeTests = () => db.all('SELECT * FROM tests WHERE is_active ORDER BY name');
  const activeClinics = () => db.all('SELECT * FROM clinics WHERE is_active ORDER BY name');

  router.get('/', async (req, res) => {
    const tests = await db.all('SELECT * FROM tests WHERE is_active ORDER BY price_pence, name');
    const clinics = await activeClinics();
    const cities = listCities(clinics);
    const from = tests.length ? Math.min(...tests.map((t) => t.price_pence)) : null;
    res.render('home', {
      title: `Medical tests & certificates${cities ? ` in ${cities}` : ''}`,
      description: snippet(`Book fit-to-fly, pre-employment, driver and blood tests online${cities ? ` in ${cities}` : ''}`
        + `${from ? ` from ${money(from)}` : ''}. GMC-registered doctors, same-week appointments and certificates in your online account.`),
      jsonLdBlocks: [seo.jsonLd(seo.organisation(clinics))],
      tests, clinics,
    });
  });

  router.get('/tests', async (req, res) => {
    const tests = await activeTests();
    const clinics = await activeClinics();
    res.render('tests', {
      title: 'Tests & prices',
      description: snippet(`Prices for every test at ${config.siteName}: ${tests.slice(0, 4).map((t) => `${t.name} ${money(t.price_pence)}`).join(', ')}. Book online${clinics.length ? ` in ${listCities(clinics)}` : ''}.`),
      tests,
    });
  });

  router.get('/tests/:slug', async (req, res, next) => {
    const test = await db.one('SELECT * FROM tests WHERE slug = $1 AND is_active', [req.params.slug]);
    if (!test) return next();
    const clinics = await activeClinics();
    const faqs = testFaqs(test, clinics, config.cancellationHours);
    const cities = listCities(clinics);
    res.render('test-page', {
      title: `${test.name}${cities ? ` in ${cities}` : ''} – ${money(test.price_pence)}`,
      description: snippet(`${test.description || test.name}. Book online for ${money(test.price_pence)}`
        + `${test.turnaround ? `, results ${test.turnaround}` : ''}${cities ? `. Clinics in ${cities}` : ''}.`),
      jsonLdBlocks: [
        seo.jsonLd(seo.testData(test, clinics)),
        seo.jsonLd(seo.faqData(faqs)),
        seo.jsonLd(breadcrumbs([['Home', '/'], ['Tests & prices', '/tests'], [test.name, `/tests/${test.slug}`]])),
      ],
      test, clinics, faqs,
    });
  });

  router.get('/clinics', async (req, res) => {
    const clinics = await activeClinics();
    res.render('clinics', {
      title: 'Our clinics',
      description: snippet(`${config.siteName} clinics in ${listCities(clinics)}: ${clinics.map((c) => `${c.name}, ${c.address}`).join('; ')}. Book a test online.`),
      clinics,
    });
  });

  router.get('/clinics/:slug', async (req, res, next) => {
    const clinic = await db.one('SELECT * FROM clinics WHERE slug = $1 AND is_active', [req.params.slug]);
    if (!clinic) return next();
    const tests = await activeTests();
    const [nextDate] = await bookings.datesWithAvailability(db, clinic.id, 60);
    res.render('clinic-page', {
      title: `${clinic.name} – medical tests in ${clinic.city}`,
      description: snippet(`${clinic.name}, ${clinic.address}, ${clinic.city}. Book ${tests.slice(0, 3).map((t) => t.name).join(', ')} and more online`
        + `${clinic.opening_hours ? `. Open ${clinic.opening_hours}` : ''}.`),
      jsonLdBlocks: [
        seo.jsonLd(seo.clinicData(clinic, tests)),
        seo.jsonLd(breadcrumbs([['Home', '/'], ['Our clinics', '/clinics'], [clinic.name, `/clinics/${clinic.slug}`]])),
      ],
      clinic, tests, nextDate: nextDate ? nextDate.date : null,
    });
  });

  // For the hosting service: answers 200 only when the site can reach its database.
  router.get('/healthz', async (req, res) => {
    try {
      await db.one('SELECT 1 AS ok');
      res.set('Cache-Control', 'no-store').json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'database unavailable' });
    }
  });

  router.get('/privacy', (req, res) => res.render('privacy', {
    title: 'Privacy policy',
    description: `How ${config.siteName} collects, uses and protects your personal and health information, and your rights.`,
  }));

  // Tells search engines every public page.
  router.get('/sitemap.xml', async (req, res, next) => {
    if (req.isStaffSite) return next();
    const tests = await activeTests();
    const clinics = await activeClinics();
    const pages = [
      ['/', '1.0'], ['/tests', '0.9'], ['/clinics', '0.8'],
      ...tests.map((t) => [`/tests/${t.slug}`, '0.8']),
      ...clinics.map((c) => [`/clinics/${c.slug}`, '0.7']),
      ['/privacy', '0.2'],
    ];
    const xml = pages.map(([path, priority]) => `  <url><loc>${seo.absolute(path)}</loc><priority>${priority}</priority></url>`);
    res.type('application/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${xml.join('\n')}\n</urlset>\n`);
  });

  return router;
};
