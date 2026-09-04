/**
 * BarberController — the booking platform behind an @handle.
 *
 * Three audiences, one router, three different levels of trust:
 *
 *   the public      knows a handle. Can see the menu, see free times, book one,
 *                   and manage the booking it made with the unguessable token
 *                   emailed to it. Nothing else.
 *   a barber        an ordinary account on this platform with role 'barber',
 *                   signed in through /api/v1/auth/login like everyone else.
 *                   The shop is found FROM their user id, never from anything
 *                   they send, so there is no request they can shape that
 *                   reaches another shop's diary.
 *   the platform    an existing admin account. Sets the take rate, sees every
 *                   shop, and can act on any one of them by naming it.
 *
 * There is deliberately no login of its own here. A second password store is a
 * second thing to reset, leak and forget, and the accounts already exist.
 *
 * Money: one Stripe Checkout per bill. Where the barber has connected a Stripe
 * account, the charge is a destination charge — the barber is paid directly and
 * the platform's percentage is taken as an application fee, which means the
 * platform never holds the barber's money. Where they have not connected yet,
 * the charge lands on the platform account and the booking records what is owed
 * to the barber, so nothing is lost while onboarding finishes.
 *
 * Payment state is only ever written by the verified Stripe webhook
 * (TokenController owns signature verification; it calls fulfillPayment here).
 * The client's browser is never believed about money.
 */
const express = require('express');
const bcrypt = require('bcryptjs');

const { verifyToken } = require('../middleware/auth');
const User = require('../models/User');
const BarberShop = require('../models/BarberShop');
const Booking = require('../models/Booking');
const sched = require('../services/barberSchedule');
const mail = require('../services/barberEmails');
const { humanRequirement } = require('../services/payouts');
const { siteUrl } = require('../services/siteUrl');

const router = express.Router();

/* ------------------------------------------------------------------ *
 * Plumbing
 * ------------------------------------------------------------------ */

function stripe() {
  const Stripe = require('stripe');
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not configured');
  return new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
}

/** This API's own host — the same convention the rest of the backend uses. */
function base() {
  return (process.env.PUBLIC_API_URL || 'https://digitalapple-backend-production.up.railway.app')
    .replace(/\/+$/, '');
}

/**
 * Where the booking page is READ, which is not always where the API is served.
 *
 * The backend serves /@handle itself, but the copy people are given lives on
 * the marketing site — and the link in a confirmation email, the address a
 * client bookmarks, and the page Stripe returns them to all have to be the one
 * the barber puts in their bio. Set BOOKING_SITE_URL when those differ.
 */
function bookingSite() {
  return String(process.env.BOOKING_SITE_URL || siteUrl()).replace(/\/+$/, '');
}

/** Where the barber's panel lives, for Stripe to hand them back to. */
function adminUrl() {
  return String(process.env.BOOKING_ADMIN_URL || (base() + '/book/')).replace(/\/+$/, '');
}

function shopUrl(handle) { return `${bookingSite()}/@${handle}`; }
function manageUrl(booking) { return `${shopUrl(booking.shopHandle)}?b=${booking._id}&t=${booking.manageToken}`; }

function clean(v, max = 200) { return String(v == null ? '' : v).trim().slice(0, max); }
function isEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim()); }
function normHandle(v) { return String(v || '').trim().replace(/^@/, '').toLowerCase(); }
function cents(v) { return Math.max(0, Math.round(Number(v) || 0)); }

/** Load a shop by handle, or answer the request. */
async function loadShop(req, res) {
  const handle = normHandle(req.params.handle || req.query.handle || (req.body && req.body.handle));
  if (!handle) { res.status(400).json({ error: 'No shop specified' }); return null; }
  const shop = await BarberShop.findOne({ handle });
  if (!shop) { res.status(404).json({ error: 'No shop at @' + handle }); return null; }
  return shop;
}

/* ------------------------------------------------------------------ *
 * Auth — the platform's own accounts, nothing new
 * ------------------------------------------------------------------ */

/**
 * A signed-in barber, on their own shop and no other.
 *
 * The shop is looked up FROM the user id in the verified token. Nothing in the
 * request chooses it, which is what makes `?handle=someoneelse` a no-op rather
 * than an attack. An admin runs the platform and may act on a shop, but has to
 * name it.
 */
async function barberAuth(req, res, next) {
  verifyToken(req, res, async () => {
    try {
      if (req.userRole === 'admin') {
        const asked = normHandle(req.query.handle || (req.body && req.body.handle) || req.params.handle);
        if (!asked) return res.status(400).json({ error: 'Name a shop' });
        req.shopHandle = asked;
        req.isPlatform = true;
        return next();
      }
      const shop = await BarberShop.findOne({ ownerUserId: req.userId }).select('handle').lean();
      if (!shop) return res.status(403).json({ error: 'No shop is attached to this account' });
      req.shopHandle = shop.handle;
      req.isPlatform = false;
      return next();
    } catch (e) {
      console.error('[barber] auth:', e.message);
      return res.status(500).json({ error: 'Could not check your account' });
    }
  });
}

/** The platform owner: the take rate, and the list of every shop. */
function platformAuth(req, res, next) {
  verifyToken(req, res, () => {
    if (req.userRole !== 'admin') return res.status(403).json({ error: 'Platform owner only' });
    req.isPlatform = true;
    next();
  });
}

/** The shop this request is scoped to, already authorised. */
async function authedShop(req, res) {
  const shop = await BarberShop.findOne({ handle: req.shopHandle });
  if (!shop) { res.status(404).json({ error: 'Shop not found' }); return null; }
  return shop;
}

/* ------------------------------------------------------------------ *
 * Public — the @handle booking page
 * ------------------------------------------------------------------ */

/** GET /barber/shops/:handle */
router.get('/shops/:handle', async (req, res) => {
  try {
    const handle = normHandle(req.params.handle);
    // The platform's own shop seeds itself; any other handle must already exist.
    const shop = handle === BarberShop.HANDLE
      ? await BarberShop.load(handle)
      : await BarberShop.findOne({ handle });
    if (!shop || !shop.active) return res.status(404).json({ error: 'No shop at @' + handle });
    res.json({ success: true, shop: shop.toPublic() });
  } catch (e) {
    console.error('[barber] shop:', e.message);
    res.status(500).json({ error: 'Could not load shop' });
  }
});

/** Live appointments touching a day, for slot arithmetic. */
async function bookingsForRange(handle, fromISO, toISO) {
  return Booking.find({
    shopHandle: handle,
    status: { $in: ['booked', 'paid'] },
    startsAt: { $lt: new Date(toISO) },
    endsAt: { $gt: new Date(fromISO) }
  }).select('startsAt endsAt').lean();
}

/** GET /barber/shops/:handle/availability?date=YYYY-MM-DD&serviceId= */
router.get('/shops/:handle/availability', async (req, res) => {
  try {
    const shop = await loadShop(req, res); if (!shop) return;
    const date = clean(req.query.date, 10);
    if (!sched.isDateStr(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });

    const svc = (shop.services || []).find(s => String(s._id) === clean(req.query.serviceId, 40) && s.active);
    const durationMin = svc ? svc.durationMin : 30;

    // A local day is never more than 26 hours wide, whatever the clocks do.
    const dayStart = sched.zonedToUtc(date, 0, shop.timezone);
    const dayEnd = new Date(dayStart.getTime() + 26 * 3600000);
    const busy = await bookingsForRange(shop.handle, dayStart.toISOString(), dayEnd.toISOString());

    const slots = sched.buildSlots({ dateStr: date, shop, durationMin, bookings: busy });
    res.json({ success: true, date, durationMin, timezone: shop.timezone, slots });
  } catch (e) {
    console.error('[barber] availability:', e.message);
    res.status(500).json({ error: 'Could not load times' });
  }
});

/**
 * GET /barber/shops/:handle/days?from=YYYY-MM-DD&days=14&serviceId=
 * Which days have anything free — so the calendar can grey out the rest
 * instead of making people click through empty days.
 */
router.get('/shops/:handle/days', async (req, res) => {
  try {
    const shop = await loadShop(req, res); if (!shop) return;
    const from = sched.isDateStr(req.query.from) ? clean(req.query.from, 10) : sched.dayKey(new Date(), shop.timezone);
    const days = Math.min(60, Math.max(1, parseInt(req.query.days, 10) || 21));
    const svc = (shop.services || []).find(s => String(s._id) === clean(req.query.serviceId, 40) && s.active);
    const durationMin = svc ? svc.durationMin : 30;

    const start = sched.zonedToUtc(from, 0, shop.timezone);
    const end = new Date(start.getTime() + (days + 1) * sched.DAY_MS);
    const busy = await bookingsForRange(shop.handle, start.toISOString(), end.toISOString());

    const out = [];
    for (let i = 0; i < days; i++) {
      const d = sched.addDays(from, i);
      const slots = sched.buildSlots({ dateStr: d, shop, durationMin, bookings: busy });
      out.push({ date: d, open: slots.length > 0, count: slots.length });
    }
    res.json({ success: true, timezone: shop.timezone, days: out });
  } catch (e) {
    console.error('[barber] days:', e.message);
    res.status(500).json({ error: 'Could not load calendar' });
  }
});

/**
 * Put an appointment on the books.
 *
 * Two checks, deliberately overlapping. The overlap query catches a 2:15 that
 * runs into a 2:30; the unique index catches two people who clicked the same
 * 2:30 in the same second, which no amount of checking-before-writing can. The
 * database gets the last word.
 */
async function place({ shop, svc, startsAt, name, email, phone, notes, source }) {
  const endsAt = new Date(startsAt.getTime() + svc.durationMin * 60000);

  const clash = await Booking.findOne({
    shopHandle: shop.handle,
    status: { $in: ['booked', 'paid'] },
    startsAt: { $lt: endsAt },
    endsAt: { $gt: startsAt }
  }).select('_id').lean();
  if (clash) { const e = new Error('taken'); e.taken = true; throw e; }

  try {
    return await Booking.create({
      shopHandle: shop.handle,
      clientName: name, clientEmail: email, clientPhone: phone, notes,
      serviceId: String(svc._id), serviceName: svc.name,
      durationMin: svc.durationMin, priceCents: svc.priceCents,
      startsAt, endsAt, source,
      amountDueCents: svc.priceCents
    });
  } catch (err) {
    if (err.code === 11000) { const e = new Error('taken'); e.taken = true; throw e; }
    throw err;
  }
}

/** POST /barber/shops/:handle/bookings — the public booking form. */
router.post('/shops/:handle/bookings', async (req, res) => {
  try {
    const shop = await loadShop(req, res); if (!shop) return;
    if (!shop.active) return res.status(409).json({ error: 'This shop is not taking bookings' });

    const b = req.body || {};
    const name = clean(b.name, 80);
    const email = clean(b.email, 160).toLowerCase();
    if (!name) return res.status(400).json({ error: 'Name required' });
    if (!isEmail(email)) return res.status(400).json({ error: 'A working email address is required' });

    const svc = (shop.services || []).find(s => String(s._id) === clean(b.serviceId, 40) && s.active);
    if (!svc) return res.status(400).json({ error: 'Pick a service' });

    const startsAt = new Date(b.start);
    if (isNaN(startsAt.getTime())) return res.status(400).json({ error: 'Pick a time' });

    // The offered grid is the contract: a time that was not on it — closed day,
    // inside the lead time, past closing — is not bookable just because someone
    // posted it directly.
    const date = sched.dayKey(startsAt, shop.timezone);
    const dayStart = sched.zonedToUtc(date, 0, shop.timezone);
    const busy = await bookingsForRange(shop.handle, dayStart.toISOString(), new Date(dayStart.getTime() + 26 * 3600000).toISOString());
    const offered = sched.buildSlots({ dateStr: date, shop, durationMin: svc.durationMin, bookings: busy });
    if (!offered.some(s => s.start === startsAt.toISOString())) {
      return res.status(409).json({ error: 'That time is no longer available' });
    }

    const booking = await place({
      shop, svc, startsAt, name, email,
      phone: clean(b.phone, 40), notes: clean(b.notes, 500), source: 'client'
    });

    // Prepay is offered, never forced — a deposit if the shop sets one, else
    // the full price. Checkout failing must not un-book them.
    let payUrl = null;
    if (process.env.STRIPE_SECRET_KEY && (shop.depositCents > 0 || svc.priceCents > 0)) {
      try {
        payUrl = await billingLink({
          shop, booking,
          amountCents: shop.depositCents > 0 ? shop.depositCents : svc.priceCents,
          description: shop.depositCents > 0 ? `Deposit — ${svc.name}` : svc.name
        });
      } catch (e) { console.error('[barber] prepay link:', e.message); }
    }

    await mail.clientConfirmation({ shop, booking, manageUrl: manageUrl(booking), payUrl });
    await mail.barberAlert({ shop, booking, kind: 'new', to: shop.barberEmail });

    res.json({ success: true, booking: booking.toPublic(), manageUrl: manageUrl(booking), payUrl });
  } catch (e) {
    if (e.taken) return res.status(409).json({ error: 'Someone just took that time. Pick another.' });
    console.error('[barber] booking:', e.message);
    res.status(500).json({ error: 'Could not book that' });
  }
});

/** GET /barber/bookings/:id?t=token — the client's own view of their appointment. */
router.get('/bookings/:id', async (req, res) => {
  try {
    const booking = await Booking.findOne({ _id: req.params.id, manageToken: clean(req.query.t, 80) });
    if (!booking) return res.status(404).json({ error: 'Not found' });
    const shop = await BarberShop.findOne({ handle: booking.shopHandle });
    res.json({
      success: true,
      booking: booking.toPublic(),
      when: shop ? sched.longLabel(booking.startsAt, shop.timezone) : booking.startsAt,
      shop: shop ? shop.toPublic() : null
    });
  } catch (e) {
    res.status(404).json({ error: 'Not found' });
  }
});

/** POST /barber/bookings/:id/cancel { t } */
router.post('/bookings/:id/cancel', async (req, res) => {
  try {
    const booking = await Booking.findOne({ _id: req.params.id, manageToken: clean(req.body.t, 80) });
    if (!booking) return res.status(404).json({ error: 'Not found' });
    if (booking.status === 'cancelled') return res.json({ success: true, booking: booking.toPublic() });

    booking.status = 'cancelled';
    booking.cancelledAt = new Date();
    booking.cancelledBy = 'client';
    booking.updatedAt = new Date();
    await booking.save();

    const shop = await BarberShop.findOne({ handle: booking.shopHandle });
    if (shop) {
      await mail.cancellation({ shop, booking, by: 'client', rebookUrl: shopUrl(shop.handle) });
      await mail.barberAlert({ shop, booking, kind: 'cancelled', to: shop.barberEmail });
    }
    res.json({ success: true, booking: booking.toPublic() });
  } catch (e) {
    console.error('[barber] cancel:', e.message);
    res.status(500).json({ error: 'Could not cancel' });
  }
});

/** POST /barber/bookings/:id/pay { t } — the client choosing to pay ahead. */
router.post('/bookings/:id/pay', async (req, res) => {
  try {
    const booking = await Booking.findOne({ _id: req.params.id, manageToken: clean(req.body.t, 80) });
    if (!booking) return res.status(404).json({ error: 'Not found' });
    if (booking.status === 'cancelled') return res.status(409).json({ error: 'This appointment was cancelled' });
    if (booking.status === 'paid') return res.status(409).json({ error: 'Already paid' });

    const shop = await BarberShop.findOne({ handle: booking.shopHandle });
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    const url = await billingLink({
      shop, booking,
      amountCents: booking.amountDueCents || booking.priceCents,
      description: booking.serviceName
    });
    res.json({ success: true, payUrl: url });
  } catch (e) {
    console.error('[barber] pay:', e.message);
    res.status(500).json({ error: 'Could not start payment' });
  }
});

/* ------------------------------------------------------------------ *
 * Money
 * ------------------------------------------------------------------ */

/** Can this shop be paid directly right now? */
async function payoutDestFor(shop) {
  try {
    if (!shop.stripeAccountId) return null;
    const acct = await stripe().accounts.retrieve(shop.stripeAccountId);
    if (acct && acct.capabilities && acct.capabilities.transfers === 'active') return shop.stripeAccountId;
  } catch (e) { /* fall through to a platform charge */ }
  return null;
}

/**
 * One Stripe Checkout for one booking, and the split written down.
 *
 * The fee is computed here and stored on the booking, so the platform's cut of
 * a paid appointment is whatever the rate was when the client was billed — not
 * whatever it happens to be the day someone runs a report.
 */
async function billingLink({ shop, booking, amountCents, description }) {
  const amount = cents(amountCents);
  if (amount < 50) throw new Error('Stripe will not take less than fifty cents');

  const dest = await payoutDestFor(shop);
  const fee = shop.feeOn(amount);
  const s = stripe();

  const session = await s.checkout.sessions.create({
    mode: 'payment',
    customer_email: booking.clientEmail,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: amount,
        product_data: {
          name: `${shop.name} — ${description || booking.serviceName}`,
          description: sched.longLabel(booking.startsAt, shop.timezone)
        }
      }
    }],
    // Destination charge: the barber is paid, the platform keeps its percentage.
    // Without a connected account the money lands on the platform and the
    // booking records what is owed — payable once onboarding finishes.
    ...(dest ? { payment_intent_data: { application_fee_amount: fee, transfer_data: { destination: dest } } } : {}),
    metadata: {
      type: 'barber_booking',
      bookingId: String(booking._id),
      shopHandle: shop.handle,
      feeCents: String(fee)
    },
    success_url: `${manageUrl(booking)}&paid=1`,
    cancel_url: manageUrl(booking)
  });

  booking.stripeSessionId = session.id;
  booking.amountDueCents = amount;
  booking.platformFeeCents = fee;
  booking.platformFeeBps = shop.platformFeeBps;
  booking.payoutAccountId = dest || null;
  booking.paymentUrl = session.url;
  booking.updatedAt = new Date();
  await booking.save();

  return session.url;
}

/**
 * Called by the verified Stripe webhook in TokenController. Idempotent on the
 * Stripe event id: a replayed webhook must not send a second receipt.
 */
async function fulfillPayment(session, stripeEventId) {
  const m = session.metadata || {};
  const booking = await Booking.findById(m.bookingId);
  if (!booking) throw new Error('booking gone: ' + m.bookingId);
  if (booking.stripeEventId === stripeEventId) return booking;

  const paid = cents(session.amount_total);
  booking.status = booking.status === 'cancelled' ? 'cancelled' : 'paid';
  booking.amountPaidCents = paid;
  booking.paidAt = new Date();
  booking.stripeEventId = stripeEventId;
  booking.stripeSessionId = session.id;
  booking.paymentUrl = null;
  if (m.feeCents) booking.platformFeeCents = cents(m.feeCents);
  booking.updatedAt = new Date();
  await booking.save();

  const shop = await BarberShop.findOne({ handle: booking.shopHandle });
  if (shop) {
    await mail.paymentReceipt({ shop, booking, amountCents: paid });
    await mail.barberAlert({ shop, booking, kind: 'paid', to: shop.barberEmail });
  }
  return booking;
}

/* ------------------------------------------------------------------ *
 * The barber's panel
 * ------------------------------------------------------------------ */

/** GET /barber/admin/me */
router.get('/admin/me', barberAuth, async (req, res) => {
  try {
    const shop = await authedShop(req, res); if (!shop) return;
    // The account behind the session, so the panel can show what address the
    // sign-in and the reset emails actually go to.
    const account = await User.findById(req.userId).select('email role firstName').lean();
    res.json({
      success: true,
      isPlatform: !!req.isPlatform,
      account: account ? { email: account.email, role: account.role, firstName: account.firstName || '' } : null,
      shop: Object.assign(shop.toPublic(), {
        barberEmail: shop.barberEmail,
        closures: shop.closures,
        platformFeeBps: shop.platformFeeBps,
        stripeConnected: !!shop.stripeAccountId,
        hasOwner: !!shop.ownerUserId,
        // Inactive services are hidden from clients but the barber has to see
        // them to turn one back on.
        allServices: (shop.services || []).map(s => ({
          id: String(s._id), name: s.name, description: s.description,
          durationMin: s.durationMin, priceCents: s.priceCents, active: s.active
        }))
      }),
      bookingUrl: shopUrl(shop.handle)
    });
  } catch (e) {
    console.error('[barber] me:', e.message);
    res.status(500).json({ error: 'Could not load your shop' });
  }
});

/** PUT /barber/admin/shop — everything the barber controls about the shop. */
router.put('/admin/shop', barberAuth, async (req, res) => {
  try {
    const shop = await authedShop(req, res); if (!shop) return;
    const b = req.body || {};

    if (b.name != null) shop.name = clean(b.name, 80) || shop.name;
    if (b.tagline != null) shop.tagline = clean(b.tagline, 160);
    if (b.address != null) shop.address = clean(b.address, 200);
    if (b.phone != null) shop.phone = clean(b.phone, 40);
    if (b.barberEmail != null) {
      const e = clean(b.barberEmail, 160).toLowerCase();
      if (e && !isEmail(e)) return res.status(400).json({ error: 'That email address is not valid' });
      shop.barberEmail = e;
    }
    if (b.timezone != null) {
      // Validated by trying it: an unknown zone would otherwise poison every
      // slot the shop offers from then on.
      try { new Intl.DateTimeFormat('en-US', { timeZone: String(b.timezone) }); shop.timezone = String(b.timezone); }
      catch (e) { return res.status(400).json({ error: 'Unknown timezone' }); }
    }
    if (b.slotStepMin != null) shop.slotStepMin = Math.min(60, Math.max(5, parseInt(b.slotStepMin, 10) || 15));
    if (b.leadMinutes != null) shop.leadMinutes = Math.min(7 * 24 * 60, Math.max(0, parseInt(b.leadMinutes, 10) || 0));
    if (b.horizonDays != null) shop.horizonDays = Math.min(180, Math.max(1, parseInt(b.horizonDays, 10) || 45));
    if (b.depositCents != null) shop.depositCents = Math.min(100000, cents(b.depositCents));

    if (Array.isArray(b.hours)) {
      const rows = [];
      for (const h of b.hours) {
        const day = parseInt(h.day, 10);
        if (!(day >= 0 && day <= 6)) continue;
        const open = Math.min(1439, Math.max(0, parseInt(h.open, 10) || 0));
        const close = Math.min(1440, Math.max(0, parseInt(h.close, 10) || 0));
        if (!h.closed && close <= open) return res.status(400).json({ error: 'Closing time must be after opening time' });
        rows.push({ day, open, close, closed: !!h.closed });
      }
      if (rows.length) shop.hours = rows;
    }
    if (Array.isArray(b.closures)) {
      shop.closures = b.closures.map(d => clean(d, 10)).filter(sched.isDateStr).slice(0, 200);
    }

    shop.updatedAt = new Date();
    await shop.save();
    res.json({ success: true, shop: shop.toPublic() });
  } catch (e) {
    console.error('[barber] update shop:', e.message);
    res.status(500).json({ error: 'Could not save' });
  }
});

/** POST /barber/admin/services — add a service to the menu. */
router.post('/admin/services', barberAuth, async (req, res) => {
  try {
    const shop = await authedShop(req, res); if (!shop) return;
    const b = req.body || {};
    const name = clean(b.name, 80);
    if (!name) return res.status(400).json({ error: 'Name required' });
    shop.services.push({
      name,
      description: clean(b.description, 200),
      durationMin: Math.min(480, Math.max(5, parseInt(b.durationMin, 10) || 30)),
      priceCents: Math.min(1000000, cents(b.priceCents)),
      active: b.active !== false
    });
    shop.updatedAt = new Date();
    await shop.save();
    res.json({ success: true, shop: shop.toPublic() });
  } catch (e) {
    console.error('[barber] add service:', e.message);
    res.status(500).json({ error: 'Could not add that' });
  }
});

/** PUT /barber/admin/services/:sid */
router.put('/admin/services/:sid', barberAuth, async (req, res) => {
  try {
    const shop = await authedShop(req, res); if (!shop) return;
    const svc = (shop.services || []).id(req.params.sid);
    if (!svc) return res.status(404).json({ error: 'No such service' });
    const b = req.body || {};
    if (b.name != null) svc.name = clean(b.name, 80) || svc.name;
    if (b.description != null) svc.description = clean(b.description, 200);
    if (b.durationMin != null) svc.durationMin = Math.min(480, Math.max(5, parseInt(b.durationMin, 10) || svc.durationMin));
    if (b.priceCents != null) svc.priceCents = Math.min(1000000, cents(b.priceCents));
    if (b.active != null) svc.active = !!b.active;
    shop.updatedAt = new Date();
    await shop.save();
    res.json({ success: true, shop: shop.toPublic() });
  } catch (e) {
    console.error('[barber] edit service:', e.message);
    res.status(500).json({ error: 'Could not save that' });
  }
});

/**
 * DELETE /barber/admin/services/:sid
 * Retired, not deleted — appointments already booked snapshot their service,
 * but a menu that silently loses a row is how a barber ends up wondering what
 * they charged for a fade last month.
 */
router.delete('/admin/services/:sid', barberAuth, async (req, res) => {
  try {
    const shop = await authedShop(req, res); if (!shop) return;
    const svc = (shop.services || []).id(req.params.sid);
    if (!svc) return res.status(404).json({ error: 'No such service' });
    svc.active = false;
    shop.updatedAt = new Date();
    await shop.save();
    res.json({ success: true, shop: shop.toPublic() });
  } catch (e) {
    res.status(500).json({ error: 'Could not remove that' });
  }
});

/** GET /barber/admin/bookings?from=&to=&status= — the diary. */
router.get('/admin/bookings', barberAuth, async (req, res) => {
  try {
    const shop = await authedShop(req, res); if (!shop) return;
    const from = sched.isDateStr(req.query.from) ? clean(req.query.from, 10) : sched.dayKey(new Date(), shop.timezone);
    const days = Math.min(120, Math.max(1, parseInt(req.query.days, 10) || 14));
    const start = sched.zonedToUtc(from, 0, shop.timezone);
    const end = new Date(start.getTime() + days * sched.DAY_MS);

    const q = { shopHandle: shop.handle, startsAt: { $gte: start, $lt: end } };
    if (req.query.status && ['booked', 'paid', 'cancelled', 'completed'].includes(req.query.status)) {
      q.status = req.query.status;
    }
    const rows = await Booking.find(q).sort({ startsAt: 1 }).limit(500);
    res.json({
      success: true,
      timezone: shop.timezone,
      bookings: rows.map(r => Object.assign(r.toPublic(), {
        when: sched.longLabel(r.startsAt, shop.timezone),
        day: sched.dayKey(r.startsAt, shop.timezone),
        time: sched.timeLabel(r.startsAt, shop.timezone),
        manageUrl: manageUrl(r)
      }))
    });
  } catch (e) {
    console.error('[barber] diary:', e.message);
    res.status(500).json({ error: 'Could not load the diary' });
  }
});

/**
 * POST /barber/admin/bookings — the barber writes someone in, and it emails
 * them the time. This is the "set a booking and it emails them" path, so it
 * takes any time the barber says, including outside opening hours: the person
 * with the shears knows something the grid does not. It still refuses to
 * double-book, because that one is never intentional.
 */
router.post('/admin/bookings', barberAuth, async (req, res) => {
  try {
    const shop = await authedShop(req, res); if (!shop) return;
    const b = req.body || {};
    const name = clean(b.name, 80);
    const email = clean(b.email, 160).toLowerCase();
    if (!name) return res.status(400).json({ error: 'Client name required' });
    if (!isEmail(email)) return res.status(400).json({ error: 'A working email address is required' });

    let svc = (shop.services || []).find(s => String(s._id) === clean(b.serviceId, 40));
    if (!svc) {
      // A one-off: a price and a length, with no menu entry behind it.
      svc = {
        _id: '',
        name: clean(b.serviceName, 80) || 'Appointment',
        durationMin: Math.min(480, Math.max(5, parseInt(b.durationMin, 10) || 30)),
        priceCents: cents(b.priceCents)
      };
    }
    const startsAt = new Date(b.start);
    if (isNaN(startsAt.getTime())) return res.status(400).json({ error: 'Pick a time' });

    const booking = await place({
      shop, svc, startsAt, name, email,
      phone: clean(b.phone, 40), notes: clean(b.notes, 500), source: 'barber'
    });

    let payUrl = null;
    if (b.sendBill && process.env.STRIPE_SECRET_KEY && (svc.priceCents || 0) >= 50) {
      try { payUrl = await billingLink({ shop, booking, amountCents: svc.priceCents, description: svc.name }); }
      catch (e) { console.error('[barber] bill on create:', e.message); }
    }

    await mail.bookedByBarber({ shop, booking, manageUrl: manageUrl(booking), payUrl });

    res.json({ success: true, booking: booking.toPublic(), emailedTo: email, payUrl });
  } catch (e) {
    if (e.taken) return res.status(409).json({ error: 'You already have someone in that slot' });
    console.error('[barber] barber booking:', e.message);
    res.status(500).json({ error: 'Could not book that' });
  }
});

/**
 * POST /barber/admin/bookings/:id/bill { amountCents, description }
 * Bill a client for this appointment — the invoice lands in their inbox with a
 * Stripe Checkout link, and the platform's cut is fixed at today's rate.
 */
router.post('/admin/bookings/:id/bill', barberAuth, async (req, res) => {
  try {
    const shop = await authedShop(req, res); if (!shop) return;
    const booking = await Booking.findOne({ _id: req.params.id, shopHandle: shop.handle });
    if (!booking) return res.status(404).json({ error: 'No such appointment' });
    if (booking.status === 'paid') return res.status(409).json({ error: 'Already paid' });
    if (booking.status === 'cancelled') return res.status(409).json({ error: 'That appointment was cancelled' });

    const amount = cents(req.body.amountCents != null ? req.body.amountCents : booking.priceCents);
    if (amount < 50) return res.status(400).json({ error: 'Bill at least $0.50' });
    const description = clean(req.body.description, 120) || booking.serviceName;

    const payUrl = await billingLink({ shop, booking, amountCents: amount, description });
    await mail.invoice({ shop, booking, amountCents: amount, description, payUrl });

    res.json({
      success: true, payUrl, emailedTo: booking.clientEmail,
      amountCents: amount, platformFeeCents: booking.platformFeeCents,
      barberGetsCents: amount - booking.platformFeeCents
    });
  } catch (e) {
    console.error('[barber] bill:', e.type || '', e.message);
    const reason = e.type === 'StripeAuthenticationError' ? 'stripe_key'
      : e.type === 'StripePermissionError' ? 'stripe_permission'
      : e.type === 'StripeInvalidRequestError' ? 'stripe_request'
      : 'unknown';
    res.status(500).json({ error: 'Could not create the bill', reason });
  }
});

/** POST /barber/admin/bookings/:id/cancel */
router.post('/admin/bookings/:id/cancel', barberAuth, async (req, res) => {
  try {
    const shop = await authedShop(req, res); if (!shop) return;
    const booking = await Booking.findOne({ _id: req.params.id, shopHandle: shop.handle });
    if (!booking) return res.status(404).json({ error: 'No such appointment' });
    if (booking.status !== 'cancelled') {
      booking.status = 'cancelled';
      booking.cancelledAt = new Date();
      booking.cancelledBy = 'barber';
      booking.updatedAt = new Date();
      await booking.save();
      await mail.cancellation({ shop, booking, by: 'barber', rebookUrl: shopUrl(shop.handle) });
    }
    res.json({ success: true, booking: booking.toPublic() });
  } catch (e) {
    res.status(500).json({ error: 'Could not cancel' });
  }
});

/** POST /barber/admin/bookings/:id/complete — done, out of the chair. */
router.post('/admin/bookings/:id/complete', barberAuth, async (req, res) => {
  try {
    const shop = await authedShop(req, res); if (!shop) return;
    const booking = await Booking.findOne({ _id: req.params.id, shopHandle: shop.handle });
    if (!booking) return res.status(404).json({ error: 'No such appointment' });
    if (booking.status === 'cancelled') return res.status(409).json({ error: 'That one was cancelled' });
    booking.status = 'completed';
    booking.updatedAt = new Date();
    await booking.save();
    res.json({ success: true, booking: booking.toPublic() });
  } catch (e) {
    res.status(500).json({ error: 'Could not update that' });
  }
});

/**
 * Money in, by day, with the platform's cut broken out — the same numbers the
 * platform sees, shown to the barber, because a take rate nobody can see is a
 * take rate nobody trusts.
 */
async function earnings(handle, days) {
  const since = new Date(Date.now() - days * sched.DAY_MS);
  const rows = await Booking.find({
    shopHandle: handle, status: 'paid', paidAt: { $gte: since }
  }).select('paidAt amountPaidCents platformFeeCents').lean();

  let gross = 0, fees = 0;
  for (const r of rows) { gross += r.amountPaidCents || 0; fees += r.platformFeeCents || 0; }
  return { days, count: rows.length, grossCents: gross, platformFeeCents: fees, netCents: gross - fees };
}

/** GET /barber/admin/earnings?days=30 */
router.get('/admin/earnings', barberAuth, async (req, res) => {
  try {
    const shop = await authedShop(req, res); if (!shop) return;
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
    const e = await earnings(shop.handle, days);
    res.json({ success: true, feeBps: shop.platformFeeBps, ...e });
  } catch (e) {
    res.status(500).json({ error: 'Could not total that up' });
  }
});

/* ------------------------------------------------------------------ *
 * Stripe Connect onboarding
 * ------------------------------------------------------------------ */

/** GET /barber/admin/connect — where this shop stands with Stripe. */
router.get('/admin/connect', barberAuth, async (req, res) => {
  try {
    const shop = await authedShop(req, res); if (!shop) return;
    if (!shop.stripeAccountId) return res.json({ success: true, state: 'none', needs: [] });
    const acct = await stripe().accounts.retrieve(shop.stripeAccountId);
    if (acct.capabilities && acct.capabilities.transfers === 'active') {
      return res.json({ success: true, state: 'ready', needs: [], payoutsEnabled: !!acct.payouts_enabled });
    }
    const req_ = acct.requirements || {};
    const due = [].concat(req_.currently_due || [], req_.past_due || []);
    if (!acct.details_submitted || due.length) {
      return res.json({ success: true, state: 'incomplete', needs: due.slice(0, 6).map(humanRequirement) });
    }
    res.json({ success: true, state: 'pending', needs: [] });
  } catch (e) {
    // Not the same as 'none' — telling a connected barber they have no bank
    // because an API call timed out invites them to redo work already done.
    console.error('[barber] connect status:', e.message);
    res.json({ success: true, state: 'unknown', needs: [] });
  }
});

/** POST /barber/admin/connect — a fresh onboarding link. */
router.post('/admin/connect', barberAuth, async (req, res) => {
  try {
    const shop = await authedShop(req, res); if (!shop) return;
    const s = stripe();
    if (!shop.stripeAccountId) {
      // Express, and deliberately as light as Stripe allows.
      //
      // A barber who has not registered a business is an INDIVIDUAL. Saying so
      // up front means onboarding asks for a person — name, date of birth,
      // address, the last four of an SSN, a bank account — instead of opening
      // with an EIN and company details he does not have and cannot invent.
      //
      // Only `transfers` is requested. The charge is created on the PLATFORM
      // account and transferred to him (payment_intent_data.transfer_data), so
      // the platform is the merchant of record and his account only has to be
      // able to receive money. Asking for `card_payments` as well would make
      // Stripe underwrite him as a merchant in his own right and demand a
      // correspondingly heavier set of documents — for a capability that these
      // charges never use.
      const acct = await s.accounts.create({
        type: 'express',
        email: shop.barberEmail || undefined,
        business_type: 'individual',
        business_profile: {
          name: shop.name,
          url: shopUrl(shop.handle),
          mcc: '7230',                       // Stripe's code for barber and beauty shops
          product_description: 'Haircuts and grooming services booked by appointment'
        },
        capabilities: { transfers: { requested: true } }
      });
      shop.stripeAccountId = acct.id;
      shop.updatedAt = new Date();
      await shop.save();
    }
    const link = await s.accountLinks.create({
      account: shop.stripeAccountId,
      refresh_url: `${adminUrl()}?connect=retry`,
      return_url: `${adminUrl()}?connect=done`,
      type: 'account_onboarding'
    });
    res.json({ success: true, url: link.url });
  } catch (e) {
    console.error('[barber] connect:', e.message);
    res.status(500).json({ error: 'Could not start payout setup' });
  }
});

/* ------------------------------------------------------------------ *
 * The platform owner
 * ------------------------------------------------------------------ */

/** GET /barber/platform/shops — every shop, with what it has earned the platform. */
router.get('/platform/shops', platformAuth, async (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
    const shops = await BarberShop.find().sort({ createdAt: 1 });
    const owners = await User.find({ _id: { $in: shops.map(s => s.ownerUserId).filter(Boolean) } })
      .select('email').lean();
    const ownerById = {};
    for (const o of owners) ownerById[String(o._id)] = o.email;

    const out = [];
    let grossAll = 0, feesAll = 0;
    for (const shop of shops) {
      const e = await earnings(shop.handle, days);
      grossAll += e.grossCents; feesAll += e.platformFeeCents;
      out.push({
        handle: shop.handle, name: shop.name, active: shop.active,
        // A shop with no owner cannot be signed into — the panel says so, and
        // says it where the fix is.
        ownerEmail: ownerById[String(shop.ownerUserId)] || null,
        barberEmail: shop.barberEmail, timezone: shop.timezone,
        platformFeeBps: shop.platformFeeBps,
        stripeConnected: !!shop.stripeAccountId,
        hasOwner: !!shop.ownerUserId,
        bookingUrl: shopUrl(shop.handle),
        ...e
      });
    }
    res.json({ success: true, days, shops: out, totals: { grossCents: grossAll, platformFeeCents: feesAll } });
  } catch (e) {
    console.error('[barber] platform shops:', e.message);
    res.status(500).json({ error: 'Could not load the platform' });
  }
});

/**
 * PUT /barber/platform/shops/:handle { platformFeeBps, active }
 * The take rate, adjustable. Capped at 30% in the model — a rate that empties
 * a barber's till is a bug however it is typed.
 */
router.put('/platform/shops/:handle', platformAuth, async (req, res) => {
  try {
    const shop = await BarberShop.findOne({ handle: normHandle(req.params.handle) });
    if (!shop) return res.status(404).json({ error: 'No such shop' });
    if (req.body.platformFeeBps != null) {
      const bps = parseInt(req.body.platformFeeBps, 10);
      if (!(bps >= 0 && bps <= 3000)) return res.status(400).json({ error: 'Rate must be between 0% and 30%' });
      shop.platformFeeBps = bps;
    }
    if (req.body.active != null) shop.active = !!req.body.active;
    shop.updatedAt = new Date();
    await shop.save();
    res.json({ success: true, handle: shop.handle, platformFeeBps: shop.platformFeeBps, active: shop.active });
  } catch (e) {
    console.error('[barber] set rate:', e.message);
    res.status(500).json({ error: 'Could not save' });
  }
});

/**
 * POST /barber/platform/shops — put another barber on the platform.
 *
 * The shop needs an owner, and an owner is an account. Given an email that
 * already has one, that account is promoted to 'barber' and linked; given a new
 * one, an account is created with the password the owner sets. Either way the
 * barber signs in at the same place as everybody else, and there is no
 * shop-shaped credential anywhere in the system.
 */
router.post('/platform/shops', platformAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const handle = normHandle(b.handle);
    if (!/^[a-z0-9][a-z0-9_.-]{2,29}$/.test(handle)) {
      return res.status(400).json({ error: 'Handles are 3–30 characters: letters, numbers, dot, dash, underscore' });
    }
    if (await BarberShop.findOne({ handle })) return res.status(409).json({ error: '@' + handle + ' is taken' });

    const email = clean(b.barberEmail, 160).toLowerCase();
    if (!isEmail(email)) return res.status(400).json({ error: 'The barber needs an email address to sign in with' });

    let user = await User.findOne({ email });
    let created = false;
    if (user) {
      // An existing member becomes a barber. An admin is left alone: demoting
      // the person running the platform because they also cut hair would lock
      // them out of the platform panel.
      if (user.role === 'user') { user.role = 'barber'; await user.save(); }
    } else {
      const password = String(b.password || '');
      if (password.length < 8) return res.status(400).json({ error: 'Set them a password of at least eight characters' });
      user = await User.create({
        email,
        passwordHash: await bcrypt.hash(password, 10),
        role: 'barber',
        firstName: clean(b.name, 50) || 'Barber'
      });
      created = true;
    }

    if (await BarberShop.findOne({ ownerUserId: user._id })) {
      return res.status(409).json({ error: 'That account already runs a shop' });
    }

    const shop = await BarberShop.create({
      handle,
      name: clean(b.name, 80) || ('@' + handle),
      barberEmail: email,
      ownerUserId: user._id,
      timezone: clean(b.timezone, 60) || 'America/New_York',
      platformFeeBps: b.platformFeeBps != null
        ? Math.min(3000, Math.max(0, parseInt(b.platformFeeBps, 10) || 0))
        : Number(process.env.BARBER_PLATFORM_FEE_BPS || 500),
      services: BarberShop.DEFAULT_SERVICES,
      hours: BarberShop.DEFAULT_HOURS
    });
    res.json({
      success: true, handle: shop.handle, bookingUrl: shopUrl(shop.handle),
      accountCreated: created, signInEmail: email
    });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'That handle or email is already taken' });
    console.error('[barber] create shop:', e.message);
    res.status(500).json({ error: 'Could not create that shop' });
  }
});

/**
 * PUT /barber/platform/shops/:handle/owner { email }
 * Hand a shop to an account — how the seeded shop gets its barber, and how a
 * shop changes hands without anybody editing the database by hand.
 */
router.put('/platform/shops/:handle/owner', platformAuth, async (req, res) => {
  try {
    const shop = await BarberShop.findOne({ handle: normHandle(req.params.handle) });
    if (!shop) return res.status(404).json({ error: 'No such shop' });
    const email = clean(req.body.email, 160).toLowerCase();
    if (!isEmail(email)) return res.status(400).json({ error: 'That email address is not valid' });

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'No account with that email — create the shop with a password instead' });

    const other = await BarberShop.findOne({ ownerUserId: user._id, handle: { $ne: shop.handle } });
    if (other) return res.status(409).json({ error: 'That account already runs @' + other.handle });

    if (user.role === 'user') { user.role = 'barber'; await user.save(); }
    shop.ownerUserId = user._id;
    if (!shop.barberEmail) shop.barberEmail = email;
    shop.updatedAt = new Date();
    await shop.save();
    res.json({ success: true, handle: shop.handle, ownerEmail: email });
  } catch (e) {
    console.error('[barber] set owner:', e.message);
    res.status(500).json({ error: 'Could not hand over that shop' });
  }
});

/**
 * GET /barber/health — is this thing wired up?
 *
 * Names the variables that are missing rather than reporting a bare false. A
 * deploy where email silently does not send is the failure this endpoint
 * exists to shorten, and "email: false" does not tell anybody which of three
 * variables to go and set. Names only — never a value, never a fragment of one.
 */
router.get('/health', async (req, res) => {
  let shops = null, ownedShops = null, barbers = null;
  try {
    shops = await BarberShop.countDocuments();
    ownedShops = await BarberShop.countDocuments({ ownerUserId: { $ne: null } });
    barbers = await User.countDocuments({ role: 'barber' });
  } catch (e) { /* db down; say so by omission */ }

  // Either provider is enough. Only name the SMTP variables when there is no
  // Resend key either — telling somebody to set SMTP_HOST when their mail is
  // already going out through Resend is worse than saying nothing.
  const { emailProvider, fromAddress } = require('../utils/email');
  const provider = emailProvider();
  const missing = [];
  if (provider === 'none') {
    missing.push('RESEND_API_KEY');
    for (const k of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']) if (!process.env[k]) missing.push(k);
  }

  res.json({
    ok: true,
    stripe: !!process.env.STRIPE_SECRET_KEY,
    stripeWebhook: !!process.env.STRIPE_WEBHOOK_SECRET,
    email: provider !== 'none',
    emailProvider: provider,
    // The whole point: what to go and set. 'RESEND_API_KEY or all three SMTP.'
    emailMissing: missing,
    emailFrom: provider === 'none' ? null : fromAddress(),
    seedConfigured: !!process.env.BARBER_SEED_PASSWORD,
    defaultHandle: BarberShop.HANDLE,
    feeBps: Number(process.env.BARBER_PLATFORM_FEE_BPS || 500),
    shops,
    // A shop nobody owns cannot be signed into — the number that says whether
    // the seed actually ran.
    ownedShops,
    barbers
  });
});

module.exports = router;
module.exports.fulfillPayment = fulfillPayment;
