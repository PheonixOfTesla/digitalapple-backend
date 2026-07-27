/**
 * healthChecks — one place that knows whether each subsystem is actually working.
 *
 * Status vocabulary:
 *   'up'    — configured and responding
 *   'down'  — configured/expected but failing  → RED, alerts admins
 *   'degraded' — working but missing something (e.g. Stripe live but a dependent
 *                 var absent) → AMBER
 *   'off'   — intentionally not configured yet  → GREY, not an alarm
 *
 * Only 'down' triggers admin notifications — an unconfigured integration isn't an
 * outage. Real pings where cheap (Mongo, Stripe); config-presence otherwise so a
 * status check never burns API tokens.
 */
const mongoose = require('mongoose');

function present(v) { return !!(v && String(v).trim()); }

async function checkDatabase() {
  const s = mongoose.connection.readyState; // 1 = connected
  return s === 1
    ? { status: 'up', detail: 'connected' }
    : { status: 'down', detail: 'not connected (readyState ' + s + ')' };
}

async function checkStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!present(key)) return { status: 'off', detail: 'no key' };
  const mode = key.startsWith('sk_live') ? 'live' : (key.startsWith('sk_test') ? 'test' : 'unknown');
  try {
    const Stripe = require('stripe');
    const stripe = new Stripe(key, { apiVersion: '2023-10-16', timeout: 8000, maxNetworkRetries: 0 });
    await stripe.balance.retrieve();
    const webhook = present(process.env.STRIPE_WEBHOOK_SECRET);
    return { status: webhook ? 'up' : 'degraded', mode, detail: webhook ? mode + ' mode' : mode + ' mode · webhook secret missing' };
  } catch (e) {
    return { status: 'down', mode, detail: (e.type || 'error') + ': ' + (e.message || '').slice(0, 80) };
  }
}

function checkAI() {
  const provider = process.env.AI_PROVIDER || 'openai';
  const key = process.env.OPENAI_API_KEY || process.env.MOONSHOT_API_KEY;
  return present(key)
    ? { status: 'up', detail: provider + ' key set' }
    : { status: 'down', detail: 'no AI key — blueprint generation will fail' };
}

function checkCloudinary() {
  const ok = present(process.env.CLOUDINARY_URL) ||
    (present(process.env.CLOUDINARY_CLOUD_NAME) && present(process.env.CLOUDINARY_API_KEY) && present(process.env.CLOUDINARY_API_SECRET));
  return ok
    ? { status: 'up', detail: 'configured' }
    : { status: 'off', detail: 'not set — photo/avatar uploads disabled' };
}

function checkEmail() {
  const ok = present(process.env.SMTP_HOST) && present(process.env.SMTP_USER);
  return ok
    ? { status: 'up', detail: 'SMTP configured' }
    : { status: 'off', detail: 'not set — password-reset emails disabled' };
}

function checkPrintful() {
  const key = present(process.env.PRINTFUL_API_KEY);
  if (!key) return { status: 'off', detail: 'not set — merch fulfillment disabled' };
  const store = present(process.env.PRINTFUL_STORE_ID);
  return store
    ? { status: 'up', detail: 'key + store set' }
    : { status: 'degraded', detail: 'key set, PRINTFUL_STORE_ID missing — orders may not route' };
}

function checkScheduling() {
  return present(process.env.CAL_API_KEY)
    ? { status: 'up', detail: 'Cal.com key set' }
    : { status: 'off', detail: 'not set — scheduling disabled' };
}

/**
 * Run every check. Returns { checkedAt, overall, checks: {name: {status, detail,...}} }.
 * overall = 'down' if any critical is down, else 'degraded' if any degraded, else 'up'.
 */
async function runHealthChecks() {
  const [database, stripe] = await Promise.all([checkDatabase(), checkStripe()]);
  const checks = {
    database,
    payments: stripe,
    ai: checkAI(),
    uploads: checkCloudinary(),
    email: checkEmail(),
    merch: checkPrintful(),
    scheduling: checkScheduling()
  };
  const statuses = Object.values(checks).map(c => c.status);
  const overall = statuses.includes('down') ? 'down'
    : statuses.includes('degraded') ? 'degraded' : 'up';
  return { checkedAt: new Date().toISOString(), overall, checks };
}

module.exports = { runHealthChecks };
