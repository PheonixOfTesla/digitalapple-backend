/**
 * Printful preflight — prove the shop can actually fulfil an order, BEFORE a
 * customer proves it can't.
 *
 * Also prints your store ID, which is the thing PRINTFUL_STORE_ID needs and is
 * otherwise buried in a dashboard URL.
 *
 * WHY THIS EXISTS
 * Fulfillment is built from values kept in lockstep by hand: catalog variant
 * IDs and print-file URLs in ShopController's CATALOG. Nothing enforces that.
 * When one goes stale the failure lands AFTER Stripe has captured payment — the
 * order is marked draft and the customer waits for a parcel nobody ordered.
 *
 * Checks:
 *   1. Print files resolve (no key needed). These are hosted on our own domain
 *      and Printful fetches them at order time; a 404 fails the order.
 *   2. Every catalog variant ID still exists, and is in stock (no key needed —
 *      Printful's product catalog is public).
 *   3. Prices cover Printful's cost, so no SKU sells at a loss.
 *   4. With PRINTFUL_API_KEY set: the key works, your store ID is printed, and
 *      PRINTFUL_STORE_ID is checked against the stores the key can see.
 *
 * Usage:
 *   node scripts/checkPrintful.js                    # 1-3, no credentials
 *   PRINTFUL_API_KEY=… node scripts/checkPrintful.js # all four
 *
 * Exit 0 = safe to sell.
 */

require('dotenv').config();

const PF = 'https://api.printful.com';
const KEY = process.env.PRINTFUL_API_KEY;
const STORE = process.env.PRINTFUL_STORE_ID;

let problems = 0;
const fail = (m) => { problems++; console.log('  FAIL  ' + m); };
const pass = (m) => console.log('  ok    ' + m);
const money = (c) => '$' + (Number(c || 0) / 100).toFixed(2);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Printful rate-limits (~120 requests/minute) and answers 429 when you cross
 * it. A 429 is US being impatient, not a broken variant — reporting it as
 * "this SKU will fail at checkout" is a false alarm that would send someone
 * rebuilding a catalog that was fine. Pace the calls, and retry a 429 with
 * backoff before believing it.
 */
async function getJson(url, headers, attempt = 0) {
  const r = await fetch(url, headers ? { headers } : undefined);
  if (r.status === 429 && attempt < 4) {
    const wait = Number(r.headers.get('retry-after') || 0) * 1000 || (1500 * Math.pow(2, attempt));
    await sleep(wait);
    return getJson(url, headers, attempt + 1);
  }
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok && (body.code === undefined || body.code < 400), status: r.status, body };
}

(async () => {
  const { CATALOG } = require('../controllers/ShopController');
  const skus = Object.values(CATALOG || {});
  if (!skus.length) { console.log('CATALOG is empty — nothing to check.'); process.exit(1); }

  // ── 1. Print files ───────────────────────────────────────────────────────
  // Printful fetches these from our domain when the order is placed. If one
  // 404s the order is rejected and the payment is already taken.
  const files = [...new Set(skus.map(s => s.file && s.file.url).filter(Boolean))];
  console.log(`\nPrint files (${files.length})`);
  for (const url of files) {
    try {
      const r = await fetch(url, { redirect: 'follow' });
      const type = r.headers.get('content-type') || '';
      if (!r.ok) fail(`${url} → ${r.status}. Every order using this design will be rejected.`);
      else if (!/^image\//.test(type)) fail(`${url} → served as "${type}", not an image.`);
      else pass(`${url.split('/').pop()} → ${r.status} ${type}`);
    } catch (e) { fail(`${url} → unreachable (${e.message})`); }
  }

  // ── 2 + 3. Catalog variants and margins ──────────────────────────────────
  // Printful's product catalog is public, so this runs with no credentials.
  const byVariant = new Map();
  for (const s of skus) if (s.catalogVariantId) {
    if (!byVariant.has(s.catalogVariantId)) byVariant.set(s.catalogVariantId, []);
    byVariant.get(s.catalogVariantId).push(s);
  }
  console.log(`\nCatalog variants (${byVariant.size} distinct, ${skus.length} SKUs)`);
  let oos = 0, thin = 0;
  for (const [vid, group] of byVariant) {
    await sleep(550);                       // stay under Printful's ~120/min
    const r = await getJson(`${PF}/products/variant/${vid}`);
    const v = r.ok && r.body.result && r.body.result.variant;
    if (!v) {
      // Still 429 after four backoffs means rate limiting, not a dead variant.
      // Say which it is rather than blaming the catalog.
      if (r.status === 429) { console.log(`  WARN  variant ${vid} → still rate-limited; re-run to verify (not a catalog fault)`); continue; }
      fail(`variant ${vid} → ${r.status}. ${group.length} SKU(s) take payment then fail: ${group.slice(0, 3).map(g => g.sku).join(', ')}`);
      continue;
    }
    if (v.in_stock === false) { oos++; console.log(`  WARN  ${String(vid).padEnd(7)} ${v.name} — OUT OF STOCK (${group.length} SKU[s] still buyable)`); }
    const cost = Math.round(parseFloat(v.price || 0) * 100);
    const cheapest = Math.min(...group.map(g => g.unitAmount || 0));
    if (cost > 0 && cheapest > 0 && cheapest <= cost) {
      fail(`${String(vid).padEnd(7)} ${v.name} — you charge ${money(cheapest)}, Printful costs ${money(cost)} (before shipping). Loss on every sale.`);
    } else if (cost > 0 && cheapest - cost < 500) {
      thin++;
    }
  }
  if (!problems) pass(`all ${byVariant.size} variants resolve`);
  if (oos) console.log(`  note  ${oos} variant(s) out of stock — Printful may reject or delay those.`);
  if (thin) console.log(`  note  ${thin} variant(s) have under $5.00 margin before shipping.`);

  // ── 4. Key and store ─────────────────────────────────────────────────────
  console.log('\nAccount');
  if (!KEY) {
    console.log('  skip  PRINTFUL_API_KEY not set — cannot read your store ID.');
    console.log('        Run again with: PRINTFUL_API_KEY=… node scripts/checkPrintful.js');
  } else {
    const s = await getJson(`${PF}/stores`, { Authorization: `Bearer ${KEY}` });
    if (!s.ok) {
      fail(`/stores → ${s.status}. The key is rejected: ${JSON.stringify(s.body).slice(0, 140)}`);
    } else {
      const list = s.body.result || [];
      console.log(`\n  YOUR STORE ID${list.length > 1 ? 'S' : ''}:`);
      for (const st of list) console.log(`     ${st.id}   ${st.name}   (${st.type || 'store'})`);
      console.log('');

      // /stores returns what the token can SEE, which is how you tell the two
      // token kinds apart: a store-scoped token sees exactly one store and
      // needs no X-PF-Store-Id; an account-level token sees several and REQUIRES
      // the header. Guessing wrong is the difference between orders going
      // through and orders going nowhere.
      if (list.length === 1 && !STORE) {
        pass(`store-scoped token — it sees only "${list[0].name}", so X-PF-Store-Id is not needed. Leaving PRINTFUL_STORE_ID unset is correct.`);
      } else if (!STORE && list.length > 1) {
        fail(`this token can see ${list.length} stores, so it is account-level and X-PF-Store-Id is REQUIRED. Set PRINTFUL_STORE_ID to the one you sell from.`);
      } else if (STORE && !list.some(st => String(st.id) === String(STORE))) {
        fail(`PRINTFUL_STORE_ID=${STORE} is not a store this token can see. Orders would go somewhere you cannot watch.`);
      } else if (STORE) {
        pass(`PRINTFUL_STORE_ID=${STORE} matches "${list.find(st => String(st.id) === String(STORE)).name}"`);
      }

      // Scopes. Fulfillment posts to /orders, so a token without the `orders`
      // scope authenticates fine and then refuses the one call that matters —
      // after Stripe has already taken the money.
      const sc = await getJson(`${PF}/oauth/scopes`, { Authorization: `Bearer ${KEY}` });
      if (!sc.ok) {
        console.log(`  note  /oauth/scopes → ${sc.status}; could not read this token's scopes.`);
      } else {
        const scopes = (sc.body.result && sc.body.result.scopes) || [];
        console.log(`  note  scopes: ${scopes.join(', ') || '(none reported)'}`);
        if (scopes.length && !scopes.some(x => x === 'orders')) {
          fail('this token lacks the `orders` scope — it can read the catalog but CANNOT submit orders. ' +
               'Every sale would be charged and then fail at fulfillment. Recreate the token at ' +
               'developers.printful.com with the `orders` scope.');
        } else if (scopes.includes('orders')) {
          pass('`orders` scope present — the token can submit fulfillment');
        }
      }

      // Private tokens expire and cannot be refreshed. When one lapses, every
      // paid order becomes a silent draft, so it is worth saying out loud.
      console.log('  note  Printful private tokens EXPIRE and cannot be refreshed. Diarise a rotation; ' +
                  'an expired token turns every paid order into an unfulfilled draft.');
    }
  }

  console.log(problems
    ? `\n${problems} problem(s) — each one is a captured payment with no parcel.\n`
    : '\nAll clear.\n');
  process.exit(problems ? 1 : 0);
})().catch(e => { console.error('preflight crashed:', e.message); process.exit(1); });
