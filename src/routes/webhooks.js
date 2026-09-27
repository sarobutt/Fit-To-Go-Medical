const express = require('express');
const payments = require('../services/payments');
const bookings = require('../services/bookings');

module.exports = (db) => {
  const router = express.Router();

  router.post('/stripe', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    let event;
    try {
      event = payments.constructWebhookEvent(req.body, req.get('stripe-signature'));
    } catch (err) {
      return res.status(400).send(`Webhook error: ${err.message}`);
    }

    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        await bookings.applyPaidCheckout(db, event.data.object);
        break;
      case 'checkout.session.expired':
      case 'checkout.session.async_payment_failed':
        await bookings.applyExpiredCheckout(db, event.data.object.id);
        break;
      default:
        break;
    }
    res.json({ received: true });
  });

  return router;
};
