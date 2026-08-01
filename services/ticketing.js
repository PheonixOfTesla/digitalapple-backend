/**
 * ticketing — what Clockwork charges to sell someone else's ticket.
 *
 * 3.7% + $1.79 per ticket, matching Eventbrite's published rate. The room-entry
 * rail next door keeps a flat 10%, which is fine on a $5 door and indefensible
 * on a $50 ticket: it would take $5.00 where Eventbrite takes $3.64. Different
 * product, different rate.
 *
 * WHO ACTUALLY PAYS WHAT
 * These are destination charges: Clockwork is the merchant of record, so
 * Stripe's own processing fee (2.9% + $0.30) comes out of the PLATFORM balance,
 * not the host's. Our margin is therefore application_fee - stripeFee, not the
 * application fee. That distinction is the difference between a business and a
 * slow leak, so platformNet() exists to make it checkable rather than assumed.
 *
 *     $50 ticket → we take $3.64, Stripe takes $1.75, we keep $1.89
 *     $5  ticket → we take $1.97, Stripe takes $0.45, we keep $1.53
 *
 * The flat component means small tickets carry proportionally more, which is
 * how every ticketing platform works and why $1 tickets are not a good idea.
 */

const PERCENT = 0.037;        // 3.7%
const FLAT_CENTS = 179;       // $1.79

// Stripe's standard US card rate, used ONLY to report our true margin. If your
// negotiated rate differs this is the number to change.
const STRIPE_PERCENT = 0.029;
const STRIPE_FLAT_CENTS = 30;

/**
 * The lowest a PAID ticket may be priced, in cents.
 *
 * Below this the flat $1.79 exceeds the ticket itself: the host receives
 * nothing, and Stripe hard-rejects any charge whose application_fee_amount is
 * greater than the amount — so a $1 ticket is not a bad deal, it is a failed
 * checkout. Solved from the rates rather than hardcoded, so it stays correct
 * if PERCENT or FLAT_CENTS ever move.
 *
 * Hosts price in whole units in practice, so the floor is rounded up to the
 * next dollar: a "$1.86 minimum" is a confusing thing to put in a form.
 */
const MIN_PAID_CENTS = (function () {
  let p = 1;
  while (p <= 100000 && Math.round(p * PERCENT) + FLAT_CENTS >= p) p++;
  return Math.ceil(p / 100) * 100;
})();

/**
 * What Clockwork takes from one ticket, in cents.
 *
 * Free tickets are free: a $0 RSVP must not be charged $1.79, and never reaches
 * Stripe at all. Returning 0 is what makes "free event" a real case rather than
 * an accident.
 *
 * The fee is also capped at the price. Callers should reject anything under
 * MIN_PAID_CENTS before getting here, but if one slips through it must not
 * hand Stripe an application fee larger than the charge — that is a hard API
 * error mid-checkout, in front of a buyer.
 */
function serviceFee(priceCents) {
  const p = Math.max(0, Math.round(Number(priceCents) || 0));
  if (p === 0) return 0;
  return Math.min(p, Math.round(p * PERCENT) + FLAT_CENTS);
}

/**
 * Is this a price we can actually sell? Free is fine; anything paid has to
 * clear the floor.
 */
function priceIsSellable(priceCents) {
  const p = Math.max(0, Math.round(Number(priceCents) || 0));
  return p === 0 || p >= MIN_PAID_CENTS;
}

/** What Stripe takes from the platform on a destination charge, in cents. */
function stripeFee(priceCents) {
  const p = Math.max(0, Math.round(Number(priceCents) || 0));
  if (p === 0) return 0;
  return Math.round(p * STRIPE_PERCENT) + STRIPE_FLAT_CENTS;
}

/** What the host receives, in cents. */
function hostPayout(priceCents) {
  const p = Math.max(0, Math.round(Number(priceCents) || 0));
  return Math.max(0, p - serviceFee(p));
}

/**
 * What Clockwork actually keeps after Stripe, in cents. Can go NEGATIVE on a
 * cheap enough ticket, which is exactly why this is worth computing: callers
 * can refuse to sell below the break-even rather than discovering it monthly.
 */
function platformNet(priceCents) {
  return serviceFee(priceCents) - stripeFee(priceCents);
}

/**
 * The lowest SELLABLE price at which we do not lose money after Stripe, in
 * cents — or null if no such price exists. Distinct from MIN_PAID_CENTS, which
 * is about the host receiving something; this is about us.
 */
function breakEvenCents() {
  for (let p = MIN_PAID_CENTS; p <= 1000000; p++) if (platformNet(p) >= 0) return p;
  return null;
}

/** Money for humans: 350 → "$3.50". */
function usd(cents) {
  return '$' + (Math.round(Number(cents) || 0) / 100).toFixed(2);
}

/** The full breakdown, for a checkout summary or an admin row. */
function breakdown(priceCents) {
  const p = Math.max(0, Math.round(Number(priceCents) || 0));
  return {
    priceCents: p,
    serviceFeeCents: serviceFee(p),
    hostPayoutCents: hostPayout(p),
    stripeFeeCents: stripeFee(p),
    platformNetCents: platformNet(p),
    free: p === 0,
    sellable: priceIsSellable(p)
  };
}

module.exports = {
  PERCENT, FLAT_CENTS, STRIPE_PERCENT, STRIPE_FLAT_CENTS,
  MIN_PAID_CENTS,
  serviceFee, stripeFee, hostPayout, platformNet, priceIsSellable,
  breakEvenCents, usd, breakdown
};
