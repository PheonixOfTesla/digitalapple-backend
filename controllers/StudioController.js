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
const { verifyToken } = require('../middleware/auth');

const router = express.Router();
router.use(verifyToken);

function nameOf(u) {
  if (!u) return 'Member';
  const nm = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  return (nm || (u.email ? u.email.split('@')[0] : 'Member')).slice(0, 80);
}
function clampStr(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }

async function members(convo) {
  const users = await User.find({ _id: { $in: convo.participants } })
    .select('firstName lastName email profilePhotoThumb profilePhoto verified').lean();
  return users.map(u => ({
    id: u._id, name: nameOf(u), avatar: u.profilePhotoThumb || u.profilePhoto || null,
    verified: !!u.verified, isHost: String(u._id) === String(convo.ownerId)
  }));
}

// ── Create a Studio ───────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
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
    if (!isMember && convo.visibility !== 'public') return res.status(403).json({ error: 'Private studio' });

    let blueprint = null;
    if (convo.blueprintProjectId) {
      const p = await Project.findById(convo.blueprintProjectId).select('name').lean();
      if (p) blueprint = { id: p._id, name: p.name };
    }
    res.json({
      success: true,
      studio: {
        id: convo._id, name: convo.name, hostId: convo.ownerId,
        isHost: String(convo.ownerId) === String(req.userId),
        isMember, visibility: convo.visibility, blueprint,
        members: await members(convo)
      }
    });
  } catch (e) { console.error('studio get:', e.message); res.status(500).json({ error: 'Failed to load studio' }); }
});

// ── Join by link ──────────────────────────────────────────────────────────────
router.post('/:id/join', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const convo = await Conversation.findOne({ _id: req.params.id, isStudio: true });
    if (!convo) return res.status(404).json({ error: 'Studio not found' });
    if (!(convo.participants || []).some(id => String(id) === String(req.userId))) {
      convo.participants.push(req.userId); convo.updatedAt = new Date(); await convo.save();
    }
    res.json({ success: true, id: convo._id, name: convo.name });
  } catch (e) { console.error('studio join:', e.message); res.status(500).json({ error: 'Could not join' }); }
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
