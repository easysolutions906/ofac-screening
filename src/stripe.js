import Stripe from 'stripe';
import { createKey, revokeKey, loadKeys } from './keys.js';

const PRICE_TO_PLAN = {
  'price_1TBhuHBAfS5cSTak4zFbMcjd': 'starter',
  'price_1TBhuHBAfS5cSTakssX2WmXU': 'pro',
  'price_1TBhuIBAfS5cSTakxRXrUcgc': 'business',
  'price_1TBhuIBAfS5cSTakotD0gYYd': 'enterprise',
};

const PLAN_TO_PRICE = Object.fromEntries(
  Object.entries(PRICE_TO_PLAN).map(([k, v]) => [v, k]),
);

const getStripe = () => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) { return null; }
  return new Stripe(key);
};

// Create a Stripe Checkout session for a plan
const createCheckoutSession = async (plan, successUrl, cancelUrl) => {
  const stripe = getStripe();
  if (!stripe) { throw new Error('Stripe not configured'); }

  const priceId = PLAN_TO_PRICE[plan];
  if (!priceId) { throw new Error(`Invalid plan: ${plan}`); }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl || 'https://example.com/success?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: cancelUrl || 'https://example.com/cancel',
    metadata: { plan },
  });

  return { url: session.url, sessionId: session.id };
};

// Handle Stripe webhook events
const handleWebhook = (rawBody, signature) => {
  const stripe = getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  if (stripe && webhookSecret && signature) {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } else {
    event = JSON.parse(rawBody);
  }

  const handlers = {
    'checkout.session.completed': (session) => {
      const email = session.customer_details?.email;
      const plan = session.metadata?.plan || 'pro';
      const stripeCustomerId = session.customer;
      const result = createKey(plan, email, stripeCustomerId);
      console.log(`[stripe] Key created for ${email} (${plan}): ${result.apiKey}`);
      return { apiKey: result.apiKey, plan, email };
    },

    'customer.subscription.updated': (subscription) => {
      const priceId = subscription.items?.data?.[0]?.price?.id;
      const newPlan = PRICE_TO_PLAN[priceId];
      if (newPlan) {
        console.log(`[stripe] Subscription updated to ${newPlan} for ${subscription.customer}`);
      }
      return { action: 'subscription_updated', plan: newPlan };
    },

    'customer.subscription.deleted': (subscription) => {
      const keys = loadKeys();
      const match = Object.entries(keys).find(
        ([, v]) => v.stripeCustomerId === subscription.customer && v.active,
      );
      if (match) {
        revokeKey(match[0]);
        console.log(`[stripe] Key revoked for customer ${subscription.customer}`);
        return { action: 'key_revoked', customer: subscription.customer };
      }
      return { action: 'no_matching_key' };
    },
  };

  const handler = handlers[event.type];
  if (handler) { return handler(event.data.object); }
  return { action: 'ignored', type: event.type };
};

export { createCheckoutSession, handleWebhook, PLAN_TO_PRICE, PRICE_TO_PLAN };
