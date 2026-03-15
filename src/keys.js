import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KEYS_PATH = join(__dirname, 'data', 'keys.json');

// --- Plans ---

const PLANS = {
  free: { name: 'Free', screensPerDay: 10, batchLimit: 5, ratePerMinute: 5 },
  starter: { name: 'Starter', screensPerDay: 100, batchLimit: 25, ratePerMinute: 15 },
  pro: { name: 'Pro', screensPerDay: 1000, batchLimit: 50, ratePerMinute: 60 },
  business: { name: 'Business', screensPerDay: 5000, batchLimit: 100, ratePerMinute: 200 },
  enterprise: { name: 'Enterprise', screensPerDay: 50000, batchLimit: 100, ratePerMinute: 500 },
};

// --- Key storage (JSON file) ---

const loadKeys = () => {
  if (!existsSync(KEYS_PATH)) { return {}; }
  return JSON.parse(readFileSync(KEYS_PATH, 'utf-8'));
};

const saveKeys = (keys) => {
  writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2) + '\n');
};

// --- Usage tracking (in-memory, resets daily) ---

const usage = new Map(); // key/ip -> { date: 'YYYY-MM-DD', screens: 0 }

const today = () => new Date().toISOString().slice(0, 10);

const getUsage = (identifier) => {
  const current = usage.get(identifier);
  const d = today();
  if (!current || current.date !== d) {
    usage.set(identifier, { date: d, screens: 0 });
    return usage.get(identifier);
  }
  return current;
};

const incrementUsage = (identifier, count = 1) => {
  const u = getUsage(identifier);
  u.screens += count;
};

// --- Rate limiting (sliding window per minute) ---

const rateBuckets = new Map(); // key/ip -> [timestamp, ...]

const checkRateLimit = (identifier, maxPerMinute) => {
  const now = Date.now();
  const window = 60000;
  const bucket = rateBuckets.get(identifier) || [];
  const recent = bucket.filter((t) => now - t < window);
  rateBuckets.set(identifier, recent);

  if (recent.length >= maxPerMinute) {
    return { allowed: false, retryAfterMs: window - (now - recent[0]) };
  }

  recent.push(now);
  return { allowed: true };
};

// --- Key management ---

const createKey = (plan = 'pro', email = null, stripeCustomerId = null) => {
  const keys = loadKeys();
  const apiKey = `ofac_${randomUUID().replace(/-/g, '')}`;

  keys[apiKey] = {
    plan,
    email,
    stripeCustomerId,
    createdAt: new Date().toISOString(),
    active: true,
  };

  saveKeys(keys);
  return { apiKey, plan, ...PLANS[plan] };
};

const revokeKey = (apiKey) => {
  const keys = loadKeys();
  if (keys[apiKey]) {
    keys[apiKey].active = false;
    keys[apiKey].revokedAt = new Date().toISOString();
    saveKeys(keys);
    return true;
  }
  return false;
};

const validateKey = (apiKey) => {
  if (!apiKey) { return null; }
  const keys = loadKeys();
  const entry = keys[apiKey];
  if (!entry || !entry.active) { return null; }
  return { ...entry, ...PLANS[entry.plan] };
};

// --- Express middleware ---

const authMiddleware = (req, res, next) => {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;

  // Determine plan
  const keyData = validateKey(apiKey);
  const plan = keyData ? PLANS[keyData.plan] : PLANS.free;
  const identifier = apiKey || `ip:${clientIp}`;

  // Rate limit check
  const rateCheck = checkRateLimit(identifier, plan.ratePerMinute);
  if (!rateCheck.allowed) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      retryAfterMs: rateCheck.retryAfterMs,
      plan: keyData ? keyData.plan : 'free',
      limit: `${plan.ratePerMinute}/minute`,
    });
  }

  // Daily usage check
  const u = getUsage(identifier);
  if (u.screens >= plan.screensPerDay) {
    return res.status(429).json({
      error: 'Daily screening limit exceeded',
      used: u.screens,
      limit: plan.screensPerDay,
      plan: keyData ? keyData.plan : 'free',
      resetsAt: `${today()}T23:59:59Z`,
      upgrade: apiKey ? 'Contact support to upgrade your plan' : 'Add an API key to increase your limit',
    });
  }

  // Attach to request
  req.plan = plan;
  req.planName = keyData ? keyData.plan : 'free';
  req.identifier = identifier;
  req.apiKey = apiKey || null;

  next();
};

// --- Stripe webhook handler ---

const handleStripeWebhook = (rawBody, signature) => {
  // TODO: add Stripe signature verification when STRIPE_WEBHOOK_SECRET is configured
  // const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  // stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  const event = JSON.parse(rawBody);

  const handlers = {
    'checkout.session.completed': (session) => {
      const email = session.customer_details?.email;
      const plan = session.metadata?.plan || 'pro';
      const stripeCustomerId = session.customer;
      const result = createKey(plan, email, stripeCustomerId);
      console.log(`New key created for ${email}: ${result.apiKey} (${plan})`);
      // TODO: send email with API key via SendGrid/Resend/etc.
      return result;
    },
    'customer.subscription.deleted': (subscription) => {
      const keys = loadKeys();
      const match = Object.entries(keys).find(
        ([, v]) => v.stripeCustomerId === subscription.customer && v.active,
      );
      if (match) {
        revokeKey(match[0]);
        console.log(`Key revoked for customer ${subscription.customer}`);
      }
    },
  };

  const handler = handlers[event.type];
  if (handler) { return handler(event.data.object); }
  return null;
};

export {
  PLANS,
  loadKeys,
  createKey,
  revokeKey,
  validateKey,
  authMiddleware,
  incrementUsage,
};
