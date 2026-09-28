const path = require('node:path');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');

const config = require('./config');
const time = require('./time');
const { helpers } = require('./db');
const { loadUser, csrf, flash, staffArea } = require('./auth');
const { STATUS_LABELS } = require('./services/bookings');
const { ValidationError } = require('./services/availability');
const { backUrl } = require('./util');
const consultation = require('./services/consultation');

function money(pence) {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: config.currency.toUpperCase() })
    .format((pence || 0) / 100);
}

function createApp(pool) {
  const db = helpers(pool);
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('trust proxy', 1);

  Object.assign(app.locals, {
    siteName: config.siteName,
    money,
    time,
    STATUS_LABELS,
    cancellationHours: config.cancellationHours,
    staffLoginUrl: `${config.appUrl}/staff/login`,
    consultationSummary: consultation.summary,
    OUTCOMES: consultation.OUTCOMES,
    // Defaults so the error page renders even if a request fails before these are set.
    user: null,
    flash: [],
    csrfToken: '',
    path: '',
  });

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        'form-action': ["'self'", 'https://checkout.stripe.com'],
      },
    },
    // Send the page address only within this site, so "go back" after an error returns to the right page.
    referrerPolicy: { policy: 'same-origin' },
  }));
  // On the live site, always use an encrypted (https) connection.
  if (config.isProduction) {
    app.use((req, res, next) => (req.secure ? next() : res.redirect(301, `https://${req.get('host')}${req.originalUrl}`)));
  }
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: config.isProduction ? '1d' : 0 }));
  // Pages with personal or medical details must not be kept in the browser's cache
  // (e.g. the back button on a shared computer after signing out).
  app.use(['/patient', '/payments', '/login', '/register', '/account'], (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // Stripe webhooks need the raw body for signature checks, so mount before the form parser.
  app.use('/webhooks', require('./routes/webhooks')(db));

  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(session({
    store: new PgSession({ pool, tableName: 'session', createTableIfMissing: false }),
    name: 'ftg.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.isProduction, maxAge: 1000 * 60 * 60 * 8 },
  }));
  app.use(flash);
  app.use(csrf);
  app.use(loadUser(db));
  app.use((req, res, next) => {
    res.locals.path = req.path;
    next();
  });

  app.use('/', require('./routes/public')(db));
  app.use('/', require('./routes/auth')(db));
  app.use('/payments', require('./routes/payments')(db));
  app.use('/patient', require('./routes/patient')(db));
  app.use('/staff', staffArea, require('./routes/staff')(db));
  app.use('/doctor', staffArea, require('./routes/doctor')(db));
  app.use('/admin', staffArea, require('./routes/admin')(db));

  app.use((req, res) => {
    res.status(404).render('error', { title: 'Page not found', message: 'We could not find that page.' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ValidationError && req.flash) {
      req.flash('error', err.message);
      return res.redirect(backUrl(req, '/'));
    }
    if (err.type && String(err.type).startsWith('Stripe') && req.flash) {
      console.error('Stripe error:', err.message);
      req.flash('error', 'We could not reach our payment provider. Please try again in a moment.');
      return res.redirect(backUrl(req, '/'));
    }
    console.error(err);
    res.status(500).render('error', { title: 'Something went wrong', message: 'Please try again in a moment.' });
  });

  return app;
}

module.exports = { createApp, money };
