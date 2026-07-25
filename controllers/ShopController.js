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
  'hat-os':  { sku: 'hat-os',  product: 'hat', name: 'Clockwork Dad Hat',      size: 'One size', unitAmount: 2999, syncVariantId: 5413109323 },
  'tee-s':   { sku: 'tee-s',   product: 'tee', name: 'Atlas Nebula Tee — S',   size: 'S',   unitAmount: 3499, syncVariantId: 5412788159 },
  'tee-m':   { sku: 'tee-m',   product: 'tee', name: 'Atlas Nebula Tee — M',   size: 'M',   unitAmount: 3499, syncVariantId: 5412788160 },
  'tee-l':   { sku: 'tee-l',   product: 'tee', name: 'Atlas Nebula Tee — L',   size: 'L',   unitAmount: 3499, syncVariantId: 5412788161 },
  'tee-xl':  { sku: 'tee-xl',  product: 'tee', name: 'Atlas Nebula Tee — XL',  size: 'XL',  unitAmount: 3499, syncVariantId: 5412788162 },
  'tee-2xl': { sku: 'tee-2xl', product: 'tee', name: 'Atlas Nebula Tee — 2XL', size: '2XL', unitAmount: 3699, syncVariantId: 5412788164 }
};

// Tee, crewneck and hoodie each come in 5 designs.
// 1: serif CLOCKWORK, front, centered. 2: lockup, front, centered. 3: lockup, front, far right.
// 4: nebula far right + lockup, front AND back. 5: nebula centered + lockup, front AND back.
const DESIGN_LABELS = {
  1: 'Design 1 — CLOCKWORK serif',
  2: 'Design 2 — Lockup center',
  3: 'Design 3 — Lockup right',
  4: 'Design 4 — Nebula right (front + back)',
  5: 'Design 5 — Nebula center (front + back)'
};
const SWEAT_VARIANTS = {
  crew1: [5413089744, 5413089745, 5413089746, 5413089753, 5413089754],
  crew2: [5413086674, 5413086675, 5413086676, 5413086677, 5413086678],
  crew3: [5413105002, 5413105003, 5413105004, 5413105005, 5413105006],
  crew4: [5413075710, 5413075711, 5413075714, 5413075738, 5413075739],
  crew5: [5413090723, 5413090725, 5413090727, 5413090728, 5413090731],
  hood1: [5413089808, 5413089809, 5413089810, 5413089811, 5413089812],
  hood2: [5413089814, 5413089815, 5413089816, 5413089817, 5413089818],
  hood3: [5413105106, 5413105107, 5413105108, 5413105109, 5413105110],
  hood4: [5413089819, 5413089820, 5413089821, 5413089822, 5413089823],
  hood5: [5413090746, 5413090747, 5413090749, 5413090750, 5413090751],
  tee1: [5413096328, 5413096331, 5413096332, 5413096333, 5413096334],
  tee2: [5413096421, 5413096442, 5413096443, 5413096444, 5413096446],
  tee3: [5413105151, 5413105152, 5413105153, 5413105154, 5413105155],
  tee4: [5413096451, 5413096452, 5413096457, 5413096459, 5413096460],
  tee5: [5413096463, 5413096464, 5413096465, 5413096466, 5413096467]
};
const SIZES = ['S', 'M', 'L', 'XL', '2XL'];
// Designs 1-3 are single-print; 4-5 print front and back (higher cost).
const PRICE = {
  crew: { single: 4499, double: 4999 },
  hood: { single: 5499, double: 5999 },
  tee:  { single: 3499, double: 3999 }
};
const GARMENT_NAMES = { crew: 'Clockwork Crewneck', hood: 'Clockwork Hoodie', tee: 'Clockwork Tee' };
for (const [key, ids] of Object.entries(SWEAT_VARIANTS)) {
  const garment = key.replace(/\d$/, '');
  const design = parseInt(key.slice(-1), 10);
  const base = design >= 4 ? PRICE[garment].double : PRICE[garment].single;
  ids.forEach((syncVariantId, i) => {
    const size = SIZES[i];
    CATALOG[`${key}-${size.toLowerCase()}`] = {
      sku: `${key}-${size.toLowerCase()}`, product: key,
      name: `${GARMENT_NAMES[garment]} D${design} — ${size}`, size,
      unitAmount: size === '2XL' ? base + 200 : base, syncVariantId
    };
  });
}
// Legacy sku aliases (pre-design carts)
for (const s of ['s', 'm', 'l', 'xl', '2xl']) {
  CATALOG['crew-' + s] = CATALOG['crew4-' + s];
  CATALOG['crewword-' + s] = CATALOG['crew2-' + s];
  CATALOG['tee-' + s] = CATALOG['tee5-' + s];
}
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
    tee: 'https://www.theclockworkhub.com/merch/nebula-back.png',
    crew: 'https://www.theclockworkhub.com/merch/sweater-print.png',
    crewword: 'https://www.theclockworkhub.com/merch/crew-wordmark.png'
  };
  const h = pfHeaders();
  if (h) {
    try {
      for (const [key, pid] of [['hat', 451942837]]) {
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
        id: 'tee', name: 'Clockwork Tee', image: images.tee,
        blurb: 'Black staple tee. Five designs — 1–3 single print, 4–5 printed front and back.',
        designs: [1, 2, 3, 4, 5].map(d => ({
          key: 'tee' + d, label: DESIGN_LABELS[d],
          variants: ['s', 'm', 'l', 'xl', '2xl'].map(s => {
            const c = CATALOG[`tee${d}-${s}`];
            return { sku: c.sku, size: c.size, priceCents: c.unitAmount };
          })
        }))
      },
      {
        id: 'crew', name: 'Clockwork Crewneck', image: images.crew,
        blurb: 'Heavyweight black crewneck. Five designs — 1–3 single print, 4–5 printed front and back.',
        designs: [1, 2, 3, 4, 5].map(d => ({
          key: 'crew' + d, label: DESIGN_LABELS[d],
          variants: ['s', 'm', 'l', 'xl', '2xl'].map(s => {
            const c = CATALOG[`crew${d}-${s}`];
            return { sku: c.sku, size: c.size, priceCents: c.unitAmount };
          })
        }))
      },
      {
        id: 'hood', name: 'Clockwork Hoodie', image: images.crew,
        blurb: 'Heavy blend black hoodie, same five designs — for the cold library nights.',
        designs: [1, 2, 3, 4, 5].map(d => ({
          key: 'hood' + d, label: DESIGN_LABELS[d],
          variants: ['s', 'm', 'l', 'xl', '2xl'].map(s => {
            const c = CATALOG[`hood${d}-${s}`];
            return { sku: c.sku, size: c.size, priceCents: c.unitAmount };
          })
        }))
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
    const embedded = req.body.embedded === true;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      ...(embedded
        ? { ui_mode: 'embedded', return_url: `${process.env.FRONTEND_URL}/shop.html?order=return&session_id={CHECKOUT_SESSION_ID}` }
        : { success_url: `${process.env.FRONTEND_URL}/shop.html?order=success`,
            cancel_url: `${process.env.FRONTEND_URL}/shop.html?order=cancelled` }),
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
      }
    });
    if (embedded) return res.json({ success: true, clientSecret: session.client_secret });
    res.json({ success: true, checkoutUrl: session.url });
  } catch (e) {
    console.error('[shop] checkout error:', e.type || '', e.code || '', e.message);
    // Surface only the Stripe error category — never key material or raw messages.
    const msg = String(e.message || '');
    const reason = e.type === 'StripeAuthenticationError' ? 'stripe_key'
      : e.type === 'StripePermissionError' ? 'stripe_permission'
      : /live charges/i.test(msg) ? 'account_not_activated'
      : /Stripe-Account|organization/i.test(msg) ? 'org_key'
      : e.type === 'StripeInvalidRequestError' ? 'stripe_request:' + (e.param || e.code || '')
      : undefined;
    res.status(500).json({ error: 'Could not start checkout', reason });
  }
});

// GET /shop/session?id=cs_... — payment status for the embedded-checkout return page.
// Exposes only status fields, never customer data.
router.get('/session', async (req, res) => {
  try {
    const id = String(req.query.id || '');
    if (!/^cs_(live|test)_[A-Za-z0-9]+$/.test(id)) return res.status(400).json({ error: 'Bad session id' });
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
    const s = await stripe.checkout.sessions.retrieve(id);
    res.json({ success: true, status: s.status, paymentStatus: s.payment_status });
  } catch (e) {
    res.status(500).json({ error: 'Could not check session' });
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
