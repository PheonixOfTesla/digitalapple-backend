/**
 * Seeding a barber — one implementation, two callers.
 *
 * `node seed.js` runs it by hand; the server runs it at boot when
 * BARBER_SEED_PASSWORD is set, so putting the password in the deploy's
 * variables IS the setup step and there is no command to remember. It is
 * idempotent by construction: it creates the account if there isn't one, adopts
 * it if there is, and never touches an existing password — so the variable can
 * be left in place forever without it ever resetting anybody's login.
 */
const bcrypt = require('bcryptjs');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Strip one layer of matching quotes.
 *
 * A shell eats the quotes in BARBER_SEED_PASSWORD='hunter2'; a deploy
 * dashboard's variable box does not, and stores the apostrophes as part of the
 * password. The failure is invisible and lands weeks later as "my password
 * doesn't work" with nothing in any log to explain it. A password is not
 * allowed to begin and end with a quote, so taking them off is safe and
 * removes the trap.
 */
function unquote(v) {
  const s = String(v == null ? '' : v).trim();
  const m = s.match(/^(['"])([\s\S]*)\1$/);
  return m ? m[2] : s;
}

/** Create the account, or adopt the one already there. Never resets a password. */
async function ensureAccount(User, email, password, firstName) {
  const existing = await User.findOne({ email });
  if (existing) {
    // Never demote an admin: the person running the platform may also cut
    // hair, and taking their role would lock them out of the platform panel.
    if (existing.role === 'user') {
      existing.role = 'barber';
      await existing.save();
      return { user: existing, note: 'existing account promoted to barber' };
    }
    return { user: existing, note: `existing account left as ${existing.role}` };
  }
  if (String(password).length < 8) {
    const e = new Error(`No account for ${email} yet, so a password of 8+ characters is required.`);
    e.needsPassword = true;
    throw e;
  }
  const user = await User.create({
    email,
    passwordHash: await bcrypt.hash(password, 10),
    role: 'barber',
    firstName
  });
  return { user, note: 'account created' };
}

/**
 * Make the platform usable: the shop exists, an account owns it, and
 * optionally somebody is an admin. Returns what happened, for the caller to
 * print however it likes.
 */
async function seedBarber(opts) {
  const o = opts || {};
  const email = unquote(o.email).toLowerCase();
  const password = unquote(o.password);
  const handle = unquote(o.handle).replace(/^@/, '').toLowerCase() || 'crispincuts';
  const name = unquote(o.name) || 'Crispin Cuts';
  const adminEmail = unquote(o.adminEmail).toLowerCase();

  if (!EMAIL_RE.test(email)) throw new Error(`Not an email address: ${email}`);
  if (adminEmail && !EMAIL_RE.test(adminEmail)) throw new Error(`Not an email address: ${adminEmail}`);

  const User = require('../models/User');
  const BarberShop = require('../models/BarberShop');

  const shop = await BarberShop.load(handle);
  const wasOwned = !!shop.ownerUserId;
  if (name) shop.name = name.slice(0, 80);

  // Bring an existing shop in line with the configured default rate, unless a
  // human has set that shop's rate in the panel. Model defaults only apply to
  // documents being created, so without this a rate change reaches new shops
  // and quietly misses every shop already open.
  let feeNote = null;
  const wantFee = o.feeBps == null ? null : Math.min(3000, Math.max(0, parseInt(o.feeBps, 10)));
  if (wantFee != null && !shop.feeSetManually && shop.platformFeeBps !== wantFee) {
    feeNote = `rate ${(shop.platformFeeBps / 100).toFixed(2)}% → ${(wantFee / 100).toFixed(2)}%`;
    shop.platformFeeBps = wantFee;
  }

  const { user, note } = await ensureAccount(User, email, password, name.split(' ')[0] || 'Barber');

  const elsewhere = await BarberShop.findOne({ ownerUserId: user._id, handle: { $ne: shop.handle } });
  if (elsewhere) throw new Error(`${email} already runs @${elsewhere.handle}. One shop per account.`);

  shop.ownerUserId = user._id;
  if (!shop.barberEmail) shop.barberEmail = email;    // where booking alerts land
  shop.updatedAt = new Date();
  await shop.save();

  let adminNote = null;
  if (adminEmail) {
    const owner = await User.findOne({ email: adminEmail });
    if (!owner) adminNote = `no account for ${adminEmail} yet — sign up, then set it again`;
    else if (owner.role === 'admin') adminNote = `${adminEmail} was already an admin`;
    else { owner.role = 'admin'; await owner.save(); adminNote = `${adminEmail} is now a platform owner`; }
  }

  return {
    handle: shop.handle,
    shopName: shop.name,
    email,
    alertEmail: shop.barberEmail,
    services: (shop.services || []).filter(s => s.active).length,
    daysOpen: (shop.hours || []).filter(h => !h.closed).length,
    feeBps: shop.platformFeeBps,
    wasOwned,
    accountNote: note,
    adminNote,
    feeNote,
    quotesStripped: unquote(o.password) !== String(o.password || '').trim()
  };
}

/**
 * The boot-time path. Never throws and never blocks the server: a seed that
 * cannot run is a log line, not a site that will not start.
 */
async function seedFromEnv() {
  // The RAW value goes through, so seedBarber is the one place that decides
  // what quoting means — and the one place that can report it.
  const raw = process.env.BARBER_SEED_PASSWORD || '';
  if (!unquote(raw)) return null;
  try {
    const r = await seedBarber({
      email: process.env.BARBER_SEED_EMAIL || 'crispin@admin.com',
      password: raw,
      handle: process.env.BARBER_HANDLE || 'crispincuts',
      name: process.env.BARBER_SHOP_NAME || 'Crispin Cuts',
      adminEmail: process.env.PLATFORM_ADMIN_EMAIL || '',
      feeBps: Number(process.env.BARBER_PLATFORM_FEE_BPS || 300)
    });
    if (r.quotesStripped) {
      console.log('[barber] BARBER_SEED_PASSWORD was wrapped in quotes — stripped them. The password is what is INSIDE the quotes.');
    }
    console.log(`[barber] @${r.handle} → ${r.shopName}, ${r.accountNote}: ${r.email}` + (r.wasOwned ? '' : ' (shop had no owner)'));
    if (r.feeNote) console.log('[barber] ' + r.feeNote);
    if (r.adminNote) console.log('[barber] ' + r.adminNote);
    return r;
  } catch (e) {
    console.error('[barber] seed skipped:', e.message);
    return null;
  }
}

module.exports = { seedBarber, seedFromEnv, unquote };
