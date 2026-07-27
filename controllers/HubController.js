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
const { verifyToken, optionalAuth } = require('../middleware/auth');

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
    authorName: p.authorName || 'Member',
    authorHandle: p.authorHandle || '',
    authorAvatar: p.authorAvatar || null,
    body: p.body || '',
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
router.get('/discover', optionalAuth, async (req, res) => {
  try {
    const rows = await SharedMap.aggregate([
      { $match: { unpublishedAt: null, ownerName: { $ne: null } } },
      { $sort: { publishedAt: -1 } },
      { $group: { _id: '$ownerName', handle: { $first: '$ownerHandle' }, maps: { $sum: 1 } } },
      { $limit: 8 }
    ]);
    res.json({ success: true, people: rows.map(r => ({ name: r._id, handle: r.handle || '', maps: r.maps })) });
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
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const u = await User.findById(req.params.id).select('firstName lastName profilePhoto profilePhotoThumb verified createdAt role').lean();
    if (!u || u.role === 'system') return res.status(404).json({ error: 'Profile not found' });
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || 'Member';
    const maps = await SharedMap.find({ ownerId: u._id, unpublishedAt: null })
      .select('title previewSvg coverage nodeCount publishedAt').sort({ publishedAt: -1 }).limit(24).lean();
    res.json({
      success: true,
      profile: {
        id: u._id, name, avatar: u.profilePhotoThumb || u.profilePhoto || null,
        verified: !!u.verified, joined: u.createdAt, isMe: req.userId ? String(req.userId) === String(u._id) : false
      },
      maps: maps.map(m => ({ id: m._id, title: m.title, previewSvg: m.previewSvg, coverage: m.coverage, nodeCount: m.nodeCount }))
    });
  } catch (e) { console.error('profile:', e.message); res.status(500).json({ error: 'Failed to load profile' }); }
});

// ── Create a post ("Add to Clockwork Hub") ────────────────────────────────────
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

    if (!post.body && !post.sharedMapId) return res.status(400).json({ error: 'Say something or share a map.' });
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
