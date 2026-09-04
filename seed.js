/**
 * seed.js — make the barber platform usable on a fresh database.
 *
 * Usually you do not need this: set BARBER_SEED_PASSWORD in the deploy's
 * variables and the server does the same work at boot. This is the same
 * operation by hand, for a one-off, a different shop, or a local database.
 *
 *   MONGODB_URI=…  node seed.js --email crispin@admin.com --password '…'
 *   node seed.js --admin you@example.com          # also promote a platform owner
 *
 * Idempotent: it creates the account if there isn't one, adopts it if there is,
 * and never touches an existing password.
 *
 * Options (all optional except a password for a NEW account):
 *   --email     the barber's sign-in address   (default crispin@admin.com)
 *   --password  8+ characters; ignored if that account already exists
 *   --handle    which shop                     (default BARBER_HANDLE, or crispincuts)
 *   --name      the shop's display name        (default Crispin Cuts)
 *   --admin     an email to promote to platform owner
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { seedBarber } = require('./services/barberSeed');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set — there is nothing to write to.');
  await mongoose.connect(process.env.MONGODB_URI);

  const r = await seedBarber({
    email: arg('email', 'crispin@admin.com'),
    password: arg('password', process.env.BARBER_SEED_PASSWORD || ''),
    handle: arg('handle', process.env.BARBER_HANDLE || 'crispincuts'),
    name: arg('name', 'Crispin Cuts'),
    adminEmail: arg('admin', '')
  });

  const site = String(process.env.BOOKING_SITE_URL || 'https://www.theclockworkhub.com').replace(/\/+$/, '');
  console.log('');
  if (r.quotesStripped) console.log('  Note      your password was wrapped in quotes — the quotes were stripped.\n');
  console.log(`  Shop      @${r.handle} — ${r.shopName}${r.wasOwned ? ' (already had an owner)' : ''}`);
  console.log(`  Barber    ${r.email} — ${r.accountNote}`);
  console.log(`  Alerts    ${r.alertEmail}`);
  console.log(`  Menu      ${r.services} services, ${r.daysOpen} days open`);
  console.log(`  Fee       ${(r.feeBps / 100).toFixed(2)}% to the platform`);
  if (r.adminNote) console.log(`  Platform  ${r.adminNote}`);
  console.log('');
  console.log(`  Booking   ${site}/@${r.handle}`);
  console.log(`  Panel     ${site}/barber-admin`);
  console.log('');

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('\n  ' + e.message);
  if (e.needsPassword) console.error("  BARBER_SEED_PASSWORD='…' node seed.js   — or   node seed.js --password '…'");
  console.error('');
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
