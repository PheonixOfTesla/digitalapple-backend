/**
 * Safety: block, unblock, mute, and report.
 *
 * The floor a conversation network needs before it can carry strangers. Before
 * this there was no way for one user to stop another from reaching them, and no
 * way to report abuse to anyone — the words existed in the UI copy, the routes
 * did not. It is also the hard gate for Apple App Review 1.2 on user-generated
 * content: block a user, report content, act on reports.
 *
 * Every enforcement decision is server-side. A block is symmetric and absolute:
 * once A blocks B, neither can open a thread with or message the other, checked
 * in MessageController against BOTH users' lists. The client cannot opt out of
 * it, because the client is never trusted with it.
 */

const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const Report = require('../models/Report');
const Notification = require('../models/Notification');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();

const nameOf = (u) => (u && (u.firstName || u.lastName)
  ? `${u.firstName || ''} ${u.lastName || ''}`.trim()
  : (u && u.email ? u.email.split('@')[0] : 'Someone'));

const oid = (v) => (v && mongoose.isValidObjectId(v) ? new mongoose.Types.ObjectId(v) : null);

/**
 * Whether either of two users has blocked the other.
 *
 * Exported so the message path enforces the same rule this controller sets,
 * from one definition — a block that the messenger did not honour would be a
 * setting that lies.
 */
async function isBlockedBetween(aId, bId) {
  if (!aId || !bId) return false;
  const a = await User.findById(aId).select('blocked').lean();
  if (a && (a.blocked || []).some((x) => String(x) === String(bId))) return true;
  const b = await User.findById(bId).select('blocked').lean();
  if (b && (b.blocked || []).some((x) => String(x) === String(aId))) return true;
  return false;
}

// ── Block ───────────────────────────────────────────────────────────────────

// POST /safety/block  { userId }
router.post('/block', verifyToken, async (req, res) => {
  try {
    const target = oid((req.body || {}).userId);
    if (!target) return res.status(400).json({ error: 'Bad user id' });
    if (String(target) === String(req.userId)) return res.status(400).json({ error: "You can't block yourself." });
    if (!(await User.exists({ _id: target }))) return res.status(404).json({ error: 'No such user' });

    // $addToSet keeps it idempotent — blocking twice is a no-op, not a duplicate.
    await User.updateOne({ _id: req.userId }, { $addToSet: { blocked: target } });
    res.json({ success: true, blocked: true });
  } catch (e) {
    console.error('[safety] block error:', e.message);
    res.status(500).json({ error: 'Could not block' });
  }
});

// POST /safety/unblock  { userId }
router.post('/unblock', verifyToken, async (req, res) => {
  try {
    const target = oid((req.body || {}).userId);
    if (!target) return res.status(400).json({ error: 'Bad user id' });
    await User.updateOne({ _id: req.userId }, { $pull: { blocked: target } });
    res.json({ success: true, blocked: false });
  } catch (e) {
    console.error('[safety] unblock error:', e.message);
    res.status(500).json({ error: 'Could not unblock' });
  }
});

// GET /safety/blocks — the people you've blocked, named, for a settings list.
router.get('/blocks', verifyToken, async (req, res) => {
  try {
    const me = await User.findById(req.userId).select('blocked').lean();
    const ids = (me && me.blocked) || [];
    const people = ids.length
      ? await User.find({ _id: { $in: ids } }).select('firstName lastName email profilePhotoThumb').lean()
      : [];
    res.json({ success: true, blocked: people.map((u) => ({ id: u._id, name: nameOf(u), photo: u.profilePhotoThumb || null })) });
  } catch (e) {
    console.error('[safety] blocks list error:', e.message);
    res.status(500).json({ error: 'Could not load blocks' });
  }
});

// ── Mute (softer: they can still message, they stop making noise) ────────────

// POST /safety/mute  { userId, on }
router.post('/mute', verifyToken, async (req, res) => {
  try {
    const target = oid((req.body || {}).userId);
    if (!target) return res.status(400).json({ error: 'Bad user id' });
    if (String(target) === String(req.userId)) return res.status(400).json({ error: "You can't mute yourself." });
    const on = (req.body || {}).on !== false;
    await User.updateOne({ _id: req.userId },
      on ? { $addToSet: { muted: target } } : { $pull: { muted: target } });
    res.json({ success: true, muted: on });
  } catch (e) {
    console.error('[safety] mute error:', e.message);
    res.status(500).json({ error: 'Could not mute' });
  }
});

// ── Report ──────────────────────────────────────────────────────────────────

// POST /safety/report  { userId, contentType?, contentId?, snapshot?, reason?, detail? }
router.post('/report', verifyToken, async (req, res) => {
  try {
    const b = req.body || {};
    const target = oid(b.userId);
    if (!target) return res.status(400).json({ error: 'Bad user id' });
    if (String(target) === String(req.userId)) return res.status(400).json({ error: "You can't report yourself." });

    const [me, them] = await Promise.all([
      User.findById(req.userId).select('firstName lastName email').lean(),
      User.findById(target).select('firstName lastName email').lean()
    ]);
    if (!them) return res.status(404).json({ error: 'No such user' });

    const contentType = ['user', 'message', 'post', 'room', 'comment', 'other'].includes(b.contentType) ? b.contentType : 'user';
    const reason = ['spam', 'harassment', 'hate', 'sexual', 'violence', 'scam', 'other'].includes(b.reason) ? b.reason : 'other';
    const contentId = oid(b.contentId);

    // One reporter reporting the same artifact twice updates the row rather than
    // stacking — the audit trail records that they reported it, once.
    const filter = { reporterId: req.userId, contentType, contentId };
    const doc = {
      reporterId: req.userId, reporterName: nameOf(me),
      targetUserId: target, targetName: nameOf(them),
      contentType, contentId,
      snapshot: String(b.snapshot || '').slice(0, 4000),
      reason, detail: String(b.detail || '').slice(0, 2000),
      status: 'open'
    };
    const report = await Report.findOneAndUpdate(filter, doc, { upsert: true, new: true, setDefaultsOnInsert: true });

    // Route it to the admins where the money and moderation already live.
    try {
      await Notification.pushAdmins({
        type: 'admin_report',
        text: `Report: ${nameOf(them)} — ${reason}${b.detail ? ' · ' + String(b.detail).slice(0, 80) : ''}`,
        link: 'admin.html#reports'
      });
    } catch (e) { /* non-fatal — the report is already stored */ }

    res.json({ success: true, reported: true, id: report._id });
  } catch (e) {
    console.error('[safety] report error:', e.message);
    res.status(500).json({ error: 'Could not file report' });
  }
});

module.exports = router;
module.exports.isBlockedBetween = isBlockedBetween;
