/**
 * BarberShop — one barber's shop on the platform: who it is, when it is open,
 * what it cuts, and where its money goes.
 *
 * A shop IS its @handle. `@crispincuts` in a bio is the whole product: it
 * resolves to a booking page, and the page books against this document. The
 * first shop is seeded on boot so the platform is never a blank page.
 *
 * Money runs on Stripe Connect. The client pays once; Stripe splits it — the
 * barber's connected account receives the cut, the platform keeps
 * `platformFeeBps` of it as an application fee. The rate lives here, per shop,
 * because the platform owner sets it per shop and can change it without a
 * deploy.
 *
 * Hours are wall-clock minutes from local midnight, in the shop's own timezone.
 * Storing 9:00am as 540 rather than as a Date means a booking made in June and
 * a booking made in December both open the doors at nine, without anyone having
 * to think about daylight saving.
 */
const mongoose = require('mongoose');

const HANDLE = (process.env.BARBER_HANDLE || 'crispincuts').replace(/^@/, '').toLowerCase();

const serviceSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String, default: '', trim: true },
  durationMin: { type: Number, default: 30, min: 5, max: 480 },
  priceCents: { type: Number, default: 3500, min: 0 },
  active: { type: Boolean, default: true }
}, { _id: true });

// One row per weekday. `closed` beats the times, so a shop can keep its Sunday
// hours on file while still being shut on Sundays.
const hoursSchema = new mongoose.Schema({
  day: { type: Number, min: 0, max: 6, required: true },   // 0 = Sunday
  open: { type: Number, default: 9 * 60 },                 // minutes from local midnight
  close: { type: Number, default: 18 * 60 },
  closed: { type: Boolean, default: false }
}, { _id: false });

const barberShopSchema = new mongoose.Schema({
  handle: { type: String, required: true, unique: true, lowercase: true, trim: true },
  active: { type: Boolean, default: true },
  name: { type: String, default: 'Crispin Cuts' },
  tagline: { type: String, default: 'Classic cuts. Sharp finish. By appointment.' },
  address: { type: String, default: '' },
  phone: { type: String, default: '' },
  barberEmail: { type: String, default: '' },              // where the day sheet lands

  // Who runs this shop. A normal account on this platform with role 'barber' —
  // the shop has no login of its own, because a second password store is a
  // second thing to reset, leak and forget.
  ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

  // Connect + the platform's cut. bps so 5% is 500 and nobody stores 0.05 as a
  // float. Capped on write, not just in the UI — a 100% take rate is a bug
  // that empties a barber's till.
  stripeAccountId: { type: String, default: null },
  platformFeeBps: { type: Number, default: Number(process.env.BARBER_PLATFORM_FEE_BPS || 300), min: 0, max: 3000 },
  timezone: { type: String, default: 'America/New_York' },
  services: { type: [serviceSchema], default: undefined },
  hours: { type: [hoursSchema], default: undefined },
  slotStepMin: { type: Number, default: 15 },              // how finely the grid is cut
  leadMinutes: { type: Number, default: 60 },              // no booking inside the next hour
  horizonDays: { type: Number, default: 45 },              // how far ahead the calendar runs
  depositCents: { type: Number, default: 0 },              // 0 = pay in the chair
  closures: { type: [String], default: [] },               // 'YYYY-MM-DD' days off
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const DEFAULT_SERVICES = [
  { name: 'Signature Cut', description: 'Consultation, cut, hot towel, finish.', durationMin: 45, priceCents: 4500 },
  { name: 'Skin Fade', description: 'Clipper work taken down to the skin, blended by hand.', durationMin: 45, priceCents: 5000 },
  { name: 'Beard Trim & Line-Up', description: 'Shaped, edged and oiled.', durationMin: 20, priceCents: 2000 },
  { name: 'Cut & Beard', description: 'The full service — cut, beard, hot towel.', durationMin: 60, priceCents: 6500 },
  { name: 'Kids Cut (under 12)', description: 'Same care, smaller chair.', durationMin: 30, priceCents: 2500 }
];

// Tue–Fri 9–6, Saturday 8–4, Monday short, Sunday shut. A real week, so the
// first person to open the page sees a calendar with days in it.
const DEFAULT_HOURS = [
  { day: 0, open: 10 * 60, close: 15 * 60, closed: true },
  { day: 1, open: 10 * 60, close: 17 * 60, closed: false },
  { day: 2, open: 9 * 60, close: 18 * 60, closed: false },
  { day: 3, open: 9 * 60, close: 18 * 60, closed: false },
  { day: 4, open: 9 * 60, close: 18 * 60, closed: false },
  { day: 5, open: 9 * 60, close: 19 * 60, closed: false },
  { day: 6, open: 8 * 60, close: 16 * 60, closed: false }
];

/**
 * The shop, seeded on first call. Concurrent boots can both miss and both
 * insert, so a duplicate-key race falls back to reading the winner's document
 * rather than throwing on a request that only wanted to list services.
 */
barberShopSchema.statics.load = async function (handle) {
  const h = String(handle || HANDLE).replace(/^@/, '').toLowerCase();
  let shop = await this.findOne({ handle: h });
  if (shop) return shop;
  try {
    // Seeded with no owner: an admin assigns one from the platform panel. A
    // shop nobody owns still shows its menu and still takes bookings.
    shop = await this.create({
      handle: h,
      barberEmail: process.env.BARBER_EMAIL || process.env.FROM_EMAIL || '',
      timezone: process.env.BARBER_TZ || 'America/New_York',
      services: DEFAULT_SERVICES,
      hours: DEFAULT_HOURS
    });
    return shop;
  } catch (e) {
    if (e.code === 11000) return this.findOne({ handle: h });
    throw e;
  }
};

/**
 * What Stripe charges to process a card, so the split can account for it.
 *
 * These are Stripe's published US card rates, not something we control, and
 * they are env-overridable because a platform on different pricing should not
 * have to redeploy code to tell the truth about its own numbers.
 */
const STRIPE_PCT_BPS = Number(process.env.STRIPE_PCT_BPS || 290);     // 2.9%
const STRIPE_FIXED_CENTS = Number(process.env.STRIPE_FIXED_CENTS || 30);

/** The platform's cut of an amount, in cents. Never more than the amount. */
barberShopSchema.methods.feeOn = function (amountCents) {
  const amt = Math.max(0, Math.round(Number(amountCents) || 0));
  const bps = Math.min(3000, Math.max(0, Number(this.platformFeeBps) || 0));
  return Math.min(amt, Math.round(amt * bps / 10000));
};

/**
 * Where every cent of a charge goes.
 *
 * The charge is created on the PLATFORM account, which means Stripe's
 * processing fee comes out of the platform's balance — so if the application
 * fee were only the platform's percentage, the platform would be paying
 * Stripe out of it. At 3% that is a loss on every realistic haircut: a $45 cut
 * costs $1.61 to process and earns $1.35, so the platform is 26 cents down for
 * the privilege. Break-even would need a $300 haircut.
 *
 * So the application fee is the platform's percentage PLUS what Stripe takes,
 * and the platform nets its rate cleanly. The barber's payout carries the
 * processing cost, which is the normal arrangement everywhere cards are taken,
 * and both numbers are shown to him separately rather than blended into one
 * figure he cannot check.
 */
barberShopSchema.methods.splitOn = function (amountCents) {
  const amount = Math.max(0, Math.round(Number(amountCents) || 0));
  const platform = this.feeOn(amount);
  const processing = Math.min(amount, Math.round(amount * STRIPE_PCT_BPS / 10000) + STRIPE_FIXED_CENTS);
  // Never let the two together exceed the charge: a tiny amount would other-
  // wise produce a transfer of less than nothing, which Stripe rejects.
  const applicationFee = Math.min(amount, platform + processing);
  return {
    amountCents: amount,
    platformCents: platform,
    processingCents: Math.min(processing, applicationFee),
    applicationFeeCents: applicationFee,
    barberCents: amount - applicationFee
  };
};

/** What the page and the panel are allowed to know. */
barberShopSchema.methods.toPublic = function () {
  return {
    handle: this.handle,
    name: this.name,
    tagline: this.tagline,
    address: this.address,
    phone: this.phone,
    timezone: this.timezone,
    slotStepMin: this.slotStepMin,
    leadMinutes: this.leadMinutes,
    horizonDays: this.horizonDays,
    depositCents: this.depositCents,
    active: this.active,
    services: (this.services || []).filter(s => s.active).map(s => ({
      id: String(s._id), name: s.name, description: s.description,
      durationMin: s.durationMin, priceCents: s.priceCents
    })),
    hours: (this.hours || []).map(h => ({ day: h.day, open: h.open, close: h.close, closed: h.closed }))
  };
};

barberShopSchema.statics.HANDLE = HANDLE;
barberShopSchema.statics.DEFAULT_SERVICES = DEFAULT_SERVICES;
barberShopSchema.statics.DEFAULT_HOURS = DEFAULT_HOURS;

module.exports = mongoose.model('BarberShop', barberShopSchema);
