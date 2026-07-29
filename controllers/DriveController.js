/**
 * DriveController — Clockwork Drive, the personal file home.
 *
 * Three sections, one place:
 *   Documents  — files uploaded straight to Drive (photos, video, PDF, Word,
 *                PowerPoint) PLUS everything you've already put into the
 *                system: chat attachments you sent, Ticker media you posted.
 *   Blueprints — your projects (the maps you own).
 *   Studios    — your rooms (each keeps its own resources drawer).
 *
 * Drawers (Clockwork's word for folders) organize Documents: a free-form
 * label on each file; the drawer list is derived, so empty drawers vanish.
 *
 * Auth:  GET    /drive           everything, in one call
 *        POST   /drive/upload    multipart 'file' (+ optional 'drawer' field)
 *        PATCH  /drive/:id       { name?, drawer? } — rename / move
 *        DELETE /drive/:id       remove from Drive (Cloudinary copy retained)
 */
const express = require('express');
const mongoose = require('mongoose');
const DriveFile = require('../models/DriveFile');
const Project = require('../models/Project');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Post = require('../models/Post');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();

function typeFromMime(mime) {
  if (/^image\//.test(mime)) return 'image';
  if (/^video\//.test(mime)) return 'video';
  if (mime === 'application/pdf') return 'pdf';
  if (/msword|wordprocessingml/.test(mime)) return 'doc';
  if (/ms-powerpoint|presentationml/.test(mime)) return 'ppt';
  return 'other';
}

router.get('/', verifyToken, async (req, res) => {
  try {
    const me = req.userId;
    const [files, chatMsgs, tickPosts, projects, rooms] = await Promise.all([
      DriveFile.find({ ownerId: me }).sort({ createdAt: -1 }).limit(300).lean(),
      Message.find({ senderId: me, 'attachment.url': { $exists: true, $ne: null } })
        .sort({ createdAt: -1 }).limit(100).select('attachment conversationId createdAt').lean(),
      Post.find({ authorId: me, 'media.url': { $exists: true, $ne: null } })
        .sort({ createdAt: -1 }).limit(100).select('media body createdAt').lean(),
      Project.find({ ownerId: me }).sort({ updatedAt: -1 }).limit(200)
        .select('name premise updatedAt createdAt').lean(),
      Conversation.find({ participants: me, closedAt: null, $or: [{ isStudio: true }, { isRoom: true }] })
        .sort({ updatedAt: -1 }).limit(100)
        .select('name photo visibility isStudio ownerId updatedAt participants').lean()
    ]);

    const documents = [
      ...files.map(f => ({
        id: f._id, name: f.name, url: f.url, type: f.type,
        drawer: f.drawer || null, source: 'drive', canManage: true, when: f.createdAt
      })),
      ...chatMsgs.map(m => ({
        id: m._id, name: (m.attachment.name || 'Chat file'), url: m.attachment.url,
        type: m.attachment.type === 'gif' ? 'image' : (m.attachment.type || 'other'),
        drawer: null, source: 'chat', canManage: false, when: m.createdAt
      })),
      ...tickPosts.map(p => ({
        id: p._id, name: (p.body || 'Ticker post').slice(0, 60), url: p.media.url,
        type: p.media.type || 'image', drawer: null, source: 'ticker', canManage: false, when: p.createdAt
      }))
    ].sort((a, b) => new Date(b.when) - new Date(a.when));

    const drawers = [...new Set(files.map(f => f.drawer).filter(Boolean))].sort();

    res.json({
      success: true,
      drawers,
      documents,
      blueprints: projects.map(p => ({
        id: p._id, name: p.name || 'Untitled blueprint',
        premise: (p.premise || '').slice(0, 140), when: p.updatedAt || p.createdAt
      })),
      studios: rooms.map(r => ({
        id: r._id, name: r.name || (r.isStudio ? 'Studio' : 'Room'),
        photo: r.photo || null, isStudio: !!r.isStudio,
        visibility: r.visibility || 'private',
        mine: String(r.ownerId) === String(me),
        members: (r.participants || []).length, when: r.updatedAt
      }))
    });
  } catch (e) {
    console.error('Drive list error:', e.message);
    res.status(500).json({ error: 'Could not load your Drive' });
  }
});

router.post('/upload', verifyToken, (req, res) => {
  const { driveUpload } = require('../config/cloudinary');
  driveUpload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    if (!req.file || !req.file.path) return res.status(400).json({ error: 'No file received' });
    try {
      const f = new DriveFile({
        ownerId: req.userId,
        name: String(req.file.originalname || 'File').slice(0, 200),
        url: req.file.path,
        type: typeFromMime(req.file.mimetype || ''),
        drawer: String(req.body.drawer || '').trim().slice(0, 60) || undefined,
        size: req.file.size
      });
      await f.save();
      res.json({ success: true, file: { id: f._id, name: f.name, url: f.url, type: f.type, drawer: f.drawer || null, source: 'drive', canManage: true, when: f.createdAt } });
    } catch (e) {
      console.error('Drive save error:', e.message);
      res.status(500).json({ error: 'Could not save the file' });
    }
  });
});

router.patch('/:id', verifyToken, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const f = await DriveFile.findOne({ _id: req.params.id, ownerId: req.userId });
    if (!f) return res.status(404).json({ error: 'Not found' });
    if (req.body.name !== undefined) {
      const n = String(req.body.name || '').trim().slice(0, 200);
      if (n) f.name = n;
    }
    if (req.body.drawer !== undefined) {
      f.drawer = String(req.body.drawer || '').trim().slice(0, 60) || undefined;
    }
    await f.save();
    res.json({ success: true, file: { id: f._id, name: f.name, drawer: f.drawer || null } });
  } catch (e) {
    res.status(500).json({ error: 'Could not update' });
  }
});

router.delete('/:id', verifyToken, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const r = await DriveFile.deleteOne({ _id: req.params.id, ownerId: req.userId });
    if (!r.deletedCount) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not delete' });
  }
});

module.exports = router;
