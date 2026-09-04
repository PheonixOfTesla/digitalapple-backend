/**
 * Barber booking tests — the arithmetic a booking site cannot get wrong.
 *
 * Pure functions only: no database, no network, no clock of its own. Every
 * "now" is passed in, which is what lets these tests stand inside the hour that
 * does not exist in March and check what the shop offers.
 *
 * Run: node tests/barberBooking.test.js
 */
const assert = require('assert');
const sched = require('../services/barberSchedule');

const NY = 'America/New_York';
const results = [];
function check(id, name, fn) {
  try { fn(); results.push({ id, name, passed: true }); }
  catch (e) { results.push({ id, name, passed: false, why: e.message }); }
}

const shop = {
  timezone: NY, slotStepMin: 15, leadMinutes: 60, closures: [],
  hours: [
    { day: 0, open: 0, close: 0, closed: true },              // Sunday shut
    { day: 1, open: 600, close: 1020, closed: false },
    { day: 2, open: 540, close: 1080, closed: false },
    { day: 3, open: 540, close: 1080, closed: false },
    { day: 4, open: 540, close: 1080, closed: false },
    { day: 5, open: 540, close: 1140, closed: false },
    { day: 6, open: 480, close: 960, closed: false }
  ]
};
const far = new Date('2026-01-01T00:00:00Z');   // long before every test date

/* ── Timezone ─────────────────────────────────────────────────────────── */

check('T1', 'Summer wall-clock resolves to EDT (UTC-4)', () => {
  assert.strictEqual(sched.zonedToUtc('2026-07-16', 14 * 60 + 30, NY).toISOString(), '2026-07-16T18:30:00.000Z');
});

check('T2', 'Winter wall-clock resolves to EST (UTC-5)', () => {
  assert.strictEqual(sched.zonedToUtc('2026-01-15', 14 * 60 + 30, NY).toISOString(), '2026-01-15T19:30:00.000Z');
});

check('T3', 'Nine in the morning is nine all year — March 7 and March 9', () => {
  const before = sched.zonedToUtc('2026-03-07', 9 * 60, NY);   // EST
  const after = sched.zonedToUtc('2026-03-09', 9 * 60, NY);    // EDT
  assert.strictEqual(sched.timeLabel(before, NY), '9:00 AM');
  assert.strictEqual(sched.timeLabel(after, NY), '9:00 AM');
  // ...which are different UTC instants. That is the whole point.
  assert.notStrictEqual(before.toISOString().slice(11, 16), after.toISOString().slice(11, 16));
});

check('T4', 'A day label is the shop\'s day, not the reader\'s', () => {
  // 11pm in New York on the 15th is the 16th in UTC. The shop says the 15th.
  const late = new Date('2026-07-16T03:30:00.000Z');
  assert.strictEqual(sched.dayKey(late, NY), '2026-07-15');
});

/* ── Slots ────────────────────────────────────────────────────────────── */

check('T5', 'Closed day offers nothing', () => {
  assert.strictEqual(sched.buildSlots({ dateStr: '2026-07-19', shop, durationMin: 45, now: far }).length, 0);
});

check('T6', 'Slots start at opening and stop so the cut finishes by closing', () => {
  const slots = sched.buildSlots({ dateStr: '2026-07-16', shop, durationMin: 45, now: far }); // Thursday 9–6
  assert.strictEqual(slots[0].label, '9:00 AM');
  assert.strictEqual(slots[slots.length - 1].label, '5:15 PM');   // 5:15 + 45 = 6:00 exactly
  assert.strictEqual(slots.length, ((1080 - 540) - 45) / 15 + 1);
});

check('T7', 'A longer service gets fewer slots and ends earlier', () => {
  const short = sched.buildSlots({ dateStr: '2026-07-16', shop, durationMin: 20, now: far });
  const long = sched.buildSlots({ dateStr: '2026-07-16', shop, durationMin: 120, now: far });
  assert.ok(long.length < short.length);
  assert.strictEqual(long[long.length - 1].label, '4:00 PM');
});

check('T8', 'A booking blanks out every slot it overlaps, not just its own', () => {
  const busy = [{
    startsAt: sched.zonedToUtc('2026-07-16', 10 * 60, NY),      // 10:00
    endsAt: sched.zonedToUtc('2026-07-16', 10 * 60 + 45, NY)    // 10:45
  }];
  const labels = sched.buildSlots({ dateStr: '2026-07-16', shop, durationMin: 45, bookings: busy, now: far })
    .map(s => s.label);
  // A 45-minute cut starting anywhere from 9:30 to 10:30 runs into it.
  ['9:30 AM', '9:45 AM', '10:00 AM', '10:15 AM', '10:30 AM']
    .forEach(l => assert.ok(!labels.includes(l), l + ' should be gone'));
  assert.ok(labels.includes('9:15 AM'), '9:15 finishes exactly at 10:00 — still free');
  assert.ok(labels.includes('10:45 AM'), '10:45 starts as the chair empties');
});

check('T9', 'Lead time hides the next hour and nothing beyond it', () => {
  const now = sched.zonedToUtc('2026-07-16', 10 * 60, NY);      // 10:00 in the shop
  const labels = sched.buildSlots({ dateStr: '2026-07-16', shop, durationMin: 30, now })
    .map(s => s.label);
  assert.ok(!labels.includes('10:30 AM'), 'inside the hour of notice');
  assert.ok(labels.includes('11:00 AM'), 'exactly an hour out is fair game');
});

check('T10', 'A one-off closure closes the day', () => {
  const closed = Object.assign({}, shop, { closures: ['2026-07-16'] });
  assert.strictEqual(sched.buildSlots({ dateStr: '2026-07-16', shop: closed, durationMin: 30, now: far }).length, 0);
});

check('T11', 'Spring forward: every offered slot is a real, distinct instant', () => {
  // 2026-03-08, clocks jump 2am → 3am in New York.
  const sunday = Object.assign({}, shop, {
    hours: shop.hours.map(h => h.day === 0 ? { day: 0, open: 60, close: 360, closed: false } : h)
  });
  const slots = sched.buildSlots({ dateStr: '2026-03-08', shop: sunday, durationMin: 30, now: far });
  const iso = slots.map(s => s.start);
  assert.strictEqual(new Set(iso).size, iso.length, 'no two slots may be the same instant');
  // Every slot round-trips to the label it was offered as.
  slots.forEach(s => assert.strictEqual(sched.timeLabel(new Date(s.start), NY), s.label));
  assert.ok(!slots.some(s => s.label.startsWith('2:')), '2am does not exist that day');
});

check('T12', 'Fall back: the repeated hour is not double-booked', () => {
  // 2026-11-01, 2am happens twice in New York.
  const sunday = Object.assign({}, shop, {
    hours: shop.hours.map(h => h.day === 0 ? { day: 0, open: 0, close: 360, closed: false } : h)
  });
  const slots = sched.buildSlots({ dateStr: '2026-11-01', shop: sunday, durationMin: 30, now: far });
  const iso = slots.map(s => s.start);
  assert.strictEqual(new Set(iso).size, iso.length, 'each instant offered once');
  const labels = slots.map(s => s.label);
  assert.strictEqual(new Set(labels).size, labels.length, 'each wall-clock offered once');
});

check('T13', 'Overlap is half-open: back-to-back appointments do not collide', () => {
  const a = sched.zonedToUtc('2026-07-16', 600, NY), aEnd = sched.zonedToUtc('2026-07-16', 645, NY);
  const b = aEnd, bEnd = sched.zonedToUtc('2026-07-16', 690, NY);
  assert.strictEqual(sched.overlaps(a, aEnd, b, bEnd), false);
  assert.strictEqual(sched.overlaps(a, aEnd, sched.zonedToUtc('2026-07-16', 644, NY), bEnd), true);
});

check('T14', 'addDays walks the calendar across a DST boundary', () => {
  assert.strictEqual(sched.addDays('2026-03-07', 1), '2026-03-08');
  assert.strictEqual(sched.addDays('2026-03-08', 1), '2026-03-09');
  assert.strictEqual(sched.addDays('2026-12-31', 1), '2027-01-01');
});

check('T15', 'Garbage dates are refused rather than guessed at', () => {
  assert.strictEqual(sched.buildSlots({ dateStr: 'tomorrow', shop, durationMin: 30, now: far }).length, 0);
  assert.strictEqual(sched.isDateStr('2026-7-16'), false);
  assert.strictEqual(sched.isDateStr('2026-07-16'), true);
});

/* ── The platform's cut ───────────────────────────────────────────────── */

check('T16', 'The fee is a percentage, rounded to the cent', () => {
  const BarberShop = require('../models/BarberShop');
  const s = new BarberShop({ handle: 'x', platformFeeBps: 500 });
  assert.strictEqual(s.feeOn(4500), 225);      // 5% of $45
  assert.strictEqual(s.feeOn(3333), 167);      // rounds, never truncates to zero
  assert.strictEqual(s.feeOn(0), 0);
});

check('T17', 'A zero rate takes nothing; the cap holds at 30%', () => {
  const BarberShop = require('../models/BarberShop');
  assert.strictEqual(new BarberShop({ handle: 'x', platformFeeBps: 0 }).feeOn(5000), 0);
  assert.strictEqual(new BarberShop({ handle: 'x', platformFeeBps: 3000 }).feeOn(5000), 1500);
  // Above the cap the model refuses to save; the helper still cannot overtake.
  const wild = new BarberShop({ handle: 'x' });
  wild.platformFeeBps = 99999;
  assert.ok(wild.feeOn(5000) <= 5000);
  assert.strictEqual(wild.validateSync().errors.platformFeeBps.kind, 'max');
});

check('T18', 'The fee never exceeds the amount charged', () => {
  const BarberShop = require('../models/BarberShop');
  const s = new BarberShop({ handle: 'x', platformFeeBps: 3000 });
  [50, 51, 99, 100, 12345].forEach(a => assert.ok(s.feeOn(a) <= a, 'fee > amount at ' + a));
});

/* ── Report ───────────────────────────────────────────────────────────── */
console.log('\nBarber booking — unit tests\n');
let pass = 0, fail = 0;
for (const r of results) {
  if (r.passed) { pass++; console.log(`  ${r.id}: ${r.name} - PASS`); }
  else { fail++; console.log(`  ${r.id}: ${r.name} - FAIL\n       ${r.why}`); }
}
console.log(`\nTotal: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
