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
const { encryptText, decryptText } = require('../services/crypto');
const realtime = require('../services/realtime');
const { chatUpload } = require('../config/cloudinary');
const { roomOpenNow, hoursPublic, minutes, eventPublic } = require('../utils/roomHours');

const router = express.Router();
router.use(verifyToken);

function clampStr(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }

// Validate a client-supplied attachment: our Cloudinary assets for every type,
// plus Giphy's CDN for GIFs picked from the search picker.
function cleanAttachment(a) {
  if (!a || typeof a !== 'object') return null;
  const url = clampStr(a.url, 500);
  const type = ['image', 'gif', 'pdf', 'doc'].includes(a.type) ? a.type : null;
  if (!type) return null;
  const cloudinary = /^https:\/\/res\.cloudinary\.com\//.test(url);
  const giphy = type === 'gif' && /^https:\/\/media[0-9]?\.giphy\.com\//.test(url);
  if (!cloudinary && !giphy) return null;
  return { url, type, name: clampStr(a.name, 160) };
}

// Server-side role check — the client's isAdmin flag is never trusted.
async function isAdminUser(userId) {
  try {
    const u = await User.findById(userId).select('role').lean();
    return !!(u && u.role === 'admin');
  } catch (e) { return false; }
}
// Compact reaction summary for one message: [{emoji, count, mine}] or null
function reactionSummary(reactions, me) {
  if (!reactions || !reactions.length) return null;
  const by = {};
  for (const r of reactions) {
    if (!r || !r.emoji) continue;
    if (!by[r.emoji]) by[r.emoji] = { emoji: r.emoji, count: 0, mine: false };
    by[r.emoji].count++;
    if (String(r.userId) === String(me)) by[r.emoji].mine = true;
  }
  return Object.values(by);
}

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
    const convos = await Conversation.find({
      participants: req.userId,
      archivedBy: { $ne: req.userId },   // hidden-for-me threads stay out
      closedAt: null                     // owner-deleted rooms/Studios are gone
    }).sort({ updatedAt: -1 }).limit(50).lean();
    const admin = await isAdminUser(req.userId);
    const out = [];
    for (const c of convos) {
      const other = c.isRoom
        ? { id: null, name: c.name || 'Business room', isRoom: true, count: (c.participants || []).length }
        : await otherParticipant(c, req.userId);
      const unread = await Message.countDocuments({
        conversationId: c._id, senderId: { $ne: req.userId }, readBy: { $ne: req.userId }
      });
      out.push({
        id: c._id, with: other,
        lastMessage: c.lastMessage && c.lastMessage.at ? {
          body: decryptText(c.lastMessage.body) || (c.lastMessage.hasMap ? 'Shared a blueprint' : ''),
          mine: String(c.lastMessage.senderId) === String(req.userId), at: c.lastMessage.at
        } : null,
        unread, updatedAt: c.updatedAt,
        isRoom: !!c.isRoom, isStudio: !!c.isStudio,
        photo: c.photo || null,
        visibility: c.visibility || 'private',
        hours: hoursPublic(c), openNow: roomOpenNow(c), price: c.price || 0,
        event: eventPublic(c),
        // Rename/delete rights: the host always, admins even when they're not.
        canManage: (c.isRoom || c.isStudio) &&
          (admin || (c.ownerId && String(c.ownerId) === String(req.userId)))
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

const ROOM_CATS = ['ideas', 'network', 'social', 'business', 'party', 'other'];

// Create a room — public (anyone can join) or private (invite selected members).
router.post('/rooms', async (req, res) => {
  try {
    const b = req.body || {};
    const name = clampStr(b.name, 80) || 'Room';
    const visibility = b.visibility === 'public' ? 'public' : 'private';
    const category = ROOM_CATS.includes(b.category) ? b.category : 'other';
    const description = clampStr(b.description, 300);
    let ids = Array.isArray(b.memberIds) ? b.memberIds.filter(id => mongoose.isValidObjectId(id)) : [];
    const members = ids.length ? await User.find({ _id: { $in: ids } }).select('_id').lean() : [];
    const participants = Array.from(new Set([String(req.userId), ...members.map(m => String(m._id))]));
    // Public rooms can start with just the creator; private rooms need >=2.
    if (visibility === 'private' && participants.length < 2) return res.status(400).json({ error: 'Add at least one member.' });
    // A host runs up to 3 active Connect rooms at once (admins exempt).
    const owned = await Conversation.countDocuments({ ownerId: req.userId, closedAt: null, $or: [{ isRoom: true }, { isStudio: true }] });
    if (owned >= 3 && !(await isAdminUser(req.userId))) {
      return res.status(403).json({ error: 'You host 3 Connect rooms already — delete one to open another.' });
    }
    const convo = await Conversation.create({
      participants, isRoom: true, name, ownerId: req.userId, visibility, category, description, updatedAt: new Date()
    });
    res.json({ success: true, id: convo._id, name });
  } catch (e) { console.error('room create:', e.message); res.status(500).json({ error: 'Failed to create room' }); }
});

// Archive / delete a thread. For everyone: archiving hides the thread from
// YOUR list only. If you're the OWNER of a room/Studio — or an admin, even one
// who isn't the host — it deletes the actual room: closedAt is set and it
// disappears for every member and from discover.
router.post('/conversations/:id/archive', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const admin = await isAdminUser(req.userId);
    // Admins can act on rooms they never joined; everyone else must be in it.
    const convo = admin
      ? await Conversation.findById(req.params.id)
      : await Conversation.findOne({ _id: req.params.id, participants: req.userId });
    if (!convo) return res.status(404).json({ error: 'Thread not found' });
    const isOwner = convo.ownerId && String(convo.ownerId) === String(req.userId);
    if ((isOwner || admin) && (convo.isRoom || convo.isStudio)) {
      convo.closedAt = new Date();
      await convo.save();
      return res.json({ success: true, deleted: true });
    }
    if (!convo.archivedBy.some(id => String(id) === String(req.userId))) {
      convo.archivedBy.push(req.userId);
      await convo.save();
    }
    res.json({ success: true, archived: true });
  } catch (e) { console.error('archive convo:', e.message); res.status(500).json({ error: 'Could not archive' }); }
});

// Rename a room/Studio — the host, or an admin even when they're not the host.
router.post('/conversations/:id/rename', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const name = clampStr((req.body || {}).name, 80);
    if (!name) return res.status(400).json({ error: 'Give it a name.' });
    const convo = await Conversation.findOne({ _id: req.params.id, closedAt: null });
    if (!convo) return res.status(404).json({ error: 'Thread not found' });
    if (!convo.isRoom && !convo.isStudio) return res.status(400).json({ error: 'Only rooms and Studios can be renamed.' });
    const isOwner = convo.ownerId && String(convo.ownerId) === String(req.userId);
    if (!isOwner && !(await isAdminUser(req.userId))) {
      return res.status(403).json({ error: 'Only the host can rename this.' });
    }
    convo.name = name;
    convo.updatedAt = new Date();
    await convo.save();
    res.json({ success: true, name });
  } catch (e) { console.error('rename convo:', e.message); res.status(500).json({ error: 'Could not rename' }); }
});

// Business hours — host (or admin) schedules when the room is open to walk-ins.
router.post('/conversations/:id/hours', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const b = req.body || {};
    const convo = await Conversation.findOne({ _id: req.params.id, closedAt: null });
    if (!convo) return res.status(404).json({ error: 'Thread not found' });
    if (!convo.isRoom && !convo.isStudio) return res.status(400).json({ error: 'Only rooms and Studios have hours.' });
    const isOwner = convo.ownerId && String(convo.ownerId) === String(req.userId);
    if (!isOwner && !(await isAdminUser(req.userId))) {
      return res.status(403).json({ error: 'Only the host can set business hours.' });
    }
    const enabled = b.enabled === true;
    // Advance notice rides with hours but works on its own too.
    const notice = Math.max(0, Math.min(168, parseInt(b.noticeHours) || 0));
    if (enabled) {
      if (minutes(b.open) == null || minutes(b.close) == null) return res.status(400).json({ error: 'Times are HH:MM.' });
      const days = Array.from(new Set((Array.isArray(b.days) ? b.days : []).map(Number).filter(d => d >= 0 && d <= 6)));
      if (!days.length) return res.status(400).json({ error: 'Pick at least one open day.' });
      const tz = Math.max(-840, Math.min(840, parseInt(b.tzOffset) || 0));
      convo.hours = { enabled: true, open: b.open, close: b.close, days, tzOffset: tz, noticeHours: notice };
    } else {
      convo.hours = { enabled: false, noticeHours: notice };
    }
    convo.updatedAt = new Date();
    await convo.save();
    res.json({ success: true, hours: hoursPublic(convo), openNow: roomOpenNow(convo) });
  } catch (e) { console.error('room hours:', e.message); res.status(500).json({ error: 'Could not save hours' }); }
});

// Entry price — host (or admin) makes a room paid (cents) or free (0).
router.post('/conversations/:id/price', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const amount = Math.max(0, Math.min(50000, parseInt((req.body || {}).amount) || 0));
    const convo = await Conversation.findOne({ _id: req.params.id, closedAt: null });
    if (!convo) return res.status(404).json({ error: 'Thread not found' });
    if (!convo.isRoom && !convo.isStudio) return res.status(400).json({ error: 'Only rooms and Studios have entry pricing.' });
    const isOwner = convo.ownerId && String(convo.ownerId) === String(req.userId);
    if (!isOwner && !(await isAdminUser(req.userId))) {
      return res.status(403).json({ error: 'Only the host can set the price.' });
    }
    convo.price = amount;
    convo.updatedAt = new Date();
    await convo.save();
    res.json({ success: true, price: amount });
  } catch (e) { console.error('room price:', e.message); res.status(500).json({ error: 'Could not set price' }); }
});

// Visibility — host (or admin) sets the door: public, private (knock), or
// invite (a true wall — no knocking; entry is by host invite alone).
router.post('/conversations/:id/visibility', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const v = ['public', 'private', 'invite'].includes((req.body || {}).visibility) ? req.body.visibility : 'private';
    const convo = await Conversation.findOne({ _id: req.params.id, closedAt: null });
    if (!convo) return res.status(404).json({ error: 'Thread not found' });
    if (!convo.isRoom && !convo.isStudio) return res.status(400).json({ error: 'Only rooms and Studios have visibility.' });
    const isOwner = convo.ownerId && String(convo.ownerId) === String(req.userId);
    if (!isOwner && !(await isAdminUser(req.userId))) {
      return res.status(403).json({ error: 'Only the host can change visibility.' });
    }
    convo.visibility = v;
    convo.updatedAt = new Date();
    await convo.save();
    res.json({ success: true, visibility: v });
  } catch (e) { console.error('room visibility:', e.message); res.status(500).json({ error: 'Could not change visibility' }); }
});

/**
 * Turn a room into an event — a start time and a door.
 *
 * POST { startsAt, endsAt?, ticketUrl? }   host or admin only
 * POST { startsAt: null }                  clears it back to an ordinary room
 *
 * ticketUrl is validated as an absolute http(s) URL rather than stored raw: it
 * is rendered as a link other people click, so a `javascript:` value would be a
 * stored XSS delivered by the host to their own guests.
 */
router.post('/conversations/:id/event', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const convo = await Conversation.findOne({ _id: req.params.id, closedAt: null });
    if (!convo) return res.status(404).json({ error: 'Thread not found' });
    if (!convo.isRoom && !convo.isStudio) return res.status(400).json({ error: 'Only rooms and Studios can be events.' });
    const isOwner = convo.ownerId && String(convo.ownerId) === String(req.userId);
    if (!isOwner && !(await isAdminUser(req.userId))) {
      return res.status(403).json({ error: 'Only the host can schedule this room.' });
    }

    const b = req.body || {};

    if (b.startsAt === null || b.startsAt === '') {         // clear
      convo.event = { startsAt: null, endsAt: null, ticketUrl: null };
      convo.updatedAt = new Date();
      await convo.save();
      return res.json({ success: true, event: null });
    }

    const startsAt = new Date(b.startsAt);
    if (isNaN(startsAt.getTime())) return res.status(400).json({ error: 'That start time is not a valid date.' });

    let endsAt = null;
    if (b.endsAt) {
      endsAt = new Date(b.endsAt);
      if (isNaN(endsAt.getTime())) return res.status(400).json({ error: 'That end time is not a valid date.' });
      // A door that closes before it opens would render as a negative countdown
      // and silently break every "is it live now" check downstream.
      if (endsAt <= startsAt) return res.status(400).json({ error: 'The end time has to be after the start time.' });
    }

    let ticketUrl = null;
    if (b.ticketUrl) {
      const raw = String(b.ticketUrl).trim().slice(0, 500);
      let u = null;
      try { u = new URL(raw); } catch (e) { u = null; }
      if (!u || !/^https?:$/.test(u.protocol)) {
        return res.status(400).json({ error: 'The ticket link has to be a full http(s) URL.' });
      }
      ticketUrl = u.toString();
    }

    convo.event = { startsAt, endsAt, ticketUrl };
    convo.updatedAt = new Date();
    await convo.save();
    res.json({ success: true, event: { startsAt, endsAt, ticketUrl } });
  } catch (e) {
    console.error('room event:', e.message);
    res.status(500).json({ error: 'Could not schedule this room' });
  }
});

// Room photo — host (or admin) uploads an image that fronts the room
// everywhere its orb shows. Images only; hosted on Cloudinary like all uploads.
router.post('/conversations/:id/photo', chatUpload.single('file'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    if (!req.file || !req.file.path) return res.status(400).json({ error: 'No file uploaded' });
    if (!/^image\//.test(req.file.mimetype || '')) return res.status(400).json({ error: 'Room photos must be images.' });
    const convo = await Conversation.findOne({ _id: req.params.id, closedAt: null });
    if (!convo) return res.status(404).json({ error: 'Thread not found' });
    if (!convo.isRoom && !convo.isStudio) return res.status(400).json({ error: 'Only rooms and Studios can have a photo.' });
    const isOwner = convo.ownerId && String(convo.ownerId) === String(req.userId);
    if (!isOwner && !(await isAdminUser(req.userId))) {
      return res.status(403).json({ error: 'Only the host can change the photo.' });
    }
    convo.photo = req.file.path;
    convo.updatedAt = new Date();
    await convo.save();
    res.json({ success: true, photo: convo.photo });
  } catch (e) { console.error('room photo:', e.message); res.status(500).json({ error: 'Could not set photo' }); }
});

// Browse public rooms (all types, or by category) — anyone can join.
router.get('/rooms/discover', async (req, res) => {
  try {
    const q = { isRoom: true, visibility: 'public', closedAt: null };
    if (ROOM_CATS.includes(req.query.category)) q.category = req.query.category;
    const rooms = await Conversation.find(q).sort({ updatedAt: -1 }).limit(40).lean();
    // "See who's already in it" — preview the first few members of every room
    // in one batched query (Discord-style face pile).
    const previewIds = new Set();
    rooms.forEach(r => (r.participants || []).slice(0, 3).forEach(id => previewIds.add(String(id))));
    const previewUsers = previewIds.size
      ? await User.find({ _id: { $in: Array.from(previewIds) } })
          .select('firstName lastName email profilePhotoThumb profilePhoto').lean()
      : [];
    const byId = {};
    previewUsers.forEach(u => { byId[String(u._id)] = { name: nameOf(u), avatar: u.profilePhotoThumb || u.profilePhoto || null }; });
    res.json({ success: true, rooms: rooms.map(r => ({
      id: r._id, name: r.name || 'Room', photo: r.photo || null, category: r.category || 'other',
      description: r.description || '', members: (r.participants || []).length,
      people: (r.participants || []).slice(0, 3).map(id => byId[String(id)]).filter(Boolean),
      source: r.source && r.source.type ? { type: r.source.type, title: r.source.title || '', url: r.source.url || '' } : null,
      joined: (r.participants || []).some(id => String(id) === String(req.userId))
    })) });
  } catch (e) { res.status(500).json({ error: 'Failed to load rooms' }); }
});

// Connect ↔ content: find-or-create the public room ABOUT a map / company / news
// item, join it, and return it. This is the integration primitive — "Discuss"
// on any Atlas map or Directory company lands everyone in the same room.
router.post('/rooms/for-source', async (req, res) => {
  try {
    const b = req.body || {};
    const type = ['map', 'company', 'news'].includes(b.type) ? b.type : null;
    const refId = clampStr(b.refId, 80);
    if (!type || !refId) return res.status(400).json({ error: 'A source type and id are required.' });
    const sourceKey = type + ':' + refId;
    let room = await Conversation.findOne({ sourceKey });
    if (!room) {
      const title = clampStr(b.title, 140) || 'Discussion';
      const label = { map: 'Map', company: 'Company', news: 'Signal' }[type];
      room = await Conversation.create({
        participants: [req.userId], isRoom: true, visibility: 'public',
        category: type === 'company' ? 'business' : type === 'news' ? 'social' : 'ideas',
        name: title.slice(0, 80), ownerId: req.userId, sourceKey,
        source: { type, refId, title: title.slice(0, 140), url: clampStr(b.url, 300) },
        description: 'Discussion about this ' + label.toLowerCase(), updatedAt: new Date()
      });
    } else if (!(room.participants || []).some(id => String(id) === String(req.userId))) {
      room.participants.push(req.userId); room.updatedAt = new Date(); await room.save();
    }
    res.json({ success: true, id: room._id, name: room.name });
  } catch (e) {
    if (e.code === 11000) { // race — fetch existing
      const room = await Conversation.findOne({ sourceKey: (req.body.type + ':' + req.body.refId) });
      if (room) return res.json({ success: true, id: room._id, name: room.name });
    }
    console.error('for-source:', e.message); res.status(500).json({ error: 'Failed to open discussion' });
  }
});

// Join a public room
router.post('/rooms/:id/join', async (req, res) => {
  try {
    const room = await Conversation.findOne({ _id: req.params.id, isRoom: true, visibility: 'public' });
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (!(room.participants || []).some(id => String(id) === String(req.userId))) {
      room.participants.push(req.userId); room.updatedAt = new Date(); await room.save();
    }
    res.json({ success: true, id: room._id, name: room.name });
  } catch (e) { res.status(500).json({ error: 'Failed to join' }); }
});

// Thread messages
// Upload a chat attachment (photo / GIF / PDF) — returns the hosted URL to
// include in a message send. Multer + Cloudinary; nothing touches local disk.
router.post('/uploads', chatUpload.single('file'), async (req, res) => {
  try {
    if (!req.file || !req.file.path) return res.status(400).json({ error: 'No file uploaded' });
    const mt = req.file.mimetype || '';
    const type = mt === 'application/pdf' ? 'pdf'
      : mt === 'image/gif' ? 'gif'
      : /msword|wordprocessingml/.test(mt) ? 'doc'
      : 'image';
    res.json({ success: true, url: req.file.path, type, name: clampStr(req.file.originalname, 160) });
  } catch (e) { console.error('chat upload error:', e.message); res.status(500).json({ error: 'Upload failed' }); }
});

// GIF library — a thin proxy over Giphy so the API key stays server-side.
// Empty q returns trending; a q searches (category chips just pass a term).
// `offset` pages the grid for infinite scroll. Without GIPHY_API_KEY the
// picker reports itself unconfigured and the client falls back to GIF uploads.
router.get('/gifs', async (req, res) => {
  try {
    const key = process.env.GIPHY_API_KEY;
    if (!key) return res.json({ success: true, configured: false, gifs: [], nextOffset: null });
    const q = clampStr(req.query.q, 80);
    const LIMIT = 27;
    const offset = Math.max(0, Math.min(parseInt(req.query.offset, 10) || 0, 4000));
    const url = q
      ? `https://api.giphy.com/v1/gifs/search?api_key=${key}&q=${encodeURIComponent(q)}&limit=${LIMIT}&offset=${offset}&rating=pg-13&bundle=messaging_non_clips`
      : `https://api.giphy.com/v1/gifs/trending?api_key=${key}&limit=${LIMIT}&offset=${offset}&rating=pg-13&bundle=messaging_non_clips`;
    const r = await fetch(url);
    const d = await r.json();
    const gifs = (d.data || []).map(g => {
      const img = (g.images || {});
      const full = img.downsized || img.original || {};
      const prev = img.fixed_width_small || img.preview_gif || full;
      return { id: g.id, url: full.url, preview: prev.url, title: clampStr(g.title, 100) };
    }).filter(g => g.url && /^https:\/\/media[0-9]?\.giphy\.com\//.test(g.url));
    // Giphy pagination reports total_count; hand back the next offset if more remain.
    const pg = (d.pagination || {});
    const seen = offset + (pg.count || gifs.length);
    const nextOffset = (typeof pg.total_count === 'number' && seen < pg.total_count) ? seen : null;
    res.json({ success: true, configured: true, gifs, nextOffset });
  } catch (e) { console.error('gif library error:', e.message); res.status(500).json({ error: 'GIF search failed' }); }
});

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
      messages: msgs.reverse().map(m => {
        const mine = String(m.senderId) === String(req.userId);
        return {
          id: m._id, body: decryptText(m.body) || '', mine,
          senderName: m.senderName || 'Member', createdAt: m.createdAt,
          sharedMapId: m.sharedMapId || null,
          sharedMap: m.sharedMap && m.sharedMap.title ? m.sharedMap : null,
          attachment: m.attachment && m.attachment.url ? m.attachment : null,
          // Seen = anyone besides me has read it (only meaningful on my own)
          seen: mine ? (m.readBy || []).some(id => String(id) !== String(req.userId)) : undefined,
          reactions: reactionSummary(m.reactions, req.userId)
        };
      })
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
    // Store the body encrypted at rest; keep the plaintext to echo back to sender.
    const msg = new Message({ conversationId: convo._id, senderId: req.userId, senderName: nameOf(me), body: encryptText(body), readBy: [req.userId] });

    const smid = (req.body || {}).sharedMapId;
    if (smid && mongoose.isValidObjectId(smid)) {
      const m = await SharedMap.findOne({ _id: smid, unpublishedAt: null }).select('title previewSvg coverage nodeCount').lean();
      if (m) { msg.sharedMapId = m._id; msg.sharedMap = { title: m.title, previewSvg: m.previewSvg, coverage: m.coverage, nodeCount: m.nodeCount }; }
    }
    const att = cleanAttachment((req.body || {}).attachment);
    if (att) msg.attachment = att;
    if (!msg.body && !msg.sharedMapId && !att) return res.status(400).json({ error: 'Say something or share a blueprint.' });
    await msg.save();

    const previewBody = body || (att ? (att.type === 'pdf' ? 'Sent a PDF' : att.type === 'gif' ? 'Sent a GIF' : 'Sent a photo') : '');
    convo.lastMessage = { body: encryptText(previewBody.slice(0, 400)), senderId: req.userId, hasMap: !!msg.sharedMapId, at: new Date() };
    convo.updatedAt = new Date();
    await convo.save();

    // Notify every other participant — like Facebook. Deduped: one unread "X
    // messaged you" per thread until they read it, so active threads don't spam.
    try {
      const Notification = require('../models/Notification');
      const link = 'host-portal.html?room=' + convo._id;
      const label = msg.sharedMapId
        ? (nameOf(me) + ' sent you a blueprint')
        : (nameOf(me) + ': ' + body.slice(0, 70));
      const others = (convo.participants || []).filter(id => String(id) !== String(req.userId));
      for (const uid of others) {
        // Studio chat persists through here too, but its bell notifications come
        // from the /studio socket (better link, knows who's in the room) — don't
        // double-ring. The live push below still updates open consoles.
        if (!convo.isStudio) {
          const already = await Notification.exists({ userId: uid, type: 'message', read: false, link });
          if (already) { await Notification.updateOne({ _id: already._id }, { $set: { text: label, createdAt: new Date() } }); }
          else { await Notification.push({ userId: uid, channel: 'personal', type: 'message', actorName: nameOf(me), text: label, link }); }
        }
        // Live-push over the /hub socket so open messengers update instantly.
        // Carries the full message so an open thread appends without a refetch.
        realtime.userEmit(uid, 'message:new', {
          conversationId: String(convo._id), from: nameOf(me),
          body: body.slice(0, 120), hasMap: !!msg.sharedMapId, at: msg.createdAt,
          message: {
            id: String(msg._id), body, senderName: msg.senderName,
            createdAt: msg.createdAt, sharedMapId: msg.sharedMapId || null,
            sharedMap: msg.sharedMap && msg.sharedMap.title ? msg.sharedMap : null,
            attachment: att || null
          }
        });
      }
    } catch (e) { /* non-fatal */ }

    res.json({ success: true, message: {
      id: msg._id, body: body, mine: true, senderName: msg.senderName, createdAt: msg.createdAt,
      sharedMapId: msg.sharedMapId || null, sharedMap: msg.sharedMap && msg.sharedMap.title ? msg.sharedMap : null,
      attachment: att || null
    } });
  } catch (e) { console.error('send error:', e.message); res.status(500).json({ error: 'Failed to send' }); }
});

// Mark thread read — and tell the senders their words were seen (live ticks)
router.post('/conversations/:id/read', async (req, res) => {
  try {
    const convo = await Conversation.findOne({ _id: req.params.id, participants: req.userId });
    if (!convo) return res.status(404).json({ error: 'Thread not found' });
    const r = await Message.updateMany(
      { conversationId: convo._id, senderId: { $ne: req.userId }, readBy: { $ne: req.userId } },
      { $addToSet: { readBy: req.userId } }
    );
    if (r.modifiedCount) {
      const others = (convo.participants || []).filter(id => String(id) !== String(req.userId));
      for (const uid of others) {
        realtime.userEmit(uid, 'thread-seen', { conversationId: String(convo._id), by: String(req.userId) });
      }
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed to mark read' }); }
});

// React to a message — one reaction per person; tapping the same one clears it
const REACTION_SET = ['❤️', '👍', '😂', '😮', '😢', '🔥'];
router.post('/conversations/:id/messages/:mid/react', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(req.params.mid)) {
      return res.status(400).json({ error: 'Bad id' });
    }
    const emoji = String((req.body || {}).emoji || '');
    if (!REACTION_SET.includes(emoji)) return res.status(400).json({ error: 'Unknown reaction' });
    const convo = await Conversation.findOne({ _id: req.params.id, participants: req.userId });
    if (!convo) return res.status(404).json({ error: 'Thread not found' });
    const msg = await Message.findOne({ _id: req.params.mid, conversationId: convo._id });
    if (!msg) return res.status(404).json({ error: 'Message not found' });

    const existing = (msg.reactions || []).find(x => String(x.userId) === String(req.userId));
    msg.reactions = (msg.reactions || []).filter(x => String(x.userId) !== String(req.userId));
    if (!existing || existing.emoji !== emoji) msg.reactions.push({ userId: req.userId, emoji });
    await msg.save();

    const others = (convo.participants || []).filter(id => String(id) !== String(req.userId));
    for (const uid of others) {
      realtime.userEmit(uid, 'message:react', {
        conversationId: String(convo._id), messageId: String(msg._id),
        reactions: reactionSummary(msg.reactions, uid)
      });
    }
    res.json({ success: true, reactions: reactionSummary(msg.reactions, req.userId) });
  } catch (e) { console.error('react error:', e.message); res.status(500).json({ error: 'Failed to react' }); }
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
