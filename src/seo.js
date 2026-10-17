/** Search-engine helpers: page addresses ("slugs"), absolute links and structured data. */
const config = require('./config');

/** "Fit-to-Fly PCR Test" → "fit-to-fly-pcr-test" */
function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'page';
}

/** A slug not yet used in `table` (adds -2, -3 … when needed). */
async function uniqueSlug(q, table, name, exceptId = 0) {
  const base = slugify(name);
  for (let n = 1; ; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    const { rowCount } = await q.query(`SELECT 1 FROM ${table} WHERE slug = $1 AND id <> $2`, [slug, exceptId]);
    if (!rowCount) return slug;
  }
}

/** Gives every test and clinic a page address if it doesn't have one yet. */
async function backfillSlugs(q) {
  for (const table of ['tests', 'clinics']) {
    const { rows } = await q.query(`SELECT id, name FROM ${table} WHERE slug IS NULL ORDER BY id`);
    for (const row of rows) {
      await q.query(`UPDATE ${table} SET slug = $2 WHERE id = $1`, [row.id, await uniqueSlug(q, table, row.name, row.id)]);
    }
  }
}

const absolute = (path) => `${config.appUrl}${path}`;

/** Pages search engines may list. Everything else (accounts, sign-in, payments) is marked noindex. */
const INDEXABLE = [
  /^\/$/, /^\/tests(\/[a-z0-9-]+){0,2}$/, /^\/clinics(\/[a-z0-9-]+)?$/, /^\/medical-tests\/[a-z0-9-]+$/,
  /^\/guides(\/[a-z0-9-]+)?$/, /^\/careers$/, /^\/faq$/, /^\/privacy$/,
];
const isIndexable = (path) => INDEXABLE.some((re) => re.test(path));

/** "fit to fly test, travel PCR test" → ['fit to fly test', 'travel PCR test'] */
const terms = (text) => [...new Set(String(text || '').split(/[,\n]/).map((t) => t.trim()).filter(Boolean))];

function organisation(clinics) {
  return {
    '@context': 'https://schema.org',
    '@type': 'MedicalOrganization',
    name: config.siteName,
    url: absolute('/'),
    logo: absolute('/favicon.svg'),
    location: clinics.map((c) => ({ '@type': 'MedicalClinic', name: c.name, url: absolute(`/clinics/${c.slug}`) })),
  };
}

function clinicData(clinic, tests) {
  return {
    '@context': 'https://schema.org',
    '@type': 'MedicalClinic',
    name: clinic.name,
    url: absolute(`/clinics/${clinic.slug}`),
    telephone: clinic.phone || undefined,
    address: { '@type': 'PostalAddress', streetAddress: clinic.address, addressLocality: clinic.city, addressCountry: 'GB' },
    description: clinic.opening_hours ? `Opening hours: ${clinic.opening_hours}` : undefined,
    parentOrganization: { '@type': 'MedicalOrganization', name: config.siteName, url: absolute('/') },
    availableService: tests.map((t) => ({ '@type': 'MedicalTest', name: t.name, url: absolute(`/tests/${t.slug}`) })),
  };
}

function testData(test, clinics, path = `/tests/${test.slug}`) {
  const alternateName = terms(test.search_terms);
  return {
    '@context': 'https://schema.org',
    '@type': 'Service',
    serviceType: 'Medical test',
    name: test.name,
    alternateName: alternateName.length ? alternateName : undefined,
    description: test.description || undefined,
    url: absolute(path),
    provider: { '@type': 'MedicalOrganization', name: config.siteName, url: absolute('/') },
    areaServed: [...new Set(clinics.map((c) => c.city))].map((city) => ({ '@type': 'City', name: city })),
    offers: {
      '@type': 'Offer', price: (test.price_pence / 100).toFixed(2), priceCurrency: config.currency.toUpperCase(),
      url: absolute(path), availability: 'https://schema.org/InStock',
    },
  };
}

function faqData(faqs) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
  };
}

function guideData(guide) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: guide.title,
    description: guide.summary || undefined,
    keywords: terms(guide.search_terms).join(', ') || undefined,
    url: absolute(`/guides/${guide.slug}`),
    datePublished: guide.published_at ? new Date(guide.published_at).toISOString() : undefined,
    dateModified: new Date(guide.updated_at).toISOString(),
    author: { '@type': 'Organization', name: config.siteName, url: absolute('/') },
    publisher: { '@type': 'Organization', name: config.siteName, logo: { '@type': 'ImageObject', url: absolute('/favicon.svg') } },
  };
}

/** JSON for a <script type="application/ld+json"> block, safe to place inside HTML. */
function jsonLd(data) {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

module.exports = {
  slugify, uniqueSlug, backfillSlugs, absolute, isIndexable, terms, organisation, clinicData, testData, faqData, guideData, jsonLd,
};
