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
// No face-crop transformation; PDFs ride Cloudinary's image pipeline.
let chatStorage;
if (isCloudinaryConfigured) {
  const { CloudinaryStorage } = require('multer-storage-cloudinary');
  chatStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
      folder: 'digitalapple/chat',
      resource_type: 'auto',
      allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'pdf', 'doc', 'docx']
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
      const isMedia = /^image\//.test(mime) || /^video\//.test(mime);
      const base = { folder: 'digitalapple/drive', resource_type: isMedia ? 'auto' : 'raw' };
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

module.exports = { cloudinary, upload, chatUpload, tickerUpload, driveUpload, isCloudinaryConfigured };
