/**
 * Two websites from one app: the patient site (APP_URL) and the staff portal (STAFF_URL).
 * When STAFF_URL is set, each request is put on one side by the address it was sent to:
 *  - the staff portal serves only staff pages; everything else there is "Page not found"
 *  - the patient site has no staff pages at all
 * Sign-in cookies belong to one address, so a patient session and a staff session never mix.
 */
const config = require('./config');

// Paths the staff portal answers. Everything else on that address is "Page not found".
const STAFF_PATHS = ['/staff', '/doctor', '/admin', '/logout', '/account/password', '/healthz', '/robots.txt'];
// Paths the patient site must not have once the staff portal has its own address.
const STAFF_ONLY = ['/staff', '/doctor', '/admin'];

const startsWithAny = (path, prefixes) => prefixes.some((p) => path === p || path.startsWith(`${p}/`));

function notFound(res) {
  return res.status(404).render('error', { title: 'Page not found', message: 'We could not find that page.' });
}

function siteSplit(req, res, next) {
  const staffHost = config.staffHost;
  req.isStaffSite = Boolean(staffHost && req.hostname.toLowerCase() === staffHost);
  res.locals.isStaffSite = req.isStaffSite;
  res.locals.separateStaffSite = Boolean(staffHost);
  if (!staffHost) return next();

  if (req.isStaffSite) {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    if (req.path === '/') return res.redirect('/staff/login');
    if (!startsWithAny(req.path, STAFF_PATHS)) return notFound(res);
  } else if (startsWithAny(req.path, STAFF_ONLY)) {
    return notFound(res);
  }
  next();
}

/** Search engines: index the patient site, never the staff portal. */
function robots(req, res) {
  if (req.isStaffSite) return res.type('text/plain').send('User-agent: *\nDisallow: /\n');
  const privatePaths = ['/patient', '/login', '/register', '/payments', '/forgot-password', '/reset-password', '/account'];
  res.type('text/plain').send([
    'User-agent: *',
    'Allow: /',
    ...privatePaths.map((p) => `Disallow: ${p}`),
    `Sitemap: ${config.appUrl}/sitemap.xml`,
    '',
  ].join('\n'));
}

module.exports = { siteSplit, robots, STAFF_PATHS };
