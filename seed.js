/**
 * seed.js — make the barber platform usable on a fresh database.
 *
 * Three things, each idempotent, each safe to re-run:
 *   1. the shop exists (seeded with a working menu and a real week of hours)
 *   2. a barber account exists and owns it
 *   3. optionally, somebody is an admin, so the platform panel has an owner
 *
 * There is no shop-specific credential to set: a barber is an ordinary account
 * on this platform with role 'barber'. This script creates or promotes that
 * account and points the shop at it. Afterwards they change their password and
 * their email the same way every other member does.
 *
 *   MONGODB_URI=…  BARBER_SEED_PASSWORD='…'  node seed.js
 *   node seed.js --email crispin@admin.com --password '…' --name 'Crispin Cuts'
 *   node seed.js --admin you@yourcompany.com          # make yourself platform owner
 *
 * The password is read from the environment or the command line and never from
 * a file in this repo — a real password committed to git outlives every place
 * you remember putting it.
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
const bcrypt = require('bcryptjs');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Create the account, or adopt the one that is already there. */
async function ensureBarberAccount(User, email, password, firstName) {
  const existing = await User.findOne({ email });
  if (existing) {
    // Never demote an admin. The person running the platform may also cut
    // hair, and taking their admin role would lock them out of the panel that
    // sets the take rate.
    if (existing.role === 'user') {
      existing.role = 'barber';
      await existing.save();
      return { user: existing, note: 'existing account promoted to barber' };
    }
    return { user: existing, note: `existing account left as ${existing.role}` };
  }
  if (String(password).length < 8) {
    throw new Error(
      `No account for ${email} yet, so a password is required (8+ characters).\n` +
      `  BARBER_SEED_PASSWORD='…' node seed.js   — or   node seed.js --password '…'`
    );
  }
  const user = await User.create({
    email,
    passwordHash: await bcrypt.hash(password, 10),
    role: 'barber',
    firstName
  });
  return { user, note: 'account created' };
}

async function main() {
  const email = String(arg('email', 'crispin@admin.com')).trim().toLowerCase();
  const password = String(arg('password', process.env.BARBER_SEED_PASSWORD || ''));
  const handle = String(arg('handle', process.env.BARBER_HANDLE || 'crispincuts')).replace(/^@/, '').toLowerCase();
  const shopName = arg('name', 'Crispin Cuts');
  const adminEmail = String(arg('admin', '')).trim().toLowerCase();

  if (!EMAIL_RE.test(email)) throw new Error(`Not an email address: ${email}`);
  if (adminEmail && !EMAIL_RE.test(adminEmail)) throw new Error(`Not an email address: ${adminEmail}`);
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set — there is nothing to write to.');

  await mongoose.connect(process.env.MONGODB_URI);
  const User = require('./models/User');
  const BarberShop = require('./models/BarberShop');

  // 1. The shop. load() seeds the menu and the week on first call.
  const shop = await BarberShop.load(handle);
  const isNewShop = !shop.ownerUserId;
  if (shopName) shop.name = String(shopName).slice(0, 80);

  // 2. Its barber.
  const { user, note } = await ensureBarberAccount(User, email, password, String(shopName || 'Barber').split(' ')[0]);

  const elsewhere = await BarberShop.findOne({ ownerUserId: user._id, handle: { $ne: shop.handle } });
  if (elsewhere) throw new Error(`${email} already runs @${elsewhere.handle}. One shop per account.`);

  shop.ownerUserId = user._id;
  if (!shop.barberEmail) shop.barberEmail = email;   // where booking alerts land
  shop.updatedAt = new Date();
  await shop.save();

  // 3. Somebody to run the platform, if asked.
  let adminNote = null;
  if (adminEmail) {
    const owner = await User.findOne({ email: adminEmail });
    if (!owner) adminNote = `no account for ${adminEmail} — sign up first, then re-run with --admin`;
    else if (owner.role === 'admin') adminNote = `${adminEmail} was already an admin`;
    else { owner.role = 'admin'; await owner.save(); adminNote = `${adminEmail} is now a platform owner`; }
  }

  const site = String(process.env.BOOKING_SITE_URL || 'https://www.theclockworkhub.com').replace(/\/+$/, '');
  console.log('');
  console.log(`  Shop      @${shop.handle} — ${shop.name}${isNewShop ? '' : ' (already existed)'}`);
  console.log(`  Barber    ${email} — ${note}`);
  console.log(`  Alerts    ${shop.barberEmail}`);
  console.log(`  Menu      ${(shop.services || []).filter(s => s.active).length} services, ${(shop.hours || []).filter(h => !h.closed).length} days open`);
  console.log(`  Fee       ${(shop.platformFeeBps / 100).toFixed(2)}% to the platform`);
  if (adminNote) console.log(`  Platform  ${adminNote}`);
  console.log('');
  console.log(`  Booking   ${site}/@${shop.handle}`);
  console.log(`  Panel     ${site}/barber-admin`);
  console.log('');
  console.log('  They sign in with that email and password. Tell them to change');
  console.log('  the password from the panel once they are in.');
  console.log('');

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('\n  ' + e.message + '\n');
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
