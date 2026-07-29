/**
 * HubController — Clockwork Hub, the networking feed.
 *
 * Public:  GET  /hub/feed        recent posts (+ shared map previews)
 *          GET  /hub/stories     Atlas maps as story tiles (yours first, then fresh public)
 *          GET  /hub/discover    a few Hubs/creators to connect with (right rail)
 * Auth:    POST /hub/posts       "Add to Clockwork Hub" (text and/or a shared map)
 *          POST /hub/posts/:id/like    toggle like
 *          DELETE /hub/posts/:id       delete your own post
 * One unified account = your Hub. No business/individual split.
 */
const express = require('express');
const mongoose = require('mongoose');
const Post = require('../models/Post');
const User = require('../models/User');
const SharedMap = require('../models/SharedMap');
const Connection = require('../models/Connection');
const Notification = require('../models/Notification');
const { verifyToken, optionalAuth } = require('../middleware/auth');
const { normalizeLinks } = require('../utils/links');
const { roomOpenNow, hoursPublic } = require('../utils/roomHours');

const router = express.Router();

function clampStr(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }

async function authorFor(userId, fallbackEmail) {
  try {
    const u = await User.findById(userId).select('firstName lastName email profilePhoto avatar handle').lean();
    if (u) {
      const nm = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
      return {
        name: (nm || (u.email ? u.email.split('@')[0] : 'Member')).slice(0, 80),
        handle: (u.handle || (u.email ? u.email.split('@')[0] : '')).slice(0, 40),
        avatar: u.profilePhoto || u.avatar || null
      };
    }
  } catch (e) {}
  return { name: (fallbackEmail ? fallbackEmail.split('@')[0] : 'Member'), handle: '', avatar: null };
}

function publicPost(p, userId) {
  return {
    id: p._id,
    authorId: p.authorId || null,
    authorName: p.authorName || 'Member',
    authorHandle: p.authorHandle || '',
    authorAvatar: p.authorAvatar || null,
    body: p.body || '',
    media: p.media && p.media.url ? { url: p.media.url, type: p.media.type } : null,
    sharedMapId: p.sharedMapId || null,
    sharedMap: p.sharedMap && p.sharedMap.title ? p.sharedMap : null,
    likeCount: p.likeCount || 0,
    liked: userId ? (p.likedBy || []).some(id => String(id) === String(userId)) : false,
    commentCount: p.commentCount || 0,
    mine: userId ? String(p.authorId) === String(userId) : false,
    createdAt: p.createdAt
  };
}

// ── Feed ────────────────────────────────────────────────────────────────────
router.get('/feed', optionalAuth, async (req, res) => {
  try {
    const limit = Math.min(30, Math.max(1, parseInt(req.query.limit) || 15));
    const before = req.query.before ? new Date(req.query.before) : null;
    const q = { hidden: { $ne: true } };
    if (before && !isNaN(before)) q.createdAt = { $lt: before };
    // Keep admin/system/test accounts out of the public feed — the same rule the
    // Discover rail uses. Their posts are seeds/tests, not social content.
    const staff = await User.find({ role: { $in: ['system', 'admin'] } }).select('_id').lean();
    if (staff.length) q.authorId = { $nin: staff.map(s => s._id) };
    const posts = await Post.find(q).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({
      success: true,
      posts: posts.map(p => publicPost(p, req.userId)),
      nextBefore: posts.length === limit ? posts[posts.length - 1].createdAt : null
    });
  } catch (e) {
    console.error('Hub feed error:', e.message);
    res.status(500).json({ error: 'Failed to load feed' });
  }
});

// ── Stories = Atlas maps (yours first, then fresh public) ─────────────────────
router.get('/stories', optionalAuth, async (req, res) => {
  try {
    const fields = 'title previewSvg coverage nodeCount ownerName ownerHandle ownerId isSeed publishedAt';
    let mine = [];
    if (req.userId) {
      mine = await SharedMap.find({ ownerId: req.userId, unpublishedAt: null })
        .select(fields).sort({ publishedAt: -1 }).limit(6).lean();
    }
    const have = new Set(mine.map(m => String(m._id)));
    const fresh = await SharedMap.find({ unpublishedAt: null, _id: { $nin: [...have].map(id => new mongoose.Types.ObjectId(id)) } })
      .select(fields).sort({ publishedAt: -1 }).limit(12 - mine.length).lean();
    const tiles = [...mine, ...fresh].map(m => ({
      id: m._id, title: m.title, previewSvg: m.previewSvg, coverage: m.coverage,
      nodeCount: m.nodeCount, ownerName: m.ownerName || 'Clockwork', mine: req.userId ? String(m.ownerId) === String(req.userId) : false
    }));
    res.json({ success: true, stories: tiles });
  } catch (e) {
    console.error('Hub stories error:', e.message);
    res.status(500).json({ error: 'Failed to load stories' });
  }
});

// ── Discover (right rail): recent map creators to connect with ────────────────
// ── Atlas creators: people who HAVE public maps, searched by name ────────────
// Public (no auth) — the Hub search finds creators even for visitors.
router.get('/creators', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 80);
    if (!q) return res.json({ success: true, creators: [] });
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const rows = await SharedMap.aggregate([
      { $match: { visibility: 'public', publishedAt: { $ne: null }, unpublishedAt: null, ownerName: rx } },
      { $group: { _id: '$ownerId', name: { $first: '$ownerName' }, avatar: { $first: '$ownerAvatar' }, maps: { $sum: 1 } } },
      { $sort: { maps: -1 } },
      { $limit: 6 }
    ]);
    res.json({ success: true, creators: rows.filter(r => r._id).map(r => ({
      id: r._id, name: r.name || 'Creator', avatar: r.avatar || null, maps: r.maps
    })) });
  } catch (e) { console.error('creators search:', e.message); res.json({ success: true, creators: [] }); }
});

router.get('/discover', optionalAuth, async (req, res) => {
  try {
    const rows = await SharedMap.aggregate([
      { $match: { unpublishedAt: null, ownerId: { $ne: null } } },
      { $sort: { publishedAt: -1 } },
      { $group: { _id: '$ownerId', name: { $first: '$ownerName' }, handle: { $first: '$ownerHandle' }, maps: { $sum: 1 } } },
      { $limit: 30 }
    ]);
    // Enrich with verified badge + freshest avatar/name. Only real members —
    // never the admin, system, or the person viewing.
    const ids = rows.map(r => r._id).filter(Boolean);
    const users = ids.length
      ? await User.find({ _id: { $in: ids }, role: { $nin: ['system', 'admin'] } })
          .select('firstName lastName profilePhotoThumb profilePhoto verified').lean()
      : [];
    const byId = new Map(users.map(u => [String(u._id), u]));
    const people = rows
      .filter(r => byId.has(String(r._id)) && String(r._id) !== String(req.userId || ''))
      .map(r => {
        const u = byId.get(String(r._id));
        const nm = [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || r.name || 'Member';
        return {
          id: r._id, name: nm.slice(0, 80), handle: r.handle || '', maps: r.maps,
          avatar: u.profilePhotoThumb || u.profilePhoto || null, verified: !!u.verified
        };
      })
      .slice(0, 10);
    res.json({ success: true, people });
  } catch (e) { res.json({ success: true, people: [] }); }
});

// ── Search the user base (to message / add / build a room) ────────────────────
router.get('/people', verifyToken, async (req, res) => {
  try {
    const q = clampStr(req.query.q, 60);
    if (q.length < 1) return res.json({ success: true, people: [] });
    const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(esc, 'i');
    const users = await User.find({
      _id: { $ne: req.userId },
      role: { $ne: 'system' },
      $or: [{ firstName: rx }, { lastName: rx }, { email: rx }]
    }).select('firstName lastName email profilePhotoThumb profilePhoto verified').limit(12).lean();
    const people = users.map(u => {
      const nm = [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || (u.email ? u.email.split('@')[0] : 'Member');
      return { id: u._id, name: nm.slice(0, 80), avatar: u.profilePhotoThumb || u.profilePhoto || null, verified: !!u.verified };
    });
    res.json({ success: true, people });
  } catch (e) { console.error('people search:', e.message); res.status(500).json({ error: 'Search failed' }); }
});

// ── Public profile: a person's Hub — name, badge, and their public blueprints ──
router.get('/profile/:id', optionalAuth, async (req, res) => {
  try {
    // Accepts a user id OR a vanity handle (theclockworkhub.com/<handle>).
    const key = String(req.params.id || '').toLowerCase();
    const u = mongoose.isValidObjectId(req.params.id)
      ? await User.findById(req.params.id).select('firstName lastName handle profilePhoto profilePhotoThumb verified createdAt role about specialties links featuredLinks').lean()
      : (/^[a-z0-9._-]{3,30}$/.test(key)
          ? await User.findOne({ handle: key }).select('firstName lastName handle profilePhoto profilePhotoThumb verified createdAt role about specialties links featuredLinks').lean()
          : null);
    if (!u || u.role === 'system') return res.status(404).json({ error: 'Profile not found' });
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || 'Member';
    const maps = await SharedMap.find({ ownerId: u._id, unpublishedAt: null })
      .select('title previewSvg coverage nodeCount publishedAt').sort({ publishedAt: -1 }).limit(24).lean();

    const connectionCount = await Connection.countDocuments({ status: 'accepted', $or: [{ a: u._id }, { b: u._id }] });

    // Relationship of the viewer to this person.
    let connectionState = 'none';
    const isMe = req.userId ? String(req.userId) === String(u._id) : false;
    if (isMe) connectionState = 'self';
    else if (req.userId) {
      const c = await Connection.findOne({ pairKey: Connection.keyFor(req.userId, u._id) }).lean();
      if (c) {
        if (c.status === 'accepted') connectionState = 'connected';
        else connectionState = String(c.requestedBy) === String(req.userId) ? 'pending_out' : 'pending_in';
      }
    }

    // The personal "link-me": this person's open Studios & public rooms — their
    // different hubs for different groups, joinable straight from their profile.
    const Conversation = require('../models/Conversation');
    // Lobby shows PUBLIC rooms only — private rooms stay invisible here.
    // (Signed-in visitors can join public ones; private entry is by direct
    // invite link, where the knock flow takes over.) The OWNER sees all of
    // their rooms, private included — the lobby doubles as their console.
    const roomQuery = {
      ownerId: u._id, closedAt: null,
      $or: [{ isStudio: true }, { isRoom: true }]
    };
    if (!isMe) roomQuery.visibility = 'public';
    const rooms = await Conversation.find(roomQuery)
      .select('name isStudio category participants visibility hours price updatedAt').sort({ updatedAt: -1 }).limit(12).lean();

    res.json({
      success: true,
      profile: {
        id: u._id, name, handle: u.handle || null,
        // Full master, not the thumb — this is the big ring avatar on the lobby.
        avatar: u.profilePhoto || u.profilePhotoThumb || null,
        verified: !!u.verified, joined: u.createdAt, isMe,
        about: u.about || '',
        specialties: u.specialties || [],
        links: normalizeLinks(u.links),
        featuredLinks: u.featuredLinks || [],
        connectionState, connectionCount
      },
      maps: maps.map(m => ({ id: m._id, title: m.title, previewSvg: m.previewSvg, coverage: m.coverage, nodeCount: m.nodeCount })),
      rooms: rooms.map(r => ({
        id: r._id, name: r.name || (r.isStudio ? 'Studio' : 'Room'),
        isStudio: !!r.isStudio, category: r.category || 'other',
        members: (r.participants || []).length,
        visibility: r.visibility || 'private',
        hours: hoursPublic(r), openNow: roomOpenNow(r), price: r.price || 0
      }))
    });
  } catch (e) { console.error('profile:', e.stack || e.message); res.status(500).json({ error: 'Failed to load profile' }); }
});

// ── Connections graph ("add you") ─────────────────────────────────────────────
// Send a connect request (or auto-accept if they already requested you).
router.post('/connect/:userId', verifyToken, async (req, res) => {
  try {
    const other = req.params.userId;
    if (!mongoose.isValidObjectId(other)) return res.status(400).json({ error: 'Bad id' });
    if (String(other) === String(req.userId)) return res.status(400).json({ error: "That's you." });
    const target = await User.findById(other).select('_id role').lean();
    if (!target || target.role === 'system') return res.status(404).json({ error: 'Member not found' });

    const pairKey = Connection.keyFor(req.userId, other);
    let c = await Connection.findOne({ pairKey });
    if (c) {
      // If they already asked you, accept instead of duplicating.
      if (c.status === 'pending' && String(c.requestedBy) !== String(req.userId)) {
        c.status = 'accepted'; c.acceptedAt = new Date(); await c.save();
        const me = await authorFor(req.userId, req.userEmail);
        Notification.push({
          userId: c.requestedBy, type: 'connect_accepted', actorId: req.userId, actorName: me.name, actorAvatar: me.avatar,
          text: me.name + ' accepted your connection', link: 'hub-profile.html?id=' + req.userId
        });
        return res.json({ success: true, state: 'connected' });
      }
      return res.json({ success: true, state: c.status === 'accepted' ? 'connected' : 'pending_out' });
    }
    const [a, b] = [String(req.userId), String(other)].sort();
    await Connection.create({ a, b, pairKey, requestedBy: req.userId, status: 'pending' });
    const me = await authorFor(req.userId, req.userEmail);
    Notification.push({
      userId: other, type: 'connect_request', actorId: req.userId, actorName: me.name, actorAvatar: me.avatar,
      text: me.name + ' wants to connect', link: 'hub-profile.html?id=' + req.userId
    });
    res.json({ success: true, state: 'pending_out' });
  } catch (e) {
    if (e.code === 11000) return res.json({ success: true, state: 'pending_out' });
    console.error('connect:', e.message); res.status(500).json({ error: 'Could not connect' });
  }
});

// Accept an incoming request.
router.post('/connections/:userId/accept', verifyToken, async (req, res) => {
  try {
    const other = req.params.userId;
    if (!mongoose.isValidObjectId(other)) return res.status(400).json({ error: 'Bad id' });
    const c = await Connection.findOne({ pairKey: Connection.keyFor(req.userId, other) });
    if (!c || c.status !== 'pending') return res.status(404).json({ error: 'No pending request' });
    if (String(c.requestedBy) === String(req.userId)) return res.status(400).json({ error: "Can't accept your own request" });
    c.status = 'accepted'; c.acceptedAt = new Date(); await c.save();
    const me = await authorFor(req.userId, req.userEmail);
    Notification.push({
      userId: c.requestedBy, type: 'connect_accepted', actorId: req.userId, actorName: me.name, actorAvatar: me.avatar,
      text: me.name + ' accepted your connection', link: 'hub-profile.html?id=' + req.userId
    });
    res.json({ success: true, state: 'connected' });
  } catch (e) { console.error('accept:', e.message); res.status(500).json({ error: 'Could not accept' }); }
});

// Remove a connection, cancel your request, or decline theirs.
router.delete('/connect/:userId', verifyToken, async (req, res) => {
  try {
    const other = req.params.userId;
    if (!mongoose.isValidObjectId(other)) return res.status(400).json({ error: 'Bad id' });
    await Connection.deleteOne({ pairKey: Connection.keyFor(req.userId, other) });
    res.json({ success: true, state: 'none' });
  } catch (e) { res.status(500).json({ error: 'Could not remove' }); }
});

// My accepted connections.
router.get('/connections', verifyToken, async (req, res) => {
  try {
    const rows = await Connection.find({ status: 'accepted', $or: [{ a: req.userId }, { b: req.userId }] })
      .sort({ acceptedAt: -1 }).limit(200).lean();
    const otherIds = rows.map(r => String(r.a) === String(req.userId) ? r.b : r.a);
    const users = await User.find({ _id: { $in: otherIds } })
      .select('firstName lastName email profilePhotoThumb profilePhoto verified').lean();
    const people = users.map(u => {
      const nm = [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || (u.email ? u.email.split('@')[0] : 'Member');
      return { id: u._id, name: nm.slice(0, 80), avatar: u.profilePhotoThumb || u.profilePhoto || null, verified: !!u.verified };
    });
    res.json({ success: true, people });
  } catch (e) { console.error('connections:', e.message); res.status(500).json({ error: 'Failed to load' }); }
});

// Incoming pending requests (people who asked to connect with me).
router.get('/connections/requests', verifyToken, async (req, res) => {
  try {
    const rows = await Connection.find({ status: 'pending', requestedBy: { $ne: req.userId }, $or: [{ a: req.userId }, { b: req.userId }] })
      .sort({ createdAt: -1 }).limit(100).lean();
    const fromIds = rows.map(r => r.requestedBy);
    const users = await User.find({ _id: { $in: fromIds } })
      .select('firstName lastName email profilePhotoThumb profilePhoto verified').lean();
    const byId = new Map(users.map(u => [String(u._id), u]));
    const people = rows.filter(r => byId.has(String(r.requestedBy))).map(r => {
      const u = byId.get(String(r.requestedBy));
      const nm = [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || (u.email ? u.email.split('@')[0] : 'Member');
      return { id: u._id, name: nm.slice(0, 80), avatar: u.profilePhotoThumb || u.profilePhoto || null, verified: !!u.verified };
    });
    res.json({ success: true, people });
  } catch (e) { console.error('requests:', e.message); res.status(500).json({ error: 'Failed to load' }); }
});

// ── Notifications (the bell / notification box) ───────────────────────────────
// Channel resolver — 'admin' only for admins; everyone else gets 'personal'.
function resolveChannel(req) {
  return (req.query.channel === 'admin' && req.userRole === 'admin') ? 'admin' : 'personal';
}

router.get('/notifications', verifyToken, async (req, res) => {
  try {
    const channel = resolveChannel(req);
    const items = await Notification.find({ userId: req.userId, channel }).sort({ createdAt: -1 }).limit(40).lean();
    const unread = await Notification.countDocuments({ userId: req.userId, channel, read: false });
    res.json({
      success: true, unread, channel,
      notifications: items.map(n => ({
        id: n._id, type: n.type, actorName: n.actorName, actorAvatar: n.actorAvatar,
        text: n.text, link: n.link, read: !!n.read, at: n.createdAt
      }))
    });
  } catch (e) { console.error('notifications:', e.message); res.status(500).json({ error: 'Failed to load' }); }
});

// Unread count only — cheap poll for the bell badge. Personal by default.
router.get('/notifications/count', verifyToken, async (req, res) => {
  try {
    const channel = resolveChannel(req);
    const unread = await Notification.countDocuments({ userId: req.userId, channel, read: false });
    res.json({ success: true, channel, unread });
  } catch (e) { res.json({ success: true, unread: 0 }); }
});

// Mark all (or one) read — scoped to the requested channel.
router.post('/notifications/read', verifyToken, async (req, res) => {
  try {
    const channel = resolveChannel(req);
    const id = (req.body || {}).id;
    const q = { userId: req.userId, channel, read: false };
    if (id && mongoose.isValidObjectId(id)) q._id = id;
    await Notification.updateMany(q, { $set: { read: true } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// ── Create a post ("Add to Clockwork Hub") ────────────────────────────────────
// ── Ticker media upload — a photo or video for a status post ─────────────────
// Two-step flow: upload here (Cloudinary), then POST /posts with the returned
// {url, type}. Keeps post-create JSON and lets the client show a preview.
router.post('/upload', verifyToken, (req, res) => {
  const { tickerUpload } = require('../config/cloudinary');
  tickerUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    if (!req.file || !req.file.path) return res.status(400).json({ error: 'No file received' });
    const type = /^video\//.test(req.file.mimetype) ? 'video' : 'image';
    res.json({ success: true, url: req.file.path, type });
  });
});

router.post('/posts', verifyToken, async (req, res) => {
  try {
    const b = req.body || {};
    const body = clampStr(b.body, 2000);
    const a = await authorFor(req.userId, req.userEmail);

    const post = new Post({
      authorId: req.userId, authorName: a.name, authorHandle: a.handle, authorAvatar: a.avatar,
      body
    });

    // Optional shared map — snapshot a lightweight preview for the feed.
    if (b.sharedMapId && mongoose.isValidObjectId(b.sharedMapId)) {
      const m = await SharedMap.findOne({ _id: b.sharedMapId, unpublishedAt: null })
        .select('title previewSvg coverage nodeCount').lean();
      if (m) {
        post.sharedMapId = m._id;
        post.sharedMap = { title: m.title, previewSvg: m.previewSvg, coverage: m.coverage, nodeCount: m.nodeCount };
      }
    }

    // Optional media — must be a Cloudinary URL from our own upload endpoint.
    if (b.media && b.media.url && /^https:\/\/res\.cloudinary\.com\//.test(String(b.media.url)) &&
        ['image', 'video'].includes(b.media.type)) {
      post.media = { url: String(b.media.url).slice(0, 500), type: b.media.type };
    }

    if (!post.body && !post.sharedMapId && !post.media?.url) return res.status(400).json({ error: 'Say something, add a photo or video, or share a map.' });
    await post.save();
    res.json({ success: true, post: publicPost(post.toObject(), req.userId) });
  } catch (e) {
    console.error('Hub post error:', e.message);
    res.status(500).json({ error: 'Failed to post' });
  }
});

// ── Like toggle ───────────────────────────────────────────────────────────────
router.post('/posts/:id/like', verifyToken, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Not found' });
    const uid = String(req.userId);
    const i = (post.likedBy || []).findIndex(id => String(id) === uid);
    if (i >= 0) post.likedBy.splice(i, 1); else post.likedBy.push(req.userId);
    post.likeCount = post.likedBy.length;
    await post.save();
    res.json({ success: true, liked: i < 0, likeCount: post.likeCount });
  } catch (e) { res.status(500).json({ error: 'Failed to like' }); }
});

// ── Delete your own post ───────────────────────────────────────────────────────
router.delete('/posts/:id', verifyToken, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Not found' });
    if (String(post.authorId) !== String(req.userId) && req.userRole !== 'admin') {
      return res.status(403).json({ error: 'Not yours' });
    }
    await Post.deleteOne({ _id: post._id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed to delete' }); }
});

module.exports = router;
