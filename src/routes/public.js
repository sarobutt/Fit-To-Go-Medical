const express = require('express');

module.exports = (db) => {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const tests = await db.all('SELECT * FROM tests WHERE is_active ORDER BY price_pence');
    const clinics = await db.all('SELECT * FROM clinics WHERE is_active ORDER BY name');
    res.render('home', { title: 'Book your medical test', tests, clinics });
  });

  router.get('/tests', async (req, res) => {
    const tests = await db.all('SELECT * FROM tests WHERE is_active ORDER BY name');
    res.render('tests', { title: 'Tests & prices', tests });
  });

  router.get('/clinics', async (req, res) => {
    const clinics = await db.all('SELECT * FROM clinics WHERE is_active ORDER BY name');
    res.render('clinics', { title: 'Our clinics', clinics });
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

  router.get('/privacy', (req, res) => res.render('privacy', { title: 'Privacy policy' }));

  return router;
};
