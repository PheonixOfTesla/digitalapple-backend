/**
 * ShopController — the in-app merch shop (/shop.html).
 *
 * Flow: catalog (server-priced) → Stripe Checkout (collects shipping) →
 * the verified Stripe webhook (TokenController) branches shop sessions
 * here → fulfill() submits the order to Printful, which prints & ships.
 *
 * PRINTFUL_API_KEY lives in Railway env (never in code). Without it the
 * catalog still renders; fulfillment records a draft to retry.
 */
const express = require('express');
const router = express.Router();

const PF_BASE = 'https://api.printful.com';
const PF_STORE = process.env.PRINTFUL_STORE_ID || '18516464';

// Server-side catalog — prices in cents, Printful sync variants for fulfillment.
// Keep in lockstep with the products in the Printful store.
const CATALOG = {
  'hat-os':  { sku: 'hat-os',  product: 'hat', name: 'Clockwork Dad Hat',      size: 'One size', unitAmount: 2999, syncVariantId: 5412788186 },
  'tee-s':   { sku: 'tee-s',   product: 'tee', name: 'Atlas Nebula Tee — S',   size: 'S',   unitAmount: 3499, syncVariantId: 5412788159 },
  'tee-m':   { sku: 'tee-m',   product: 'tee', name: 'Atlas Nebula Tee — M',   size: 'M',   unitAmount: 3499, syncVariantId: 5412788160 },
  'tee-l':   { sku: 'tee-l',   product: 'tee', name: 'Atlas Nebula Tee — L',   size: 'L',   unitAmount: 3499, syncVariantId: 5412788161 },
  'tee-xl':  { sku: 'tee-xl',  product: 'tee', name: 'Atlas Nebula Tee — XL',  size: 'XL',  unitAmount: 3499, syncVariantId: 5412788162 },
  'tee-2xl': { sku: 'tee-2xl', product: 'tee', name: 'Atlas Nebula Tee — 2XL', size: '2XL', unitAmount: 3699, syncVariantId: 5412788164 }
};
const SHIPPING_CENTS = 499;

function pfHeaders() {
  const key = process.env.PRINTFUL_API_KEY;
  if (!key) return null;
  return { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'X-PF-Store-Id': PF_STORE };
}

// Mockup images from Printful (generated per sync variant); cached 10 min.
let mockupCache = { at: 0, images: {} };
async function productImages() {
  if (Date.now() - mockupCache.at < 600e3) return mockupCache.images;
  const images = {
    hat: 'https://www.theclockworkhub.com/merch/clockwork-hat.png',
    tee: 'https://www.theclockworkhub.com/merch/nebula-back.png'
  };
  const h = pfHeaders();
  if (h) {
    try {
      for (const [key, pid] of [['hat', 451894180], ['tee', 451894171]]) {
        const r = await fetch(`${PF_BASE}/store/products/${pid}`, { headers: h });
        if (!r.ok) continue;
        const d = await r.json();
        const v = d.result && d.result.sync_variants && d.result.sync_variants[0];
        const preview = v && (v.files || []).find(f => f.type === 'preview' && f.preview_url);
        if (preview) images[key] = preview.preview_url;
      }
    } catch (e) { /* keep fallbacks */ }
  }
  mockupCache = { at: Date.now(), images };
  return images;
}

// GET /shop/catalog — products, sizes, prices, images
router.get('/catalog', async (req, res) => {
  const images = await productImages();
  res.json({
    success: true,
    shippingCents: SHIPPING_CENTS,
    products: [
      {
        id: 'hat', name: 'Clockwork Dad Hat', image: images.hat,
        blurb: 'Unstructured black cap, flat-embroidered CLOCKWORK serif wordmark.',
        variants: [{ sku: 'hat-os', size: 'One size', priceCents: 2999 }]
      },
      {
        id: 'tee', name: 'Atlas Nebula Tee', image: images.tee,
        blurb: 'Black staple tee, full-back nebula print — the map, worn.',
        variants: ['s', 'm', 'l', 'xl', '2xl'].map(s => {
          const c = CATALOG['tee-' + s];
          return { sku: c.sku, size: c.size, priceCents: c.unitAmount };
        })
      }
    ]
  });
});

// POST /shop/checkout { items: [{sku, quantity}] } — guest checkout allowed
router.post('/checkout', async (req, res) => {
  try {
    const raw = (req.body && req.body.items) || [];
    if (!Array.isArray(raw) || !raw.length) return res.status(400).json({ error: 'Cart is empty' });
    const items = [];
    for (const it of raw.slice(0, 10)) {
      const c = CATALOG[it.sku];
      const qty = Math.max(1, Math.min(10, parseInt(it.quantity, 10) || 1));
      if (!c) return res.status(400).json({ error: `Unknown item: ${it.sku}` });
      items.push({ ...c, quantity: qty });
    }

    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: items.map(i => ({
        price_data: {
          currency: 'usd',
          product_data: { name: i.name },
          unit_amount: i.unitAmount
        },
        quantity: i.quantity
      })),
      shipping_address_collection: { allowed_countries: ['US', 'CA', 'GB', 'AU', 'DE', 'FR', 'NL', 'JP'] },
      shipping_options: [{
        shipping_rate_data: {
          type: 'fixed_amount',
          fixed_amount: { amount: SHIPPING_CENTS, currency: 'usd' },
          display_name: 'Standard (5-8 business days)'
        }
      }],
      metadata: {
        type: 'shop_order',
        cart: JSON.stringify(items.map(i => ({ s: i.sku, q: i.quantity })))
      },
      success_url: `${process.env.FRONTEND_URL}/shop.html?order=success`,
      cancel_url: `${process.env.FRONTEND_URL}/shop.html?order=cancelled`
    });
    res.json({ success: true, checkoutUrl: session.url });
  } catch (e) {
    console.error('[shop] checkout error:', e.type || '', e.code || '', e.message);
    // Surface only the Stripe error category — never key material or raw messages.
    const reason = e.type === 'StripeAuthenticationError' ? 'stripe_key'
      : e.type === 'StripePermissionError' ? 'stripe_permission'
      : e.type === 'StripeInvalidRequestError' ? 'stripe_request'
      : undefined;
    res.status(500).json({ error: 'Could not start checkout', reason });
  }
});

// Called by the verified Stripe webhook (TokenController) for shop sessions.
// Idempotent on stripeSessionId; submits the Printful order (prints + ships).
async function fulfill(session, stripeEventId) {
  const ShopOrder = require('../models/ShopOrder');
  let cart = [];
  try { cart = JSON.parse(session.metadata.cart || '[]'); } catch (e) {}
  const items = cart.map(c => ({ ...CATALOG[c.s], quantity: c.q })).filter(i => i && i.syncVariantId);
  if (!items.length) throw new Error('Empty shop cart in session ' + session.id);

  const ship = session.shipping_details || session.customer_details || {};
  const addr = ship.address || {};
  const recipient = {
    name: ship.name || (session.customer_details && session.customer_details.name) || 'Clockwork Customer',
    address1: addr.line1 || '', address2: addr.line2 || undefined,
    city: addr.city || '', state_code: addr.state || undefined,
    country_code: addr.country || 'US', zip: addr.postal_code || ''
  };

  let order;
  try {
    order = await ShopOrder.create({
      stripeSessionId: session.id, stripeEventId,
      email: (session.customer_details && session.customer_details.email) || null,
      items: items.map(i => ({ sku: i.sku, name: i.name, syncVariantId: i.syncVariantId, quantity: i.quantity, unitAmount: i.unitAmount })),
      amountTotal: session.amount_total || 0,
      recipient, status: 'paid'
    });
  } catch (e) {
    if (e.code === 11000) { console.log('[shop] duplicate session ignored:', session.id); return; }
    throw e;
  }

  const h = pfHeaders();
  if (!h) {
    order.status = 'draft'; order.error = 'PRINTFUL_API_KEY not configured';
    await order.save();
    console.error('[shop] order stored as draft — set PRINTFUL_API_KEY to auto-submit');
    return;
  }
  try {
    const r = await fetch(`${PF_BASE}/orders`, {
      method: 'POST', headers: h,
      body: JSON.stringify({
        external_id: session.id.slice(-32),
        recipient,
        items: items.map(i => ({ sync_variant_id: i.syncVariantId, quantity: i.quantity })),
        confirm: true
      })
    });
    const d = await r.json();
    if (!r.ok || d.code >= 400) throw new Error((d.result && typeof d.result === 'string') ? d.result : `Printful ${r.status}`);
    order.printfulOrderId = d.result && d.result.id;
    order.status = 'submitted';
    await order.save();
    console.log(`[shop] order submitted to Printful: ${order.printfulOrderId}`);
  } catch (e) {
    // Payment is captured — keep the order as a draft to submit manually/retry.
    order.status = 'draft'; order.error = e.message.slice(0, 300);
    await order.save();
    console.error('[shop] Printful submit failed (order kept as draft):', e.message);
  }
}

module.exports = router;
module.exports.fulfill = fulfill;
