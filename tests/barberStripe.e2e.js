/**
 * Barber booking — the money, end-to-end.
 *
 * Stripe is stubbed at the module loader, so what is under test is what this
 * codebase ASKS Stripe for: the amount, the metadata the webhook reads back,
 * the destination charge, and the platform's application fee. Stripe's own
 * arithmetic is Stripe's problem.
 *
 * Needs the dev dependency: npm install
 * Run: node tests/barberStripe.e2e.js
 */
process.env.JWT_SECRET = 'test-secret';
process.env.BARBER_PASSCODE = 'clippers-2026';
process.env.STRIPE_SECRET_KEY = 'sk_test_stub';
process.env.PUBLIC_API_URL = 'http://127.0.0.1:4601';

const Module = require('module');
const created = [];
let transfersActive = false;

// Stand-in Stripe. Records what the controller asks for, which is the thing
// under test — we are checking the split, not Stripe's arithmetic.
const stubStripe = function () {
  return {
    checkout: { sessions: { create: async (args) => { created.push(args); return { id: 'cs_test_' + created.length, url: 'https://checkout.stripe.com/c/pay/cs_test_' + created.length }; } } },
    accounts: {
      create: async () => ({ id: 'acct_stub_1' }),
      retrieve: async () => ({ id: 'acct_stub_1', capabilities: { transfers: transfersActive ? 'active' : 'inactive' }, details_submitted: transfersActive, requirements: { currently_due: transfersActive ? [] : ['external_account'] }, payouts_enabled: transfersActive })
    },
    accountLinks: { create: async () => ({ url: 'https://connect.stripe.com/setup/stub' }) },
    paymentMethodDomains: { list: async () => ({ data: [{}] }), create: async () => ({}) }
  };
};
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'stripe') return stubStripe;
  return origLoad.apply(this, arguments);
};

const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let pass = 0, fail = 0;
const ok = (n, c, x) => c ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + (x ? '  → ' + JSON.stringify(x) : '')));

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri('barberstripe'));

  const BarberController = require('../controllers/BarberController');
  const Booking = require('../models/Booking');
  const BarberShop = require('../models/BarberShop');
  const sched = require('../services/barberSchedule');

  const app = express();
  app.use(express.json());
  app.use('/api/v1/barber', BarberController);
  const server = app.listen(4601);
  const B = 'http://127.0.0.1:4601';
  const req = async (m, p, b, t) => {
    const r = await fetch(B + p, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}), body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };

  let r = await req('GET', '/api/v1/barber/shops/crispincuts');
  const svc = r.json.shop.services[0];
  const shopTz = r.json.shop.timezone;
  r = await req('GET', `/api/v1/barber/shops/crispincuts/days?days=14&serviceId=${svc.id}`);
  const day = r.json.days.find(d => d.open).date;
  r = await req('GET', `/api/v1/barber/shops/crispincuts/availability?date=${day}&serviceId=${svc.id}`);
  const slot = r.json.slots[1].start;

  console.log('\n— prepay offered at booking —');
  r = await req('POST', '/api/v1/barber/shops/crispincuts/bookings', { serviceId: svc.id, start: slot, name: 'Ray Mensah', email: 'ray@example.com' });
  ok('booking returns a pay link when Stripe is live', r.status === 200 && /checkout.stripe.com/.test(r.json.payUrl || ''), r.json);
  const bk = r.json.booking;
  const s1 = created[created.length - 1];
  ok('charged the menu price, in cents', s1.line_items[0].price_data.unit_amount === svc.priceCents, s1.line_items[0].price_data);
  ok('the webhook is told which booking this is', s1.metadata.type === 'barber_booking' && s1.metadata.bookingId === bk.id, s1.metadata);
  ok('no connected account means no split instruction', !s1.payment_intent_data);
  ok('the fee is recorded anyway', Number(s1.metadata.feeCents) === Math.round(svc.priceCents * 0.05), s1.metadata);
  ok('success returns to the client\'s own booking link', /\/@crispincuts\?b=.*&t=.*&paid=1$/.test(s1.success_url), s1.success_url);

  console.log('\n— connect, then bill —');
  r = await req('POST', '/api/v1/barber/login', { handle: 'crispincuts', passcode: 'clippers-2026' });
  const bt = r.json.token;
  r = await req('GET', '/api/v1/barber/admin/connect', null, bt);
  ok('no account yet reads as none', r.json.state === 'none', r.json);
  r = await req('POST', '/api/v1/barber/admin/connect', null, bt);
  ok('onboarding hands back a Stripe link', /connect.stripe.com/.test(r.json.url || ''), r.json);
  r = await req('GET', '/api/v1/barber/admin/connect', null, bt);
  ok('an unfinished account says what Stripe still wants', r.json.state === 'incomplete' && r.json.needs.includes('your bank account details'), r.json);
  transfersActive = true;
  r = await req('GET', '/api/v1/barber/admin/connect', null, bt);
  ok('a finished account reads as ready', r.json.state === 'ready', r.json);

  r = await req('POST', `/api/v1/barber/admin/bookings/${bk.id}/bill`, { amountCents: 6000, description: 'Cut & beard' }, bt);
  ok('the bill goes out', r.status === 200 && /checkout.stripe.com/.test(r.json.payUrl), r.json);
  ok('the split is quoted back to the barber', r.json.amountCents === 6000 && r.json.platformFeeCents === 300 && r.json.barberGetsCents === 5700, r.json);
  const s2 = created[created.length - 1];
  ok('now it is a destination charge', s2.payment_intent_data.transfer_data.destination === 'acct_stub_1', s2.payment_intent_data);
  ok('the application fee is the platform\'s 5%', s2.payment_intent_data.application_fee_amount === 300, s2.payment_intent_data);

  r = await req('POST', `/api/v1/barber/admin/bookings/${bk.id}/bill`, { amountCents: 20 }, bt);
  ok('a bill under fifty cents is refused', r.status === 400, r.json);

  console.log('\n— the webhook is the only thing that says "paid" —');
  let fresh = await Booking.findById(bk.id);
  ok('still unpaid until the webhook lands', fresh.status === 'booked' && !fresh.paidAt);

  const session = { id: fresh.stripeSessionId, amount_total: 6000, metadata: { type: 'barber_booking', bookingId: bk.id, shopHandle: 'crispincuts', feeCents: '300' } };
  await BarberController.fulfillPayment(session, 'evt_1');
  fresh = await Booking.findById(bk.id);
  ok('the webhook marks it paid', fresh.status === 'paid' && fresh.amountPaidCents === 6000, { s: fresh.status });
  ok('the platform fee is frozen on the booking', fresh.platformFeeCents === 300);
  ok('the pay link is retired once paid', fresh.paymentUrl === null);

  const paidAt = fresh.paidAt.getTime();
  await BarberController.fulfillPayment(session, 'evt_1');
  fresh = await Booking.findById(bk.id);
  ok('a replayed webhook changes nothing', fresh.paidAt.getTime() === paidAt);

  console.log('\n— what the numbers say afterwards —');
  r = await req('GET', '/api/v1/barber/admin/earnings?days=30', null, bt);
  ok('the barber sees gross, fee and net', r.json.grossCents === 6000 && r.json.platformFeeCents === 300 && r.json.netCents === 5700, r.json);

  process.env.PLATFORM_PASSCODE = 'owner-9';
  r = await req('POST', '/api/v1/barber/platform/login', { passcode: 'owner-9' });
  const pt = r.json.token;
  r = await req('GET', '/api/v1/barber/platform/shops?days=30', null, pt);
  ok('the owner sees the same money', r.json.totals.grossCents === 6000 && r.json.totals.platformFeeCents === 300, r.json.totals);

  // Raise the rate; old money must not move.
  await req('PUT', '/api/v1/barber/platform/shops/crispincuts', { platformFeeBps: 1000 }, pt);
  r = await req('GET', '/api/v1/barber/platform/shops?days=30', null, pt);
  ok('raising the rate does not rewrite money already taken', r.json.totals.platformFeeCents === 300, r.json.totals);
  const shop2 = await BarberShop.findOne({ handle: 'crispincuts' });
  ok('but the new rate applies from now on', shop2.feeOn(6000) === 600);

  r = await req('POST', `/api/v1/barber/admin/bookings/${bk.id}/bill`, { amountCents: 6000 }, bt);
  ok('a paid appointment cannot be billed twice', r.status === 409, r.json);

  console.log(`\nTotal: ${pass} passed, ${fail} failed\n`);
  await server.close(); await mongoose.disconnect(); await mongod.stop();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
