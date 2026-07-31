/**
 * Did anyone try to buy something and not get it?
 *
 * Reads the ShopOrder collection rather than Railway logs. Logs age out and are
 * hard to search; orders are persisted with a status and the exact error, so
 * this is both the more complete and the more durable answer.
 *
 * Statuses (models/ShopOrder):
 *   started    checkout opened, never paid        → abandoned cart, no money taken
 *   paid       Stripe captured, fulfillment not finished
 *   submitted  reached Printful, printing         → healthy
 *   draft      PAID BUT NOT SENT                  → money taken, nothing shipped
 *   failed     explicit failure
 *
 * 'draft' and 'paid' are the ones that matter: the customer has been charged
 * and has a receipt, and nothing is being printed.
 *
 * Usage:
 *   MONGODB_URI=… node scripts/checkOrders.js          # last 4 days
 *   MONGODB_URI=… node scripts/checkOrders.js --days=30
 *   MONGODB_URI=… node scripts/checkOrders.js --days=30 --all
 */

require('dotenv').config();
const mongoose = require('mongoose');

const arg = (n, d) => {
  const a = process.argv.find(x => x.startsWith(`--${n}=`));
  return a ? a.split('=')[1] : d;
};
const DAYS = parseInt(arg('days', '4'), 10);
const ALL = process.argv.includes('--all');
const money = (c) => '$' + (Number(c || 0) / 100).toFixed(2);

(async () => {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set. Copy it from Railway → your service → Variables.');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  const ShopOrder = require('../models/ShopOrder');

  const since = new Date(Date.now() - DAYS * 86400000);
  const rows = await ShopOrder.find({ createdAt: { $gte: since } }).sort({ createdAt: -1 }).lean();

  console.log(`\nShop orders since ${since.toISOString().slice(0, 16).replace('T', ' ')} (${DAYS} days)`);
  console.log(`${rows.length} order record(s)\n`);

  if (!rows.length) {
    const ever = await ShopOrder.countDocuments({});
    console.log(ever
      ? `Nothing in this window. ${ever} order(s) exist all-time — widen with --days=90.`
      : 'No shop orders have ever been created. Nobody has reached checkout yet.');
    await mongoose.disconnect();
    return;
  }

  const by = rows.reduce((m, o) => { m[o.status] = (m[o.status] || 0) + 1; return m; }, {});
  for (const [s, n] of Object.entries(by)) console.log(`  ${String(n).padStart(3)}  ${s}`);

  // The money question, answered plainly.
  const stuck = rows.filter(o => o.status === 'draft' || o.status === 'failed' || o.status === 'paid');
  const paidCents = stuck.reduce((t, o) => t + (o.amountTotal || 0), 0);

  console.log('\n' + '─'.repeat(70));
  if (!stuck.length) {
    console.log('No paid order failed to reach Printful in this window.');
  } else {
    console.log(`${stuck.length} PAID ORDER(S) NOT CONFIRMED AS PRINTING — ${money(paidCents)} taken\n`);
    for (const o of stuck) {
      console.log(`  ${new Date(o.createdAt).toISOString().slice(0, 16).replace('T', ' ')}  ${o.status.toUpperCase()}  ${money(o.amountTotal)}`);
      console.log(`     order ${o._id}   ${o.email || 'no email'}`);
      if (o.items && o.items.length) console.log(`     ${o.items.map(i => `${i.sku} x${i.quantity}`).join(', ')}`);
      if (o.recipient) console.log(`     ship to ${[o.recipient.name, o.recipient.city, o.recipient.state_code, o.recipient.country_code].filter(Boolean).join(', ')}`);
      if (o.error) console.log(`     REASON: ${o.error}`);
      if (o.stripeSessionId) console.log(`     stripe ${o.stripeSessionId}`);
      console.log('');
    }
    console.log('Each of these is a customer with a receipt and no parcel. Either submit');
    console.log('the order in Printful by hand, or refund it.');
  }

  const abandoned = rows.filter(o => o.status === 'started');
  if (abandoned.length) {
    console.log('─'.repeat(70));
    console.log(`${abandoned.length} abandoned checkout(s) — opened, never paid. No money taken.`);
  }

  if (ALL) {
    console.log('\n' + '─'.repeat(70) + '\nAll records:');
    for (const o of rows) {
      console.log(`  ${new Date(o.createdAt).toISOString().slice(0, 16).replace('T', ' ')}  ${o.status.padEnd(9)} ${money(o.amountTotal).padStart(8)}  ${o.email || '—'}  ${o.printfulOrderId ? 'pf:' + o.printfulOrderId : ''}`);
    }
  }

  console.log('');
  await mongoose.disconnect();
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
