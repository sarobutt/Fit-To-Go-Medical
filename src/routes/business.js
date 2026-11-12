const express = require('express');
const config = require('../config');
const mailer = require('../services/mailer');
const { tooManyAttempts, recordFailure, LIMITS } = require('../ratelimit');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INDUSTRIES = [
  'Transport & logistics', 'Construction', 'Recruitment', 'Care & healthcare', 'Aviation & travel',
  'Retail & hospitality', 'Manufacturing', 'Office & professional services', 'Public sector & education', 'Other',
];
const HEADCOUNTS = ['1–10', '11–50', '51–200', 'More than 200', 'Not sure yet'];
const LOCATIONS = {
  clinic: 'At one of your clinics',
  onsite: 'At our premises (you visit us)',
  either: 'Either – happy to discuss',
};
const STATUSES = { new: 'New', contacted: 'Contacted', agreed: 'Agreed', not_proceeding: 'Not proceeding' };
const KEEP_MONTHS = 24;
const text = (v, max) => String(v ?? '').trim().slice(0, max);
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).map(String);

/**
 * "For businesses": a page for employers and a request form. Requests are saved for Admin
 * (Admin → Business requests) and emailed to BUSINESS_EMAIL if set.
 */
module.exports = (db) => {
  const router = express.Router();

  const show = async (res, form = {}, status = 200) => {
    const tests = await db.all('SELECT id, name, duration_minutes FROM tests WHERE is_active ORDER BY name');
    res.status(status).render('business', {
      title: 'Work with us as a business',
      description: `Medicals and health checks for your staff with ${config.siteName}: at our clinics or at your premises, `
        + 'for any size of team, with agreed prices and one invoice. Send us an enquiry.',
      tests, industries: INDUSTRIES, headcounts: HEADCOUNTS, locations: LOCATIONS,
      form: { tests: [], ...form },
    });
  };

  router.get('/business', (req, res) => show(res));

  router.post('/business', async (req, res) => {
    const activeTests = await db.all('SELECT name FROM tests WHERE is_active ORDER BY name');
    const chosen = list(req.body.tests).filter((t) => activeTests.some((a) => a.name === t));
    const form = {
      company: text(req.body.company, 200),
      contact_name: text(req.body.contact_name, 200),
      job_title: text(req.body.job_title, 200),
      email: text(req.body.email, 200).toLowerCase(),
      phone: text(req.body.phone, 50),
      industry: INDUSTRIES.includes(req.body.industry) ? req.body.industry : '',
      headcount: HEADCOUNTS.includes(req.body.headcount) ? req.body.headcount : '',
      tests: chosen,
      location: Object.hasOwn(LOCATIONS, req.body.location) ? req.body.location : '',
      site_address: text(req.body.site_address, 1000),
      preferred_dates: text(req.body.preferred_dates, 500),
      message: text(req.body.message, 3000),
    };
    // A field people can't see: only automated spam fills it in. Pretend it worked.
    if (req.body.website) return res.redirect('/business/thanks');
    const key = `business|${req.ip}`;
    if (tooManyAttempts(key, LIMITS.applications)) {
      res.locals.flash = [{ type: 'error', message: 'Too many requests from this connection. Please try again later.' }];
      return show(res, form, 429);
    }
    const errors = [];
    if (form.company.length < 2) errors.push('Please enter your company name.');
    if (form.contact_name.length < 2) errors.push('Please enter your name.');
    if (!EMAIL.test(form.email)) errors.push('Please enter a valid email address.');
    if (!form.headcount) errors.push('Please tell us roughly how many people (or choose "Not sure yet").');
    if (!form.location) errors.push('Please choose where you\'d like the tests done.');
    if (form.location === 'onsite' && form.site_address.length < 3) {
      errors.push('Please tell us where your premises are, so we can plan the visit.');
    }
    if (req.body.consent !== 'on') errors.push('Please confirm we can use these details to reply to your request.');
    if (errors.length) {
      res.locals.flash = errors.map((message) => ({ type: 'error', message }));
      return show(res, form, 400);
    }
    recordFailure(key); // counts every request sent

    await db.query(`DELETE FROM business_requests WHERE created_at < now() - make_interval(months => $1)`, [KEEP_MONTHS]);
    const saved = await db.one(
      `INSERT INTO business_requests (company, contact_name, job_title, email, phone, industry, headcount, tests,
                                      location, site_address, preferred_dates, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [form.company, form.contact_name, form.job_title || null, form.email, form.phone || null, form.industry || null,
        form.headcount, form.tests.join(', ') || null, form.location, form.site_address || null,
        form.preferred_dates || null, form.message || null]);

    if (config.businessEmail) {
      try {
        const result = await mailer.send({
          to: config.businessEmail,
          replyTo: form.email,
          subject: `Business enquiry: ${form.company} (${form.headcount})`,
          text: [
            `New enquiry from the ${config.siteName} "For businesses" page.`, '',
            `Company: ${form.company}`, `Industry: ${form.industry || '—'}`,
            `Contact: ${form.contact_name}${form.job_title ? `, ${form.job_title}` : ''}`,
            `Email: ${form.email}`, `Phone: ${form.phone || '—'}`, '',
            `How many people: ${form.headcount}`, `Tests: ${form.tests.join(', ') || 'Not chosen yet'}`,
            `Where: ${LOCATIONS[form.location]}`, ...(form.site_address ? [`Premises: ${form.site_address}`] : []),
            `Preferred dates: ${form.preferred_dates || '—'}`, '',
            form.message || '(no message)', '',
            'Reply to this email to contact them. The request is also in Admin → Business requests.',
          ].join('\n'),
        });
        if (result.sent) await db.query('UPDATE business_requests SET emailed = TRUE WHERE id = $1', [saved.id]);
      } catch (err) {
        console.error('Could not email business enquiry:', err.message); // still saved for Admin
      }
    }
    res.redirect('/business/thanks');
  });

  router.get('/business/thanks', (req, res) => res.render('business-thanks', { title: 'Request sent' }));

  return router;
};

Object.assign(module.exports, { INDUSTRIES, HEADCOUNTS, LOCATIONS, STATUSES, KEEP_MONTHS });
