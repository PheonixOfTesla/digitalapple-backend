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

// ---- Apparel matrix: garment × color × design × placement × size ----
// One print per garment; the buyer picks color, design, and front or back.
// Fulfilled via Printful CATALOG variant + print file at order time (no sync products).
const MERCH_BASE = 'https://www.theclockworkhub.com/merch';
const DESIGNS = {
  d1: { n: 1, label: 'Design 1 — CLOCKWORK serif', file: `${MERCH_BASE}/crew-serif.png` },
  d2: { n: 2, label: 'Design 2 — Lockup right',    file: `${MERCH_BASE}/lockup-right.png` },
  d3: { n: 3, label: 'Design 3 — Nebula right',    file: `${MERCH_BASE}/sweater-print.png?v=2` },
  d4: { n: 4, label: 'Design 4 — Nebula center',   file: `${MERCH_BASE}/nebula-center.png` }
};
const PLACEMENTS = { f: { label: 'Front print', type: 'default' }, b: { label: 'Back print', type: 'back' } };
const PRINT_POS = {
  crew: { f: { area_width: 1800, area_height: 2400, width: 1800, height: 2400, top: 0, left: 0 },
          b: { area_width: 1800, area_height: 2400, width: 1800, height: 2400, top: 0, left: 0 } },
  hood: { f: { area_width: 2100, area_height: 2100, width: 1575, height: 2100, top: 0, left: 262 },
          b: { area_width: 1800, area_height: 2400, width: 1800, height: 2400, top: 0, left: 0 } },
  tee:  { f: { area_width: 3600, area_height: 4800, width: 3600, height: 4800, top: 0, left: 0 },
          b: { area_width: 3600, area_height: 4800, width: 3600, height: 4800, top: 0, left: 0 } }
};
const APPAREL = {
  crew: { name: 'Clockwork Crewneck', single: 4499, colors: {
    blk: { label: 'Black',        variants: { s: 5434, m: 5435, l: 5436, xl: 5437, '2xl': 5438 } },
    nvy: { label: 'Navy',         variants: { s: 5498, m: 5499, l: 5500, xl: 5501, '2xl': 5502 } },
    hth: { label: 'Dark Heather', variants: { s: 10833, m: 10834, l: 10835, xl: 10836, '2xl': 10837 } }
  } },
  hood: { name: 'Clockwork Hoodie', single: 5499, colors: {
    blk: { label: 'Black',        variants: { s: 5530, m: 5531, l: 5532, xl: 5533, '2xl': 5534 } },
    nvy: { label: 'Navy',         variants: { s: 5594, m: 5595, l: 5596, xl: 5597, '2xl': 5598 } },
    hth: { label: 'Dark Heather', variants: { s: 10806, m: 10807, l: 10808, xl: 10809, '2xl': 10810 } }
  } },
  tee: { name: 'Clockwork Tee', single: 3499, colors: {
    blk: { label: 'Black',             variants: { s: 4016, m: 4017, l: 4018, xl: 4019, '2xl': 4020 } },
    nvy: { label: 'Navy',              variants: { s: 4111, m: 4112, l: 4113, xl: 4114, '2xl': 4115 } },
    hth: { label: 'Dark Grey Heather', variants: { s: 8460, m: 8461, l: 8462, xl: 8463, '2xl': 8464 } }
  } }
};
for (const [g, garment] of Object.entries(APPAREL)) {
  for (const [ck, color] of Object.entries(garment.colors)) {
    for (const [dk, design] of Object.entries(DESIGNS)) {
      for (const [pk, place] of Object.entries(PLACEMENTS)) {
        for (const [sz, catalogVariantId] of Object.entries(color.variants)) {
          const SIZE = sz.toUpperCase();
          const sku = `${g}-${ck}-${dk}-${pk}-${sz}`;
          CATALOG[sku] = {
            sku, product: g,
            name: `${garment.name} · ${color.label} · D${design.n} ${place.label} — ${SIZE}`,
            size: SIZE,
            unitAmount: sz === '2xl' ? garment.single + 200 : garment.single,
            catalogVariantId,
            file: { type: place.type, url: design.file, position: { ...PRINT_POS[g][pk] } }
          };
        }
      }
    }
  }
}
// Legacy sku aliases (older carts / stale pages) — map to black equivalents.
const LEGACY_DESIGN = { 1: 'd1', 2: 'd2', 3: 'd2', 4: 'd3', 5: 'd4' };
for (const s of ['s', 'm', 'l', 'xl', '2xl']) {
  for (const g of ['crew', 'hood', 'tee']) {
    for (let d = 1; d <= 5; d++) CATALOG[`${g}${d}-${s}`] = CATALOG[`${g}-blk-${LEGACY_DESIGN[d]}-f-${s}`];
  }
  CATALOG['crew-' + s] = CATALOG[`crew-blk-d3-f-${s}`];
  CATALOG['crewword-' + s] = CATALOG[`crew-blk-d2-f-${s}`];
  CATALOG['tee-' + s] = CATALOG[`tee-blk-d4-f-${s}`];
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
      ...['tee', 'crew', 'hood'].map(g => ({
        id: g, name: APPAREL[g].name, image: images.crew,
        blurb: g === 'tee' ? 'Staple tee. Pick a color, pick a design, front or back.'
             : g === 'crew' ? 'Heavyweight crewneck. Pick a color, pick a design, front or back.'
             : 'Heavy blend hoodie. Same designs, built for the cold library nights.',
        colors: Object.entries(APPAREL[g].colors).map(([k, c]) => ({ key: k, label: c.label })),
        designs: Object.entries(DESIGNS).map(([k, d]) => ({ key: k, label: d.label })),
        placements: Object.entries(PLACEMENTS).map(([k, p]) => ({ key: k, label: p.label })),
        sizes: ['s', 'm', 'l', 'xl', '2xl'].map(s => ({
          key: s, label: s.toUpperCase(),
          priceCents: s === '2xl' ? APPAREL[g].single + 200 : APPAREL[g].single
        }))
      }))
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
  const items = cart.map(c => ({ ...CATALOG[c.s], quantity: c.q }))
    .filter(i => i && (i.syncVariantId || i.catalogVariantId));
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
      items: items.map(i => ({ sku: i.sku, name: i.name, syncVariantId: i.syncVariantId || i.catalogVariantId, quantity: i.quantity, unitAmount: i.unitAmount })),
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
        items: items.map(i => i.syncVariantId
          ? { sync_variant_id: i.syncVariantId, quantity: i.quantity }
          : { variant_id: i.catalogVariantId, quantity: i.quantity, files: [{ ...i.file }] }),
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
