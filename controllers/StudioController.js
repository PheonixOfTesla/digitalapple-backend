/**
 * StudioController — Clockwork Studios.
 *
 * A Studio is a live connect room: a chat channel, voice + screen share (over the
 * /studio Socket.IO namespace), and a blueprint the host builds together with
 * whoever joins. It's a Conversation with isStudio=true, so the persistent chat
 * reuses /messages/conversations/:id/messages and the member list is participants.
 *
 *   POST /studios                 create a Studio (host = you) { name, guestIds? }
 *   GET  /studios/:id             studio details (members, host, blueprint link)
 *   POST /studios/:id/join        join by link (adds you to the room)
 *   POST /studios/:id/blueprint   host: create + attach a blueprint to the room
 */
const express = require('express');
const mongoose = require('mongoose');
const Conversation = require('../models/Conversation');
const User = require('../models/User');
const Project = require('../models/Project');
const Notification = require('../models/Notification');
const realtime = require('../services/realtime');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();
router.use(verifyToken);

function nameOf(u) {
  if (!u) return 'Member';
  const nm = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  return (nm || (u.email ? u.email.split('@')[0] : 'Member')).slice(0, 80);
}
function clampStr(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }

// Server-side role check — the client's isAdmin flag is never trusted.
async function isAdminUser(userId) {
  try {
    const u = await User.findById(userId).select('role').lean();
    return !!(u && u.role === 'admin');
  } catch (e) { return false; }
}

async function members(convo) {
  const users = await User.find({ _id: { $in: convo.participants } })
    .select('firstName lastName email profilePhotoThumb profilePhoto verified').lean();
  const roleOf = {};
  (convo.memberRoles || []).forEach(r => { if (r.userId) roleOf[String(r.userId)] = r.role || ''; });
  return users.map(u => ({
    id: u._id, name: nameOf(u), avatar: u.profilePhotoThumb || u.profilePhoto || null,
    verified: !!u.verified, isHost: String(u._id) === String(convo.ownerId),
    role: roleOf[String(u._id)] || ''
  }));
}

// ── Create a Studio ───────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    // A host runs up to 3 active Connect rooms at once (admins exempt).
    const owned = await Conversation.countDocuments({ ownerId: req.userId, closedAt: null, $or: [{ isRoom: true }, { isStudio: true }] });
    if (owned >= 3 && !(await isAdminUser(req.userId))) {
      return res.status(403).json({ error: 'You host 3 Connect rooms already — delete one to open another.' });
    }
    const name = clampStr(b.name, 80) || 'Studio';
    const guests = Array.isArray(b.guestIds) ? b.guestIds.filter(id => mongoose.isValidObjectId(id)) : [];
    const participants = Array.from(new Set([String(req.userId), ...guests.map(String)]));
    const convo = await Conversation.create({
      participants, isRoom: true, isStudio: true, name,
      ownerId: req.userId, visibility: b.visibility === 'public' ? 'public' : 'private',
      category: 'ideas', updatedAt: new Date()
    });
    res.json({ success: true, id: convo._id, name: convo.name });
  } catch (e) { console.error('studio create:', e.message); res.status(500).json({ error: 'Could not create studio' }); }
});

// ── Studio details ────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const convo = await Conversation.findOne({ _id: req.params.id, isStudio: true });
    if (!convo) return res.status(404).json({ error: 'Studio not found' });
    const isMember = (convo.participants || []).some(id => String(id) === String(req.userId));
    if (!isMember && convo.visibility !== 'public') {
      // Tell a knocking guest their request is still pending so the client can
      // show a waiting state instead of a hard wall.
      const pending = (convo.joinRequests || []).some(r => String(r.userId) === String(req.userId));
      return res.status(403).json({ error: 'Private studio', pending });
    }

    let blueprint = null;
    if (convo.blueprintProjectId) {
      const p = await Project.findById(convo.blueprintProjectId).select('name').lean();
      if (p) blueprint = { id: p._id, name: p.name };
    }
    const isHost = String(convo.ownerId) === String(req.userId);
    // Pending knocks — host (or admin) only, with names for the accept UI.
    let requests = [];
    if ((isHost || await isAdminUser(req.userId)) && (convo.joinRequests || []).length) {
      const ids = convo.joinRequests.map(r => r.userId);
      const users = await User.find({ _id: { $in: ids } }).select('firstName lastName email profilePhotoThumb profilePhoto').lean();
      requests = users.map(u => ({ id: u._id, name: nameOf(u), avatar: u.profilePhotoThumb || u.profilePhoto || null }));
    }
    res.json({
      success: true,
      studio: {
        id: convo._id, name: convo.name, hostId: convo.ownerId,
        isHost, isMember, visibility: convo.visibility, blueprint,
        members: await members(convo), requests
      }
    });
  } catch (e) { console.error('studio get:', e.message); res.status(500).json({ error: 'Failed to load studio' }); }
});

// ── Join by link ──────────────────────────────────────────────────────────────
// Public studios: free access — you're in. Private studios: knock-to-enter —
// your request queues as pending and the host gets a notification; you're only
// added once they accept.
router.post('/:id/join', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const convo = await Conversation.findOne({ _id: req.params.id, isStudio: true, closedAt: null });
    if (!convo) return res.status(404).json({ error: 'Studio not found' });
    if ((convo.participants || []).some(id => String(id) === String(req.userId))) {
      return res.json({ success: true, id: convo._id, name: convo.name, member: true });
    }
    if (convo.visibility === 'public') {
      convo.participants.push(req.userId); convo.updatedAt = new Date(); await convo.save();
      return res.json({ success: true, id: convo._id, name: convo.name, member: true });
    }
    // Private — queue the knock (once) and tell the host.
    const alreadyAsked = (convo.joinRequests || []).some(r => String(r.userId) === String(req.userId));
    if (!alreadyAsked) {
      convo.joinRequests.push({ userId: req.userId, at: new Date() });
      await convo.save();
      try {
        const me = await User.findById(req.userId).select('firstName lastName email').lean();
        const link = 'studio.html?id=' + String(convo._id);
        const text = nameOf(me) + ' wants to join "' + (convo.name || 'your Studio') + '"';
        const already = await Notification.findOne({ userId: convo.ownerId, type: 'join_request', actorId: req.userId, read: false, link }).select('_id').lean();
        if (!already) await Notification.push({ userId: convo.ownerId, channel: 'personal', type: 'join_request', actorId: req.userId, actorName: nameOf(me), text, link });
        realtime.userEmit(convo.ownerId, 'notify', { type: 'join_request', text, link });
      } catch (e) { /* non-fatal */ }
    }
    res.json({ success: true, pending: true, id: convo._id, name: convo.name });
  } catch (e) { console.error('studio join:', e.message); res.status(500).json({ error: 'Could not join' }); }
});

// ── Host (or admin) accepts / declines a pending join request ────────────────
router.post('/:id/requests/:userId/:action', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(req.params.userId)) {
      return res.status(400).json({ error: 'Bad id' });
    }
    if (req.params.action !== 'accept' && req.params.action !== 'decline') {
      return res.status(400).json({ error: 'Bad action' });
    }
    const convo = await Conversation.findOne({ _id: req.params.id, isStudio: true, closedAt: null });
    if (!convo) return res.status(404).json({ error: 'Studio not found' });
    const isOwner = convo.ownerId && String(convo.ownerId) === String(req.userId);
    if (!isOwner && !(await isAdminUser(req.userId))) {
      return res.status(403).json({ error: 'Only the host can manage requests' });
    }
    const uid = req.params.userId;
    const had = (convo.joinRequests || []).some(r => String(r.userId) === String(uid));
    convo.joinRequests = (convo.joinRequests || []).filter(r => String(r.userId) !== String(uid));
    if (req.params.action === 'accept' && had) {
      if (!(convo.participants || []).some(id => String(id) === String(uid))) convo.participants.push(uid);
      convo.updatedAt = new Date();
      await convo.save();
      try {
        const link = 'studio.html?id=' + String(convo._id);
        await Notification.push({
          userId: uid, channel: 'personal', type: 'join_accepted', actorId: req.userId,
          text: 'You’re in — "' + (convo.name || 'Studio') + '" accepted your request', link
        });
        realtime.userEmit(uid, 'notify', { type: 'join_accepted', link });
      } catch (e) { /* non-fatal */ }
      return res.json({ success: true, accepted: true });
    }
    await convo.save();
    res.json({ success: true, declined: true });
  } catch (e) { console.error('studio request:', e.message); res.status(500).json({ error: 'Could not update request' }); }
});

// ── Host (or admin) flips the room public/private ────────────────────────────
// Public: anyone with the link walks straight in. Private: they knock and wait.
router.post('/:id/visibility', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const vis = (req.body || {}).visibility === 'public' ? 'public' : 'private';
    const convo = await Conversation.findOne({ _id: req.params.id, isStudio: true, closedAt: null });
    if (!convo) return res.status(404).json({ error: 'Studio not found' });
    const isOwner = convo.ownerId && String(convo.ownerId) === String(req.userId);
    if (!isOwner && !(await isAdminUser(req.userId))) {
      return res.status(403).json({ error: 'Only the host can change this' });
    }
    convo.visibility = vis;
    convo.updatedAt = new Date();
    await convo.save();
    res.json({ success: true, visibility: vis });
  } catch (e) { console.error('studio visibility:', e.message); res.status(500).json({ error: 'Could not update' }); }
});

// ── Host (or admin) assigns a member a role label (Co-host, Builder, …) ──────
router.post('/:id/role', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const b = req.body || {};
    if (!mongoose.isValidObjectId(b.userId)) return res.status(400).json({ error: 'Bad member id' });
    const role = clampStr(b.role, 24); // empty string clears the role
    const convo = await Conversation.findOne({ _id: req.params.id, isStudio: true, closedAt: null });
    if (!convo) return res.status(404).json({ error: 'Studio not found' });
    const isOwner = convo.ownerId && String(convo.ownerId) === String(req.userId);
    if (!isOwner && !(await isAdminUser(req.userId))) {
      return res.status(403).json({ error: 'Only the host can assign roles' });
    }
    if (!(convo.participants || []).some(id => String(id) === String(b.userId))) {
      return res.status(400).json({ error: 'Not a member of this Studio' });
    }
    convo.memberRoles = (convo.memberRoles || []).filter(r => String(r.userId) !== String(b.userId));
    if (role) convo.memberRoles.push({ userId: b.userId, role });
    convo.updatedAt = new Date();
    await convo.save();
    res.json({ success: true, role });
  } catch (e) { console.error('studio role:', e.message); res.status(500).json({ error: 'Could not assign role' }); }
});

// ── Host creates + attaches a blueprint to the Studio ─────────────────────────
router.post('/:id/blueprint', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const convo = await Conversation.findOne({ _id: req.params.id, isStudio: true });
    if (!convo) return res.status(404).json({ error: 'Studio not found' });
    if (String(convo.ownerId) !== String(req.userId)) return res.status(403).json({ error: 'Only the host can start the blueprint' });

    // Import an EXISTING blueprint: host passes projectId of a project they own.
    const importId = (req.body || {}).projectId;
    if (importId && mongoose.isValidObjectId(importId)) {
      const own = await Project.findOne({ _id: importId, ownerId: req.userId }).select('name').lean();
      if (!own) return res.status(404).json({ error: 'Blueprint not found' });
      convo.blueprintProjectId = own._id; convo.updatedAt = new Date(); await convo.save();
      return res.json({ success: true, projectId: own._id, name: own.name, imported: true });
    }
    // Reuse an already-attached blueprint if present.
    if (convo.blueprintProjectId) {
      const existing = await Project.findById(convo.blueprintProjectId).select('name').lean();
      if (existing) return res.json({ success: true, projectId: existing._id, name: existing.name });
    }
    const name = clampStr((req.body || {}).name, 120) || (convo.name + ' — blueprint');
    const project = await Project.create({ name, ownerId: req.userId });
    convo.blueprintProjectId = project._id; convo.updatedAt = new Date(); await convo.save();
    res.json({ success: true, projectId: project._id, name: project.name });
  } catch (e) { console.error('studio blueprint:', e.message); res.status(500).json({ error: 'Could not start blueprint' }); }
});

module.exports = router;
