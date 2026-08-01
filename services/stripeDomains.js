/**
 * Apple Pay / Google Pay need our domain registered with Stripe — but only for
 * payment UI that renders on OUR pages.
 *
 * Hosted Checkout runs on checkout.stripe.com, which Stripe has already
 * registered with Apple, so wallets appear there with nothing from us. The
 * moment a payment sheet is embedded in theclockworkhub.com, Apple requires
 * that domain to be registered too — and if it is not, Apple Pay silently does
 * not appear. No error, no warning, just a sheet with fewer buttons than it
 * should have, which is the hardest kind of bug to notice.
 *
 * Registering is idempotent and cheap, so it runs once per process on the first
 * embedded checkout rather than being a deploy step somebody has to remember.
 */
let ensured = false;

const DOMAINS = ['www.theclockworkhub.com', 'theclockworkhub.com'];

async function ensurePaymentDomains(stripe) {
  if (ensured) return;
  ensured = true;
  for (const domain_name of DOMAINS) {
    try {
      const existing = await stripe.paymentMethodDomains.list({ domain_name, limit: 1 });
      if (!existing.data.length) {
        await stripe.paymentMethodDomains.create({ domain_name });
        console.log('[stripe] payment method domain registered:', domain_name);
      }
    } catch (e) {
      // Not fatal: cards still work, wallets just will not show. Loud in the
      // log because "Apple Pay is missing" has no other symptom.
      console.error('[stripe] payment domain registration failed:', domain_name, e.message);
    }
  }
}

/** Test seam — lets a suite re-run the registration. */
function _reset() { ensured = false; }

module.exports = { ensurePaymentDomains, DOMAINS, _reset };
