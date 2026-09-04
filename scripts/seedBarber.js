/**
 * Give a shop an owner.
 *
 * The barber signs in with an ordinary account on this platform, so setting one
 * up is: create (or find) the user, mark them a barber, and point the shop at
 * them. After this runs there is nothing shop-specific about their credentials
 * — they reset their password and change their email the same way everyone else
 * does.
 *
 * The password is never read from a file in this repo. Pass it, or set it:
 *
 *   node scripts/seedBarber.js --email crispin@admin.com --password '…'
 *   BARBER_SEED_PASSWORD='…' node scripts/seedBarber.js --email crispin@admin.com
 *
 * Options:
 *   --email     the barber's sign-in address (required)
 *   --password  their password, 8+ characters (required for a NEW account;
 *               ignored when the account already exists)
 *   --handle    which shop (default: BARBER_HANDLE, or crispincuts)
 *   --name      shop name, when the shop is being created
 *
 * Requires MONGODB_URI. Safe to re-run: it links, it does not duplicate.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : fallback;
}

(async () => {
  const email = String(arg('email', '') || '').trim().toLowerCase();
  const password = String(arg('password', process.env.BARBER_SEED_PASSWORD || ''));
  const handle = String(arg('handle', process.env.BARBER_HANDLE || 'crispincuts')).replace(/^@/, '').toLowerCase();
  const name = arg('name', null);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    console.error('An --email is required.');
    process.exit(1);
  }
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set — nothing to write to.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  const User = require('../models/User');
  const BarberShop = require('../models/BarberShop');

  let user = await User.findOne({ email });
  if (user) {
    // Never demote an admin: the person running the platform may also cut hair,
    // and taking their admin role would lock them out of the platform panel.
    if (user.role === 'user') { user.role = 'barber'; await user.save(); }
    console.log(`Account found: ${email} (role: ${user.role}) — password left alone.`);
  } else {
    if (password.length < 8) {
      console.error('That account does not exist yet, so --password (8+ characters) is required.');
      process.exit(1);
    }
    user = await User.create({
      email,
      passwordHash: await bcrypt.hash(password, 10),
      role: 'barber',
      firstName: (name || 'Barber').split(' ')[0]
    });
    console.log(`Account created: ${email}`);
  }

  const shop = await BarberShop.load(handle);
  const held = await BarberShop.findOne({ ownerUserId: user._id, handle: { $ne: shop.handle } });
  if (held) {
    console.error(`That account already runs @${held.handle}. One shop per account.`);
    process.exit(1);
  }
  if (name) shop.name = String(name).slice(0, 80);
  if (!shop.barberEmail) shop.barberEmail = email;
  shop.ownerUserId = user._id;
  shop.updatedAt = new Date();
  await shop.save();

  console.log(`@${shop.handle} → ${shop.name}, run by ${email}`);
  console.log(`Booking page: /@${shop.handle}`);
  console.log('Panel: /barber-admin (or /book on the API host)');

  await mongoose.disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
