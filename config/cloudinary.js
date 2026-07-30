const cloudinary = require('cloudinary').v2;
const multer = require('multer');

// Check if Cloudinary is configured
const isCloudinaryConfigured = !!(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);

let storage;

if (isCloudinaryConfigured) {
  const { CloudinaryStorage } = require('multer-storage-cloudinary');

  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });

  storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
      folder: 'digitalapple/profiles',
      allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
      // 800px master: 120px avatars on 3x phone screens need ~360 physical px,
      // and the original is discarded at upload — store enough to stay sharp.
      transformation: [
        { width: 800, height: 800, crop: 'fill', gravity: 'face', quality: 'auto:good' }
      ]
    }
  });

  console.log('Cloudinary storage configured');
} else {
  // Fallback to memory storage (uploads will fail gracefully)
  storage = multer.memoryStorage();
  console.log('Cloudinary not configured - photo uploads disabled');
}

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    if (!isCloudinaryConfigured) {
      cb(new Error('Photo uploads not configured. Contact administrator.'), false);
      return;
    }
    const allowedMimes = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, and WebP are allowed.'), false);
    }
  }
});

// Chat attachments — photos, GIFs, and PDFs shared in Studio/thread chat.
// No face-crop transformation. Documents route to 'raw' exactly as they do in
// Drive — the old note here said "PDFs ride Cloudinary's image pipeline", which
// is precisely the assumption that made PDF uploads fail: as an image a PDF
// lands under the image size ceiling and behind Cloudinary's PDF-delivery
// restriction. Same helper as Drive so the two cannot drift apart.
let chatStorage;
if (isCloudinaryConfigured) {
  const { CloudinaryStorage } = require('multer-storage-cloudinary');
  chatStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: (req, file) => {
      const mime = (file && file.mimetype) || '';
      const kind = resourceTypeFor(mime);
      const base = { folder: 'digitalapple/chat', resource_type: kind };
      if (kind === 'raw') {
        // Raw delivery keys off the public_id, so it must carry the real
        // extension or the download arrives without one and won't open.
        const orig = String((file && file.originalname) || 'file');
        const dot = orig.lastIndexOf('.');
        const ext = dot > 0 ? orig.slice(dot).toLowerCase() : '';
        const stem = (dot > 0 ? orig.slice(0, dot) : orig)
          .replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60) || 'file';
        base.public_id = stem + '-' + Date.now() + ext;
      }
      return base;
    }
  });
} else {
  chatStorage = multer.memoryStorage();
}

const chatUpload = multer({
  storage: chatStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    if (!isCloudinaryConfigured) {
      cb(new Error('Uploads not configured. Contact administrator.'), false);
      return;
    }
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    if (ok.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Images, GIFs, PDFs, and Word documents are allowed.'), false);
  }
});

// Ticker media — photos AND video for Hub status posts (Instagram-style).
// resource_type auto lets Cloudinary route video to its video pipeline.
let tickerStorage;
if (isCloudinaryConfigured) {
  const { CloudinaryStorage } = require('multer-storage-cloudinary');
  tickerStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: { folder: 'digitalapple/ticker', resource_type: 'auto' }
  });
} else {
  tickerStorage = multer.memoryStorage();
}

const tickerUpload = multer({
  storage: tickerStorage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB — room for short video
  fileFilter: (req, file, cb) => {
    if (!isCloudinaryConfigured) {
      cb(new Error('Uploads not configured. Contact administrator.'), false);
      return;
    }
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/gif',
      'video/mp4', 'video/quicktime', 'video/webm'];
    if (ok.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Photos (JPEG, PNG, WebP, GIF) and video (MP4, MOV, WebM) are allowed.'), false);
  }
});

// Drive files — the personal file home. Documents of every working kind:
// photos, video, PDFs, Word, PowerPoint.

/**
 * Which Cloudinary pipeline an uploaded file belongs in, as a CONCRETE type.
 *
 * Exported because two places have to agree and nothing connects them:
 * multer-storage-cloudinary hands back only { path, size, filename } from its
 * _handleFile, so `req.file.resource_type` is ALWAYS undefined. Any caller that
 * later has to destroy() the asset — the over-quota rollback, for one — must
 * re-derive the type from the mimetype exactly as the upload did. Guessing
 * 'image' for a document stored as 'raw' makes destroy() a no-op that reports
 * success, so the file we refused to accept stays on the account forever.
 *
 * Concrete rather than 'auto' on purpose: destroy() does not accept 'auto', so
 * using the same concrete value on both sides is what keeps them in step.
 */
function resourceTypeFor(mime) {
  const m = String(mime || '');
  if (/^image\//.test(m)) return 'image';
  if (/^video\//.test(m)) return 'video';
  return 'raw';
}

let driveStorage;
if (isCloudinaryConfigured) {
  const { CloudinaryStorage } = require('multer-storage-cloudinary');
  driveStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    // resource_type MUST be picked per file. 'auto' classifies a PDF as an
    // 'image', which is why PDFs failed: it puts them under the image size
    // ceiling AND behind Cloudinary's "PDF/ZIP delivery" restriction.
    // Documents go up as 'raw' — stored and served byte-for-byte.
    params: (req, file) => {
      const mime = (file && file.mimetype) || '';
      const kind = resourceTypeFor(mime);
      const isMedia = kind !== 'raw';
      const base = { folder: 'digitalapple/drive', resource_type: kind };
      if (!isMedia) {
        // Raw delivery keys off the public_id, so it has to carry the real
        // extension or the download arrives without one and won't open.
        const orig = String((file && file.originalname) || 'file');
        const dot = orig.lastIndexOf('.');
        const ext = dot > 0 ? orig.slice(dot).toLowerCase() : '';
        const stem = (dot > 0 ? orig.slice(0, dot) : orig)
          .replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60) || 'file';
        base.public_id = stem + '-' + Date.now() + ext;
      }
      return base;
    }
  });
} else {
  driveStorage = multer.memoryStorage();
}

const driveUpload = multer({
  storage: driveStorage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!isCloudinaryConfigured) {
      cb(new Error('Uploads not configured. Contact administrator.'), false);
      return;
    }
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/gif',
      'video/mp4', 'video/quicktime', 'video/webm',
      'application/pdf',
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'];
    if (ok.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Photos, video, PDF, Word, and PowerPoint files are allowed.'), false);
  }
});

module.exports = { cloudinary, upload, chatUpload, tickerUpload, driveUpload, resourceTypeFor, isCloudinaryConfigured };
