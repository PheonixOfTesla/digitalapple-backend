/**
 * ticketing — what Clockwork charges to sell someone else's ticket.
 *
 * THE RATE
 *   Tickets are free, or $5.00 and up. Nothing in between.
 *   $5.00 – $50.00   →  a flat $1.79
 *   above $50.00     →  $1.79 + 3%
 *
 * A flat fee under $50 is the point of the model: on a $10 ticket Eventbrite
 * takes $2.16 and we take $1.79, and the fee does not scale with a price the
 * host chose. Above $50 the flat fee stops covering the card cost, so 3% joins
 * it — still under Eventbrite's 3.7%.
 *
 * WHO ACTUALLY PAYS WHAT
 * These are destination charges: Clockwork is merchant of record, so Stripe's
 * 2.9% + $0.30 comes out of the PLATFORM balance, not the host's. Our margin is
 * serviceFee - stripeFee, and stripeFee is charged on the TOTAL the card is
 * billed — price plus our fee — not on the host's price alone. Getting that
 * second part wrong understates Stripe's cut on every sale, so platformNet() is
 * computed and tested rather than assumed.
 *
 *     $10 ticket  → we take $1.79, Stripe takes $0.64, we keep $1.15
 *     $50 ticket  → we take $1.79, Stripe takes $1.80, we keep -$0.01
 *     $100 ticket → we take $4.79, Stripe takes $3.34, we keep $1.45
 *
 * THAT MINUS ONE CENT IS REAL. Between $49.77 and $50.00 the flat fee lands a
 * penny short of Stripe's cut. It is a 24-cent-wide band costing at most 1c a
 * ticket, and closing it would mean telling hosts the rate changes at $49.77 —
 * a worse trade than the penny. lossBands() reports it rather than hiding it,
 * so it stays a known cost instead of a surprise.
 *
 * The margin is also thin by design below $50: at $40 we keep $0.28, at $49 we
 * keep $0.02. That is the flat fee doing what a flat fee does. Volume under $50
 * is close to break-even for the platform and cheap for the host, which is the
 * trade this rate card is making.
 */

const FLAT_CENTS = 179;           // $1.79 on every paid ticket
const PERCENT = 0.03;             // 3%, on top, above the threshold
const PERCENT_ABOVE_CENTS = 5000; // "more than $50"

// Stripe's standard US card rate. If yours is negotiated this is the only
// place to change it.
const STRIPE_PERCENT = 0.029;
const STRIPE_FLAT_CENTS = 30;

/**
 * The lowest a PAID ticket may be priced, in cents.
 *
 * $5.00 is a product decision: below it the flat fee is a third of the ticket
 * and the host is better off making it free. It is also floored by the maths —
 * if the rates ever moved so that $5 could not cover the flat fee, the derived
 * floor wins, and this can never silently become a price we cannot charge.
 */
const POLICY_MIN_CENTS = 500;
const DERIVED_MIN_CENTS = (function () {
  let p = 1;                                     // first price the host nets > 0
  while (p <= 100000 && FLAT_CENTS >= p) p++;
  return Math.ceil(p / 100) * 100;
})();
const MIN_PAID_CENTS = Math.max(POLICY_MIN_CENTS, DERIVED_MIN_CENTS);

/**
 * What Clockwork takes from one ticket, in cents.
 *
 * Free tickets are free: a $0 RSVP is never charged $1.79 and never reaches
 * Stripe. The fee is capped at the price too — callers reject anything under
 * MIN_PAID_CENTS first, but if one slips through it must not hand Stripe an
 * application fee larger than the charge, which is a hard API error in front of
 * a buyer mid-checkout.
 */
function serviceFee(priceCents) {
  const p = Math.max(0, Math.round(Number(priceCents) || 0));
  if (p === 0) return 0;
  const fee = p > PERCENT_ABOVE_CENTS
    ? FLAT_CENTS + Math.round(p * PERCENT)
    : FLAT_CENTS;
  return Math.min(p, fee);
}

/** Is this a price we can actually sell? Free is fine; paid clears the floor. */
function priceIsSellable(priceCents) {
  const p = Math.max(0, Math.round(Number(priceCents) || 0));
  return p === 0 || p >= MIN_PAID_CENTS;
}

/**
 * What Stripe takes from the platform, in cents — on the TOTAL the card is
 * charged, because that is the amount Stripe processes.
 */
function stripeFee(priceCents) {
  const p = Math.max(0, Math.round(Number(priceCents) || 0));
  if (p === 0) return 0;
  return Math.round((p + serviceFee(p)) * STRIPE_PERCENT) + STRIPE_FLAT_CENTS;
}

/** What the buyer's card is charged: the host's price, plus our fee on top. */
function buyerTotal(priceCents) {
  const p = Math.max(0, Math.round(Number(priceCents) || 0));
  return p + serviceFee(p);
}

/** What the host receives: exactly the price they set. */
function hostPayout(priceCents) {
  const p = Math.max(0, Math.round(Number(priceCents) || 0));
  return Math.max(0, p - serviceFee(p));
}

/** What Clockwork keeps after Stripe. Can go negative — see the note above. */
function platformNet(priceCents) {
  return serviceFee(priceCents) - stripeFee(priceCents);
}

/**
 * Every sellable price at which we lose money, as {from, to} bands in cents.
 * Empty when there are none. The honest version of "are we profitable": it
 * reports the shape of the whole rate card instead of spot-checking a price.
 */
function lossBands(maxCents = 100000) {
  const bands = [];
  let open = null;
  for (let p = MIN_PAID_CENTS; p <= maxCents; p++) {
    if (platformNet(p) < 0) { if (open === null) open = p; }
    else if (open !== null) { bands.push({ from: open, to: p - 1 }); open = null; }
  }
  if (open !== null) bands.push({ from: open, to: maxCents });
  return bands;
}

/** Money for humans: 350 → "$3.50". */
function usd(cents) {
  return '$' + (Math.round(Number(cents) || 0) / 100).toFixed(2);
}

/** How the rate reads to a host, so one sentence owns the wording. */
function rateSummary() {
  return `${usd(FLAT_CENTS)} a ticket, plus ${(PERCENT * 100).toFixed(0)}% above ${usd(PERCENT_ABOVE_CENTS)}. `
    + `Free events cost nothing. Paid tickets start at ${usd(MIN_PAID_CENTS)}.`;
}

/** The full breakdown, for a checkout summary or an admin row. */
function breakdown(priceCents) {
  const p = Math.max(0, Math.round(Number(priceCents) || 0));
  return {
    priceCents: p,
    serviceFeeCents: serviceFee(p),
    buyerTotalCents: buyerTotal(p),
    hostPayoutCents: hostPayout(p),
    stripeFeeCents: stripeFee(p),
    platformNetCents: platformNet(p),
    free: p === 0,
    sellable: priceIsSellable(p)
  };
}

module.exports = {
  PERCENT, FLAT_CENTS, PERCENT_ABOVE_CENTS, STRIPE_PERCENT, STRIPE_FLAT_CENTS,
  MIN_PAID_CENTS,
  serviceFee, stripeFee, buyerTotal, hostPayout, platformNet, priceIsSellable,
  lossBands, usd, rateSummary, breakdown
};
