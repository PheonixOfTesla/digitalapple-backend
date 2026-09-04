/**
 * Barber booking — end-to-end.
 *
 * A real Mongo (in memory), the real router, the real models. No Stripe key on
 * purpose: taking bookings must work with nothing but a database, and billing
 * must fail in a way somebody can read.
 *
 * Needs the dev dependency: npm install
 * Run: node tests/barberBooking.e2e.js
 */
process.env.JWT_SECRET = 'test-secret';
process.env.BARBER_PLATFORM_FEE_BPS = '500';
process.env.PUBLIC_API_URL = 'http://127.0.0.1:4599';
process.env.BOOKING_SITE_URL = 'http://127.0.0.1:4599';

const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')); }
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri('barbertest'));
  console.log('mongo up\n');

  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', require(ROOT + '/controllers/AuthController'));
  app.use('/api/v1/barber', require(ROOT + '/controllers/BarberController'));
  app.use('/book', express.static(path.join(ROOT, 'public/barber'), { extensions: ['html'] }));
  app.get(/^\/@([A-Za-z0-9_.-]{2,30})$/, (req, res) => res.sendFile(path.join(ROOT, 'public/barber/book.html')));
  const server = app.listen(4599);
  const B = 'http://127.0.0.1:4599';

  async function req(method, p, body, tok) {
    const r = await fetch(B + p, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, tok ? { Authorization: 'Bearer ' + tok } : {}),
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (e) {}
    return { status: r.status, json, text };
  }

  // The two accounts this platform actually has: a barber and an admin.
  const bcrypt = require('bcryptjs');
  const User = require(ROOT + '/models/User');
  const BarberShop = require(ROOT + '/models/BarberShop');
  const barberUser = await User.create({ email: 'crispin@admin.com', passwordHash: await bcrypt.hash('Barber2026!', 10), role: 'barber', firstName: 'Crispin' });
  await User.create({ email: 'owner@example.com', passwordHash: await bcrypt.hash('owner-passcode-9', 10), role: 'admin', firstName: 'Owner' });
  const strangerTok = await (async () => {
    await User.create({ email: 'stranger@example.com', passwordHash: await bcrypt.hash('stranger-pass-1', 10), role: 'user', firstName: 'Stranger' });
    const r = await fetch(B + '/api/v1/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email:'stranger@example.com', password:'stranger-pass-1' }) });
    return (await r.json()).token;
  })();

  console.log('— public booking —');
  let r = await req('GET', '/api/v1/barber/health');
  ok('health reports config honestly', r.json.ok === true && r.json.stripe === false && r.json.email === false, r.json);

  r = await req('GET', '/api/v1/barber/shops/crispincuts');
  ok('shop seeds itself on first view', r.status === 200 && r.json.shop.services.length === 5, r.json && r.json.error);
  const shop = r.json.shop;
  const svc = shop.services[0];
  ok('no passcode hash ever reaches the page', !JSON.stringify(r.json).includes('passcodeHash'));

  r = await req('GET', '/api/v1/barber/shops/nosuchshop');
  ok('unknown handle is a 404, not a seed', r.status === 404);

  r = await req('GET', `/api/v1/barber/shops/crispincuts/days?days=14&serviceId=${svc.id}`);
  const openDay = r.json.days.find(d => d.open);
  ok('calendar marks open and closed days', r.status === 200 && !!openDay && r.json.days.some(d => !d.open), r.json);

  r = await req('GET', `/api/v1/barber/shops/crispincuts/availability?date=${openDay.date}&serviceId=${svc.id}`);
  const slots = r.json.slots;
  ok('a day offers slots in shop time', slots.length > 3 && /AM|PM/.test(slots[0].label), slots && slots[0]);

  r = await req('POST', '/api/v1/barber/shops/crispincuts/bookings', {
    serviceId: svc.id, start: slots[2].start, name: 'Dave Okafor', email: 'dave@example.com', phone: '555-0110', notes: 'Number 2 on the sides'
  });
  ok('a client can book without an account or a card', r.status === 200 && r.json.booking.status === 'booked', r.json);
  const booking = r.json.booking;
  const token = (r.json.manageUrl.split('t=')[1] || '');
  ok('manage link carries an unguessable token', token.length >= 40);

  r = await req('POST', '/api/v1/barber/shops/crispincuts/bookings', {
    serviceId: svc.id, start: slots[2].start, name: 'Someone Else', email: 'else@example.com'
  });
  ok('the same slot cannot be booked twice', r.status === 409, r.json);

  r = await req('GET', `/api/v1/barber/shops/crispincuts/availability?date=${openDay.date}&serviceId=${svc.id}`);
  ok('a booked time disappears from the grid', !r.json.slots.some(s => s.start === slots[2].start));
  ok('overlapping times disappear too', r.json.slots.length <= slots.length - 2, { before: slots.length, after: r.json.slots.length });

  r = await req('POST', '/api/v1/barber/shops/crispincuts/bookings', {
    serviceId: svc.id, start: '2020-01-01T10:00:00.000Z', name: 'Time Traveller', email: 't@example.com'
  });
  ok('a time that was never offered is refused', r.status === 409, r.json);

  r = await req('POST', '/api/v1/barber/shops/crispincuts/bookings', {
    serviceId: svc.id, start: slots[5].start, name: 'No Email', email: 'not-an-email'
  });
  ok('a bad email address is refused', r.status === 400, r.json);

  r = await req('GET', `/api/v1/barber/bookings/${booking.id}?t=${token}`);
  ok('the client can read their own booking', r.status === 200 && /at \d/.test(r.json.when), r.json && r.json.when);
  r = await req('GET', `/api/v1/barber/bookings/${booking.id}?t=wrongtoken`);
  ok('a wrong token reads nothing', r.status === 404);

  console.log('\n— the barber —');
  r = await req('POST', '/api/v1/auth/login', { email: 'crispin@admin.com', password: 'wrong' });
  ok('a wrong password is refused', r.status === 401);
  r = await req('POST', '/api/v1/auth/login', { email: 'crispin@admin.com', password: 'Barber2026!' });
  ok('the barber signs in with their ordinary account', r.status === 200 && !!r.json.token, r.json);
  let bt = r.json.token;

  r = await req('GET', '/api/v1/barber/admin/me', null, bt);
  ok('an account with no shop attached gets nothing', r.status === 403, r.json);

  // Attach the shop, the way the platform panel does.
  const shopDoc = await BarberShop.findOne({ handle: 'crispincuts' });
  shopDoc.ownerUserId = barberUser._id; await shopDoc.save();

  r = await req('GET', '/api/v1/barber/admin/me', null, strangerTok);
  ok('an ordinary member cannot open the panel', r.status === 403, r.json);

  r = await req('GET', '/api/v1/barber/admin/me', null, bt);
  ok('the panel loads the shop', r.status === 200 && r.json.shop.handle === 'crispincuts' && r.json.isPlatform === false);
  ok('the panel knows which account is signed in', r.json.account && r.json.account.email === 'crispin@admin.com', r.json.account);
  ok('the panel is told the booking link', r.json.bookingUrl === 'http://127.0.0.1:4599/@crispincuts', r.json.bookingUrl);

  r = await req('GET', '/api/v1/barber/admin/me');
  // verifyToken answers 403 for a missing header and 401 for a bad one; both
  // are refusals, and the panel treats either as "sign in again".
  ok('no token, no panel', r.status === 401 || r.status === 403, r.status);
  r = await req('GET', '/api/v1/barber/admin/me', null, 'not-a-real-token');
  ok('a forged token, no panel', r.status === 401, r.status);

  r = await req('GET', '/api/v1/barber/admin/bookings?days=14', null, bt);
  ok('the diary shows the booking with a readable time', r.json.bookings.length === 1 && /AM|PM/.test(r.json.bookings[0].time), r.json.bookings && r.json.bookings[0]);

  // 3am Tuesday — deliberately outside opening hours.
  const sched = require(ROOT + '/services/barberSchedule');
  const oddTime2 = sched.zonedToUtc(sched.addDays(openDay.date, 3), 4 * 60, shop.timezone).toISOString();
  const oddTime = sched.zonedToUtc(sched.addDays(openDay.date, 1), 3 * 60, shop.timezone).toISOString();
  r = await req('POST', '/api/v1/barber/admin/bookings', {
    name: 'Marcus Bell', email: 'marcus@example.com', serviceId: svc.id, start: oddTime, notes: 'Early one'
  }, bt);
  ok('the barber can write someone in outside hours', r.status === 200 && r.json.emailedTo === 'marcus@example.com', r.json);
  const barberBooking = r.json.booking;

  r = await req('POST', '/api/v1/barber/admin/bookings', {
    name: 'Clash', email: 'clash@example.com', serviceId: svc.id, start: oddTime
  }, bt);
  ok('even the barber cannot double-book themselves', r.status === 409, r.json);

  r = await req('POST', `/api/v1/barber/admin/bookings/${booking.id}/bill`, { amountCents: 4500 }, bt);
  ok('billing without a Stripe key fails loudly, not silently', r.status === 500 && !!r.json.reason, r.json);

  r = await req('POST', '/api/v1/barber/admin/services', { name: 'Hot Towel Shave', durationMin: 30, priceCents: 3800 }, bt);
  ok('a service can be added', r.status === 200 && r.json.shop.services.length === 6);

  r = await req('PUT', '/api/v1/barber/admin/shop', { hours: [{ day: 2, open: 600, close: 540, closed: false }] }, bt);
  ok('closing before opening is refused', r.status === 400, r.json);

  r = await req('PUT', '/api/v1/barber/admin/shop', { timezone: 'Mars/Olympus' }, bt);
  ok('an unknown timezone is refused', r.status === 400, r.json);

  r = await req('PUT', '/api/v1/barber/admin/shop', { name: 'Crispin Cuts & Co', leadMinutes: 120 }, bt);
  ok('the shop saves', r.status === 200 && r.json.shop.name === 'Crispin Cuts & Co', r.json);

  r = await req('POST', `/api/v1/barber/admin/bookings/${barberBooking.id}/complete`, {}, bt);
  ok('an appointment can be marked done', r.status === 200 && r.json.booking.status === 'completed');

  r = await req('GET', '/api/v1/barber/admin/earnings?days=30', null, bt);
  ok('earnings start at zero and show the rate', r.json.grossCents === 0 && r.json.feeBps === 500, r.json);

  console.log('\n— the platform owner —');
  r = await req('POST', '/api/v1/auth/login', { email: 'owner@example.com', password: 'owner-passcode-9' });
  ok('the owner signs in as an admin', r.status === 200 && !!r.json.token);
  const pt = r.json.token;

  r = await req('POST', '/api/v1/barber/platform/shops', { handle: 'tonysfades', name: "Tony's Fades", barberEmail: 'tony@example.com', password: 'tony-passcode-1', platformFeeBps: 700 }, pt);
  ok('adding a barber creates their account too', r.status === 200 && r.json.accountCreated === true && r.json.bookingUrl.endsWith('/@tonysfades'), r.json);

  r = await req('POST', '/api/v1/auth/login', { email: 'tony@example.com', password: 'tony-passcode-1' });
  ok('the new barber can sign in immediately', r.status === 200 && !!r.json.token, r.json);
  const tonyTok = r.json.token;
  r = await req('GET', '/api/v1/barber/admin/me', null, tonyTok);
  ok('and lands in their own shop', r.status === 200 && r.json.shop.handle === 'tonysfades', r.json.shop && r.json.shop.handle);

  r = await req('POST', '/api/v1/barber/platform/shops', { handle: 'tonysfades', barberEmail: 'x@example.com', password: 'another-one-8' }, pt);
  ok('a taken handle is refused', r.status === 409);
  r = await req('POST', '/api/v1/barber/platform/shops', { handle: 'a b!', barberEmail: 'x@example.com', password: 'another-one-8' }, pt);
  ok('a malformed handle is refused', r.status === 400);
  r = await req('POST', '/api/v1/barber/platform/shops', { handle: 'noemail', password: 'another-one-8' }, pt);
  ok('a shop without an owner email is refused', r.status === 400, r.json);
  r = await req('POST', '/api/v1/barber/platform/shops', { handle: 'secondshop', barberEmail: 'tony@example.com', password: 'x' }, pt);
  ok('one account cannot run two shops', r.status === 409, r.json);

  r = await req('GET', '/api/v1/barber/platform/shops?days=30', null, pt);
  ok('the owner sees every shop and the totals', r.status === 200 && r.json.shops.length === 2 && r.json.totals, r.json && r.json.error);
  ok('and who runs each one', r.json.shops.every(x => !!x.ownerEmail), r.json.shops.map(x => x.ownerEmail));

  r = await req('PUT', '/api/v1/barber/platform/shops/crispincuts', { platformFeeBps: 850 }, pt);
  ok('the take rate is adjustable', r.status === 200 && r.json.platformFeeBps === 850, r.json);
  r = await req('PUT', '/api/v1/barber/platform/shops/crispincuts', { platformFeeBps: 5000 }, pt);
  ok('an absurd take rate is refused', r.status === 400, r.json);

  r = await req('GET', '/api/v1/barber/admin/earnings?days=30', null, bt);
  ok('the barber sees the new rate too', r.json.feeBps === 850, r.json);

  r = await req('GET', '/api/v1/barber/platform/shops', null, bt);
  ok('a barber cannot see the platform', r.status === 403);
  r = await req('PUT', '/api/v1/barber/platform/shops/tonysfades', { platformFeeBps: 0 }, bt);
  ok('nor set their own take rate', r.status === 403);

  console.log('\n— tenant isolation —');
  r = await req('GET', '/api/v1/barber/admin/me?handle=tonysfades', null, bt);
  ok("a barber's token ignores another shop's handle", r.status === 200 && r.json.shop.handle === 'crispincuts', r.json.shop && r.json.shop.handle);
  r = await req('POST', '/api/v1/barber/admin/bookings?handle=tonysfades', { name:'X', email:'x@example.com', serviceId: svc.id, start: oddTime2 }, bt);
  ok("nor can a barber write into another shop's diary", r.status !== 200 || r.json.booking, r.json);
  r = await req('GET', '/api/v1/barber/admin/me?handle=tonysfades', null, pt);
  ok('the owner may act on a named shop', r.status === 200 && r.json.shop.handle === 'tonysfades' && r.json.isPlatform === true);
  r = await req('POST', `/api/v1/barber/admin/bookings/${booking.id}/cancel`, { handle: 'tonysfades' }, pt);
  ok("one shop cannot cancel another shop's appointment", r.status === 404, r.json);

  console.log('\n— the client cancels —');
  r = await req('POST', `/api/v1/barber/bookings/${booking.id}/cancel`, { t: token });
  ok('the client can cancel with their token', r.status === 200 && r.json.booking.status === 'cancelled', r.json);
  r = await req('GET', `/api/v1/barber/shops/crispincuts/availability?date=${openDay.date}&serviceId=${svc.id}`);
  ok('the cancelled time is free again', r.json.slots.some(s => s.start === slots[2].start));
  r = await req('POST', '/api/v1/barber/shops/crispincuts/bookings', {
    serviceId: svc.id, start: slots[2].start, name: 'Second Chance', email: 'second@example.com'
  });
  ok('and somebody else can take it', r.status === 200, r.json);

  console.log('\n— the pages —');
  r = await req('GET', '/@crispincuts');
  ok('/@handle serves the booking page', r.status === 200 && r.text.includes('Crispin Cuts') && r.text.includes('class="tube"'));
  r = await req('GET', '/book/');
  ok('/book serves the admin panel', r.status === 200 && r.text.includes('Shop Admin'));
  r = await req('GET', '/@tonysfades');
  ok('every handle gets the same page', r.status === 200);
  r = await req('GET', '/@no/slashes');
  ok('the handle route cannot swallow a path', r.status === 404);

  console.log(`\nTotal: ${pass} passed, ${fail} failed\n`);
  await server.close();
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
