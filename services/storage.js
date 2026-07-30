/**
 * storage.js — Clockwork Drive storage capacity.
 *
 * Every account gets FREE_BYTES of Drive storage. Past that, capacity is
 * bought with the tokens the account already uses for Blueprint, so there is
 * exactly one currency and one payment rail (Stripe -> tokens -> capacity)
 * rather than a second, parallel billing system.
 *
 * Usage is derived, never cached: it is the sum of DriveFile.size for the
 * owner. That means a delete frees space immediately and the number can't
 * drift out of sync with what's actually stored.
 *
 * Only files uploaded straight to Drive count. Chat attachments and Ticker
 * media surface in the Drive UI but are owned by those features, so charging
 * for them here would bill the same byte twice.
 */
const DriveFile = require('../models/DriveFile');

const GB = 1024 * 1024 * 1024;

// Free allowance per account.
const FREE_BYTES = 2 * GB;

// Hard ceiling for a single file, mirrored from the multer limit so the API
// and the uploader can never disagree about what "too large" means.
const MAX_FILE_BYTES = 100 * 1024 * 1024;

// Extra capacity, priced in existing tokens.
const TOKENS_PER_GB = 5;

/** Bytes this user currently occupies in Drive. */
async function usedBytes(userId) {
  const [row] = await DriveFile.aggregate([
    { $match: { ownerId: typeof userId === 'string' ? require('mongoose').Types.ObjectId.createFromHexString(userId) : userId } },
    { $group: { _id: null, total: { $sum: { $ifNull: ['$size', 0] } } } }
  ]);
  return (row && row.total) || 0;
}

/** Total capacity: the free allowance plus whatever the user has bought. */
function quotaBytes(user) {
  return FREE_BYTES + Math.max(0, (user && user.storageBonusBytes) || 0);
}

function fmt(bytes) {
  if (bytes >= GB) return (bytes / GB).toFixed(bytes % GB === 0 ? 0 : 1) + ' GB';
  if (bytes >= 1024 * 1024) return Math.round(bytes / (1024 * 1024)) + ' MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
  return bytes + ' B';
}

/** Everything the UI needs to draw a capacity meter. */
async function summary(user) {
  const used = await usedBytes(user._id || user.id || user);
  const quota = quotaBytes(user);
  const remaining = Math.max(0, quota - used);
  return {
    usedBytes: used,
    quotaBytes: quota,
    freeBytes: FREE_BYTES,
    bonusBytes: Math.max(0, (user && user.storageBonusBytes) || 0),
    remainingBytes: remaining,
    percentUsed: quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0,
    full: remaining <= 0,
    maxFileBytes: MAX_FILE_BYTES,
    used: fmt(used),
    quota: fmt(quota),
    remaining: fmt(remaining),
    tokensPerGb: TOKENS_PER_GB
  };
}

/**
 * Would `incoming` bytes fit? Returns null when it fits, or a ready-to-send
 * 402 body naming exactly how much is used, what's left, and the cost to
 * extend — so the client never has to guess why an upload was refused.
 */
function overQuota(incoming, used, quota) {
  if (used + incoming <= quota) return null;
  const shortfall = used + incoming - quota;
  return {
    error: 'Not enough Drive space',
    code: 'STORAGE_FULL',
    detail: `This file needs ${fmt(incoming)} but only ${fmt(Math.max(0, quota - used))} is left of your ${fmt(quota)}.`,
    usedBytes: used,
    quotaBytes: quota,
    fileBytes: incoming,
    shortfallBytes: shortfall,
    tokensPerGb: TOKENS_PER_GB,
    tokensToCover: Math.max(1, Math.ceil(shortfall / GB) * TOKENS_PER_GB)
  };
}

module.exports = { GB, FREE_BYTES, MAX_FILE_BYTES, TOKENS_PER_GB, usedBytes, quotaBytes, summary, overQuota, fmt };
