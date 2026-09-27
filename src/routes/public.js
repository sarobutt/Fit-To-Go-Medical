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

  return router;
};
