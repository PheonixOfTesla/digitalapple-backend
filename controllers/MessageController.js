/**
 * MessageController — Clockwork "Threads": private messaging between Hub members,
 * with optional shared blueprints. All routes require sign-in.
 *
 *   GET  /messages/conversations                 my threads (+ unread)
 *   POST /messages/conversations   {email|userId} find-or-create a 1:1 thread
 *   GET  /messages/conversations/:id/messages     thread messages (paginated)
 *   POST /messages/conversations/:id/messages     send { body, sharedMapId? }
 *   POST /messages/conversations/:id/read         mark read
 *   GET  /messages/unread-count                   badge count
 *
 * Delivery is poll-based for v1 (clients refresh); realtime can layer on later.
 */
const express = require('express');
const mongoose = require('mongoose');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const User = require('../models/User');
const SharedMap = require('../models/SharedMap');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();
router.use(verifyToken);

function clampStr(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
function nameOf(u) {
  if (!u) return 'Member';
  const nm = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  return (nm || (u.email ? u.email.split('@')[0] : 'Member')).slice(0, 80);
}

// Resolve the "other" participant for display.
async function otherParticipant(convo, meId) {
  const otherId = (convo.participants || []).map(String).find(id => id !== String(meId));
  if (!otherId) return { id: null, name: 'You' };
  const u = await User.findById(otherId).select('firstName lastName email').lean();
  return { id: otherId, name: nameOf(u) };
}

// List my threads
router.get('/conversations', async (req, res) => {
  try {
    const convos = await Conversation.find({ participants: req.userId })
      .sort({ updatedAt: -1 }).limit(50).lean();
    const out = [];
    for (const c of convos) {
      const other = await otherParticipant(c, req.userId);
      const unread = await Message.countDocuments({
        conversationId: c._id, senderId: { $ne: req.userId }, readBy: { $ne: req.userId }
      });
      out.push({
        id: c._id, with: other,
        lastMessage: c.lastMessage && c.lastMessage.at ? {
          body: c.lastMessage.body || (c.lastMessage.hasMap ? 'Shared a blueprint' : ''),
          mine: String(c.lastMessage.senderId) === String(req.userId), at: c.lastMessage.at
        } : null,
        unread, updatedAt: c.updatedAt
      });
    }
    res.json({ success: true, conversations: out });
  } catch (e) { console.error('convos error:', e.message); res.status(500).json({ error: 'Failed to load threads' }); }
});

// Find or create a 1:1 thread with another member (by email or userId)
router.post('/conversations', async (req, res) => {
  try {
    const b = req.body || {};
    let other = null;
    if (b.userId && mongoose.isValidObjectId(b.userId)) other = await User.findById(b.userId);
    else if (b.email) other = await User.findOne({ email: String(b.email).toLowerCase().trim() });
    if (!other) return res.status(404).json({ error: 'No Clockwork Hub found for that person yet.' });
    if (String(other._id) === String(req.userId)) return res.status(400).json({ error: "That's you." });

    const key = Conversation.keyFor(req.userId, other._id);
    let convo = await Conversation.findOne({ participantKey: key });
    if (!convo) {
      convo = await Conversation.create({ participants: [req.userId, other._id], participantKey: key, updatedAt: new Date() });
    }
    res.json({ success: true, id: convo._id, with: { id: other._id, name: nameOf(other) } });
  } catch (e) {
    if (e.code === 11000) { // race on unique key — fetch the existing one
      const key = Conversation.keyFor(req.userId, (req.body || {}).userId || '');
      const convo = await Conversation.findOne({ participantKey: key });
      if (convo) return res.json({ success: true, id: convo._id });
    }
    console.error('convo create error:', e.message); res.status(500).json({ error: 'Failed to start thread' });
  }
});

// Thread messages
router.get('/conversations/:id/messages', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const convo = await Conversation.findOne({ _id: req.params.id, participants: req.userId });
    if (!convo) return res.status(404).json({ error: 'Thread not found' });
    const q = { conversationId: convo._id };
    if (req.query.before) { const d = new Date(req.query.before); if (!isNaN(d)) q.createdAt = { $lt: d }; }
    const msgs = await Message.find(q).sort({ createdAt: -1 }).limit(40).lean();
    res.json({
      success: true,
      messages: msgs.reverse().map(m => ({
        id: m._id, body: m.body || '', mine: String(m.senderId) === String(req.userId),
        senderName: m.senderName || 'Member', createdAt: m.createdAt,
        sharedMapId: m.sharedMapId || null,
        sharedMap: m.sharedMap && m.sharedMap.title ? m.sharedMap : null
      }))
    });
  } catch (e) { console.error('messages error:', e.message); res.status(500).json({ error: 'Failed to load messages' }); }
});

// Send a message (optionally sharing a blueprint)
router.post('/conversations/:id/messages', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const convo = await Conversation.findOne({ _id: req.params.id, participants: req.userId });
    if (!convo) return res.status(404).json({ error: 'Thread not found' });

    const body = clampStr((req.body || {}).body, 4000);
    const me = await User.findById(req.userId).select('firstName lastName email').lean();
    const msg = new Message({ conversationId: convo._id, senderId: req.userId, senderName: nameOf(me), body, readBy: [req.userId] });

    const smid = (req.body || {}).sharedMapId;
    if (smid && mongoose.isValidObjectId(smid)) {
      const m = await SharedMap.findOne({ _id: smid, unpublishedAt: null }).select('title previewSvg coverage nodeCount').lean();
      if (m) { msg.sharedMapId = m._id; msg.sharedMap = { title: m.title, previewSvg: m.previewSvg, coverage: m.coverage, nodeCount: m.nodeCount }; }
    }
    if (!msg.body && !msg.sharedMapId) return res.status(400).json({ error: 'Say something or share a blueprint.' });
    await msg.save();

    convo.lastMessage = { body: (msg.body || '').slice(0, 400), senderId: req.userId, hasMap: !!msg.sharedMapId, at: new Date() };
    convo.updatedAt = new Date();
    await convo.save();

    res.json({ success: true, message: {
      id: msg._id, body: msg.body, mine: true, senderName: msg.senderName, createdAt: msg.createdAt,
      sharedMapId: msg.sharedMapId || null, sharedMap: msg.sharedMap && msg.sharedMap.title ? msg.sharedMap : null
    } });
  } catch (e) { console.error('send error:', e.message); res.status(500).json({ error: 'Failed to send' }); }
});

// Mark thread read
router.post('/conversations/:id/read', async (req, res) => {
  try {
    const convo = await Conversation.findOne({ _id: req.params.id, participants: req.userId });
    if (!convo) return res.status(404).json({ error: 'Thread not found' });
    await Message.updateMany(
      { conversationId: convo._id, senderId: { $ne: req.userId }, readBy: { $ne: req.userId } },
      { $addToSet: { readBy: req.userId } }
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed to mark read' }); }
});

// Unread badge count across all threads
router.get('/unread-count', async (req, res) => {
  try {
    const convos = await Conversation.find({ participants: req.userId }).select('_id').lean();
    const ids = convos.map(c => c._id);
    const count = ids.length ? await Message.countDocuments({
      conversationId: { $in: ids }, senderId: { $ne: req.userId }, readBy: { $ne: req.userId }
    }) : 0;
    res.json({ success: true, count });
  } catch (e) { res.json({ success: true, count: 0 }); }
});

module.exports = router;
