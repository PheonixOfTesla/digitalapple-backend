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
const User = require('../models/User');
const TokenLedger = require('../models/TokenLedger');
const storage = require('../services/storage');
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

    // Usage must aggregate over EVERY file, not the 300 listed above — summing
    // the capped array would under-report storage for heavy accounts and let
    // them upload past their quota.
    const [meUser, usedNow] = await Promise.all([
      User.findById(me).select('storageBonusBytes').lean(),
      storage.usedBytes(me)
    ]);
    const quotaNow = storage.quotaBytes(meUser);

    res.json({
      success: true,
      storage: {
        usedBytes: usedNow,
        quotaBytes: quotaNow,
        remainingBytes: Math.max(0, quotaNow - usedNow),
        percentUsed: quotaNow > 0 ? Math.min(100, Math.round((usedNow / quotaNow) * 100)) : 0,
        full: usedNow >= quotaNow,
        used: storage.fmt(usedNow),
        quota: storage.fmt(quotaNow),
        remaining: storage.fmt(Math.max(0, quotaNow - usedNow)),
        maxFileBytes: storage.MAX_FILE_BYTES,
        tokensPerGb: storage.TOKENS_PER_GB
      },
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

/** Current capacity + usage, for the meter and the "buy more" screen. */
router.get('/storage', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('storageBonusBytes tokenBalance').lean();
    if (!user) return res.status(404).json({ error: 'Not found' });
    const s = await storage.summary({ _id: req.userId, storageBonusBytes: user.storageBonusBytes });
    res.json({ success: true, storage: s, tokenBalance: user.tokenBalance || 0 });
  } catch (e) {
    console.error('Drive storage error:', e.message);
    res.status(500).json({ error: 'Could not read your storage' });
  }
});

/**
 * Buy extra Drive capacity with tokens. The balance is decremented atomically
 * with a $gte guard so two parallel requests can't both spend the last token,
 * and the change writes a TokenLedger row like every other spend.
 */
router.post('/storage/purchase', verifyToken, async (req, res) => {
  try {
    const gb = Math.floor(Number(req.body && req.body.gb));
    if (!Number.isFinite(gb) || gb < 1 || gb > 100) {
      return res.status(400).json({ error: 'Ask for between 1 and 100 GB' });
    }
    const cost = gb * storage.TOKENS_PER_GB;

    const updated = await User.findOneAndUpdate(
      { _id: req.userId, tokenBalance: { $gte: cost } },
      { $inc: { tokenBalance: -cost, storageBonusBytes: gb * storage.GB } },
      { new: true }
    );
    if (!updated) {
      const me = await User.findById(req.userId).select('tokenBalance').lean();
      return res.status(402).json({
        error: 'Not enough tokens',
        code: 'INSUFFICIENT_TOKENS',
        needed: cost,
        balance: (me && me.tokenBalance) || 0
      });
    }

    await TokenLedger.create({
      userId: req.userId,
      delta: -cost,
      reason: 'spend',
      balanceAfter: updated.tokenBalance,
      metadata: { action: 'drive_storage', gb, bytes: gb * storage.GB }
    });

    res.json({
      success: true,
      storage: await storage.summary(updated),
      tokenBalance: updated.tokenBalance,
      spent: cost
    });
  } catch (e) {
    console.error('Drive storage purchase error:', e.message);
    res.status(500).json({ error: 'Could not add storage' });
  }
});

router.post('/upload', verifyToken, async (req, res) => {
  const { driveUpload, cloudinary } = require('../config/cloudinary');

  // Cheap pre-check on the declared body size, BEFORE anything streams to
  // Cloudinary — a user who is already full shouldn't burn the bandwidth (or
  // our storage bill) on an upload we're going to refuse anyway.
  let user, used, quota;
  try {
    user = await User.findById(req.userId).select('storageBonusBytes').lean();
    if (!user) return res.status(404).json({ error: 'Not found' });
    used = await storage.usedBytes(req.userId);
    quota = storage.quotaBytes(user);
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > 0) {
      const blocked = storage.overQuota(declared, used, quota);
      if (blocked) return res.status(402).json(blocked);
    }
  } catch (e) {
    console.error('Drive quota precheck error:', e.message);
    return res.status(500).json({ error: 'Could not check your storage' });
  }

  driveUpload.single('file')(req, res, async (err) => {
    if (err) {
      // multer's own text for the size cap is just "File too large", which
      // never tells the user what the cap actually is — that's the 400 they hit.
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          error: `That file is over the ${storage.fmt(storage.MAX_FILE_BYTES)} per-file limit.`,
          code: 'FILE_TOO_LARGE',
          maxFileBytes: storage.MAX_FILE_BYTES
        });
      }
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
    if (!req.file || !req.file.path) return res.status(400).json({ error: 'No file received' });
    try {
      // Exact re-check: Content-Length includes multipart overhead and is
      // absent on chunked uploads, so the true size is only known now.
      const blocked = storage.overQuota(req.file.size || 0, used, quota);
      if (blocked) {
        // Never keep a file we refuse to count — drop the Cloudinary copy.
        try {
          if (cloudinary && req.file.filename) {
            await cloudinary.uploader.destroy(req.file.filename, { resource_type: 'auto' });
          }
        } catch (e2) { console.error('Drive rollback failed:', e2.message); }
        return res.status(402).json(blocked);
      }

      const f = new DriveFile({
        ownerId: req.userId,
        name: String(req.file.originalname || 'File').slice(0, 200),
        url: req.file.path,
        type: typeFromMime(req.file.mimetype || ''),
        drawer: String(req.body.drawer || '').trim().slice(0, 60) || undefined,
        size: req.file.size
      });
      await f.save();
      res.json({
        success: true,
        storage: await storage.summary({ _id: req.userId, storageBonusBytes: user.storageBonusBytes }),
        file: { id: f._id, name: f.name, url: f.url, type: f.type, drawer: f.drawer || null, source: 'drive', canManage: true, when: f.createdAt }
      });
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
