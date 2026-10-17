const express = require('express');
const config = require('../config');
const mailer = require('../services/mailer');
const { tooManyAttempts, recordFailure, LIMITS } = require('../ratelimit');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = ['Doctor', 'Nurse', 'Healthcare assistant', 'Phlebotomist', 'Receptionist', 'Other'];
const text = (v, max) => String(v ?? '').trim().slice(0, max);

/** Careers page: a short application form. Applications are saved for Admin and emailed to CAREERS_EMAIL if set. */
module.exports = (db) => {
  const router = express.Router();
  const show = (res, form = {}, status = 200) => res.status(status).render('careers', {
    title: 'Careers',
    description: `Join ${config.siteName}: we're looking for doctors, nurses, healthcare assistants and reception staff. Send us your details in a minute.`,
    roles: ROLES, form,
  });

  router.get('/careers', (req, res) => show(res));

  router.post('/careers', async (req, res) => {
    const form = {
      name: text(req.body.name, 200), email: text(req.body.email, 200).toLowerCase(), phone: text(req.body.phone, 50),
      role: ROLES.includes(req.body.role) ? req.body.role : '', message: text(req.body.message, 3000),
    };
    // A field people can't see: only automated spam fills it in. Pretend it worked.
    if (req.body.website) return res.redirect('/careers/thanks');
    const key = `careers|${req.ip}`;
    if (tooManyAttempts(key, LIMITS.applications)) {
      res.locals.flash = [{ type: 'error', message: 'Too many applications from this connection. Please try again later.' }];
      return show(res, form, 429);
    }
    const errors = [];
    if (form.name.length < 2) errors.push('Please enter your full name.');
    if (!EMAIL.test(form.email)) errors.push('Please enter a valid email address.');
    if (!form.role) errors.push('Please choose the role you\'re interested in.');
    if (req.body.consent !== 'on') errors.push('Please confirm we can use your details to consider your application.');
    if (errors.length) {
      res.locals.flash = errors.map((message) => ({ type: 'error', message }));
      return show(res, form, 400);
    }
    recordFailure(key); // counts every application sent

    await db.query(`DELETE FROM job_applications WHERE created_at < now() - interval '12 months'`);
    const application = await db.one(
      `INSERT INTO job_applications (name, email, phone, role, message) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [form.name, form.email, form.phone || null, form.role, form.message || null]);

    if (config.careersEmail) {
      try {
        const result = await mailer.send({
          to: config.careersEmail,
          replyTo: form.email,
          subject: `Job application: ${form.role} – ${form.name}`,
          text: [
            `New application from the ${config.siteName} Careers page.`, '',
            `Name: ${form.name}`, `Email: ${form.email}`, `Phone: ${form.phone || '—'}`, `Role: ${form.role}`, '',
            form.message || '(no message)', '',
            'Reply to this email to contact the applicant.',
          ].join('\n'),
        });
        if (result.sent) await db.query('UPDATE job_applications SET emailed = TRUE WHERE id = $1', [application.id]);
      } catch (err) {
        console.error('Could not email job application:', err.message); // still saved for Admin
      }
    }
    res.redirect('/careers/thanks');
  });

  router.get('/careers/thanks', (req, res) => res.render('careers-thanks', { title: 'Application sent' }));

  return router;
};

module.exports.ROLES = ROLES;
