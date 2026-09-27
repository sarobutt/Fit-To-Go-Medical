const Stripe = require('stripe');
const config = require('../config');

let client;

/** The shared Stripe client. Tests swap it for a fake with setStripe(). */
function getStripe() {
  if (!client) {
    if (!config.stripeSecretKey) {
      throw new Error('STRIPE_SECRET_KEY is not set, so payments cannot be taken. See README.');
    }
    client = new Stripe(config.stripeSecretKey);
  }
  return client;
}

function setStripe(fake) {
  client = fake;
}

function stripeConfigured() {
  return Boolean(client || config.stripeSecretKey);
}

async function createCheckoutSession({ appointment, test, clinic, slot, patient }) {
  return getStripe().checkout.sessions.create({
    mode: 'payment',
    customer_email: patient.email,
    client_reference_id: String(appointment.id),
    line_items: [{
      quantity: 1,
      price_data: {
        currency: config.currency,
        unit_amount: appointment.price_pence,
        product_data: {
          name: `${test.name} – ${config.siteName}`,
          description: `${clinic.name}, ${slot.starts_at.slice(0, 16)} (ref ${appointment.reference})`,
        },
      },
    }],
    metadata: { appointment_id: String(appointment.id), reference: appointment.reference },
    payment_intent_data: { metadata: { appointment_id: String(appointment.id), reference: appointment.reference } },
    // Stripe's minimum lifetime is 30 minutes; the slot hold matches it.
    expires_at: Math.floor(Date.now() / 1000) + config.holdMinutes * 60 + 60,
    success_url: `${config.appUrl}/payments/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.appUrl}/payments/cancelled?appointment=${appointment.id}`,
  });
}

async function retrieveCheckoutSession(id) {
  return getStripe().checkout.sessions.retrieve(id);
}

async function expireCheckoutSession(id) {
  try {
    await getStripe().checkout.sessions.expire(id);
  } catch {
    // Already completed or expired - nothing to do.
  }
}

async function refund(paymentIntentId, reference) {
  return getStripe().refunds.create({ payment_intent: paymentIntentId, metadata: { reference } });
}

function constructWebhookEvent(rawBody, signature) {
  if (!config.stripeWebhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is not set.');
  return getStripe().webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret);
}

module.exports = {
  getStripe, setStripe, stripeConfigured, createCheckoutSession, retrieveCheckoutSession,
  expireCheckoutSession, refund, constructWebhookEvent,
};
