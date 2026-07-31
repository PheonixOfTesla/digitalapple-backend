/**
 * referrals — who invited whom.
 *
 * DESIGN: the handle is the referral token. There is no separate code to mint,
 * store, expire, or leak, and the link people already share
 * (theclockworkhub.com/<handle>) is the attributed link. Users who haven't
 * claimed a handle fall back to their id, so everyone has a working invite from
 * the moment they sign up.
 *
 * Attribution is set ONCE, at signup, and never rewritten — see the guard in
 * AuthController. That matters because this is the number product decisions get
 * made on: a field that can be updated later is a field that drifts.
 */

const mongoose = require('mongoose');

const HANDLE_RE = /^[a-z0-9._-]{3,30}$/;

/**
 * Resolve a referral token to the inviting user, or null.
 * Accepts a handle or a raw ObjectId. Never throws on junk input — a bad token
 * in a URL is an ordinary event, not an error.
 */
async function resolveReferrer(token) {
  const User = require('../models/User');
  const raw = String(token || '').trim().toLowerCase();
  if (!raw) return null;

  // Strip a leading @ and anything that looks like a path or query fragment,
  // so a pasted "@josh" or "/itssjoshl" still resolves.
  const t = raw.replace(/^@+/, '').split(/[/?#]/)[0];
  if (!t) return null;

  if (HANDLE_RE.test(t)) {
    const byHandle = await User.findOne({ handle: t }).select('_id firstName lastName handle profilePhoto').lean();
    if (byHandle) return byHandle;
  }
  if (mongoose.Types.ObjectId.isValid(t)) {
    return User.findById(t).select('_id firstName lastName handle profilePhoto').lean();
  }
  return null;
}

/** The public shape of an inviter — enough to say "X invited you", no more. */
function publicReferrer(u) {
  if (!u) return null;
  return {
    id: String(u._id),
    name: [u.firstName, u.lastName].filter(Boolean).join(' ') || 'A member',
    handle: u.handle || null,
    avatar: u.profilePhoto || null
  };
}

/** The invite link for a user — vanity when they have a handle, id when not. */
function inviteUrlFor(u, origin = 'https://theclockworkhub.com') {
  if (!u) return origin;
  return u.handle ? `${origin}/${u.handle}` : `${origin}/invite/${u._id}`;
}

module.exports = { resolveReferrer, publicReferrer, inviteUrlFor, HANDLE_RE };
