const express = require('express');
const User = require('../models/User');
const { verifyToken, generateVerificationToken, verifyEmailToken } = require('../middleware/auth');
const { upload, cloudinary } = require('../config/cloudinary');
const { sendEmailChangeVerification } = require('../utils/email');

const router = express.Router();

// Get own profile
router.get('/profile', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      success: true,
      profile: user.toPrivateProfile()
    });

  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

// Update own profile (name, marketingOptIn)
// Handles that can never be claimed — every real path plus obvious traps.
const RESERVED_HANDLES = new Set(['admin','api','atlas','about','apply','architect','blueprint','brainstorm','build','chart','climate','connect','directory','discover','feed','host-portal','hub','hub-profile','index','lab','login','map','menu','news','privacy','profile','shared','shop','signal','signals','studio','support','terms','welcome','clockwork','digitalapple','root','www']);

// Social/platform links the Connect profile accepts.
const LINK_KEYS = ['x', 'instagram', 'facebook', 'twitch', 'youtube', 'tiktok', 'linkedin', 'github', 'maps', 'website'];

// Handles are welcome: "itssjoshl" or "@itssjoshl" become the platform URL.
const LINK_HOME = { x: 'x.com/', instagram: 'instagram.com/', facebook: 'facebook.com/', twitch: 'twitch.tv/', youtube: 'youtube.com/@', tiktok: 'tiktok.com/@', linkedin: 'linkedin.com/in/', github: 'github.com/' };
function normalizeLink(key, raw) {
  let v = String(raw || '').trim().slice(0, 200);
  if (!v) return '';
  v = v.replace(/^https?:\/\//i, '').replace(/^\/+/, '');
  if (v.startsWith('@')) v = v.slice(1);
  if (!v.includes('.') && LINK_HOME[key]) v = LINK_HOME[key] + v;
  v = 'https://' + v;
  try {
    const p = new URL(v);
    if (p.protocol !== 'https:') return '';
    if (!p.hostname.includes('.')) return '';
  } catch (e) { return ''; }
  return v;
}

// Live "is my handle free?" check — the profile editor pings this as you type.
router.get('/handle-check', verifyToken, async (req, res) => {
  try {
    const h = String(req.query.handle || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(h)) return res.json({ available: false, reason: 'invalid' });
    if (RESERVED_HANDLES.has(h)) return res.json({ available: false, reason: 'reserved' });
    const taken = await User.findOne({ handle: h, _id: { $ne: req.userId } }).select('_id').lean();
    res.json({ available: !taken, reason: taken ? 'taken' : null });
  } catch (e) { res.status(500).json({ error: 'Check failed' }); }
});

router.put('/profile', verifyToken, async (req, res) => {
  const { firstName, lastName, marketingOptIn, about, handle, specialties, links } = req.body;

  try {
    const user = await User.findById(req.userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Vanity handle: theclockworkhub.com/<handle>. Lowercase url-safe,
    // unique, never a real page name.
    if (handle !== undefined) {
      const h = String(handle || '').trim().toLowerCase();
      if (h === '') {
        user.handle = undefined;
      } else {
        if (!/^[a-z0-9._-]{3,30}$/.test(h)) return res.status(400).json({ error: 'Handles are 3–30 letters, numbers, dots, dashes.' });
        if (RESERVED_HANDLES.has(h)) return res.status(400).json({ error: 'That handle is reserved.' });
        const taken = await User.findOne({ handle: h, _id: { $ne: user._id } }).select('_id').lean();
        if (taken) return res.status(409).json({ error: 'That handle is taken.' });
        user.handle = h;
      }
    }

    // Only allow updating specific fields - server-enforced scope
    if (firstName !== undefined) {
      user.firstName = firstName?.trim()?.slice(0, 50);
    }
    if (lastName !== undefined) {
      user.lastName = lastName?.trim()?.slice(0, 50);
    }
    if (marketingOptIn !== undefined) {
      user.marketingOptIn = marketingOptIn === true;
    }
    if (about !== undefined) {
      user.about = String(about || '').trim().slice(0, 500);
    }

    // Specialties — up to 8 short tags; accepts an array or a comma string.
    if (specialties !== undefined) {
      const arr = (Array.isArray(specialties) ? specialties : String(specialties || '').split(','))
        .map(s => String(s).trim().slice(0, 40)).filter(Boolean);
      user.specialties = Array.from(new Set(arr)).slice(0, 8);
    }

    // Links — known platforms only, https-normalized, nothing script-y.
    // An empty string clears that platform; omitted keys are left alone.
    if (links !== undefined && links && typeof links === 'object') {
      const current = user.links && user.links.toObject ? user.links.toObject() : (user.links || {});
      const merged = { ...current };
      for (const k of LINK_KEYS) {
        if (links[k] === undefined) continue;
        const raw = String(links[k] || '').trim();
        if (!raw) { delete merged[k]; continue; }
        const v = normalizeLink(k, raw);
        if (v) merged[k] = v;
      }
      user.links = merged;
      user.markModified('links');
    }

    await user.save();

    console.log(`Profile updated: ${user.email}`);

    res.json({
      success: true,
      profile: user.toPrivateProfile()
    });

  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Upload profile photo
router.post('/profile/photo', verifyToken, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const user = await User.findById(req.userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Delete old photo from Cloudinary if exists
    if (user.profilePhoto) {
      try {
        const publicId = user.profilePhoto.split('/').slice(-2).join('/').split('.')[0];
        await cloudinary.uploader.destroy(publicId);
      } catch (e) {
        console.error('Failed to delete old photo:', e);
      }
    }

    // Generate thumbnail URL (Cloudinary transformation)
    const photoUrl = req.file.path;
    const thumbUrl = photoUrl.replace('/upload/', '/upload/w_100,h_100,c_fill,g_face/');

    user.profilePhoto = photoUrl;
    user.profilePhotoThumb = thumbUrl;
    await user.save();

    console.log(`Profile photo uploaded: ${user.email}`);

    res.json({
      success: true,
      profilePhoto: user.profilePhoto,
      profilePhotoThumb: user.profilePhotoThumb
    });

  } catch (error) {
    console.error('Upload photo error:', error);
    res.status(500).json({ error: 'Failed to upload photo' });
  }
});

// Delete profile photo
router.delete('/profile/photo', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.profilePhoto) {
      try {
        const publicId = user.profilePhoto.split('/').slice(-2).join('/').split('.')[0];
        await cloudinary.uploader.destroy(publicId);
      } catch (e) {
        console.error('Failed to delete photo from Cloudinary:', e);
      }
    }

    user.profilePhoto = undefined;
    user.profilePhotoThumb = undefined;
    await user.save();

    console.log(`Profile photo deleted: ${user.email}`);

    res.json({ success: true });

  } catch (error) {
    console.error('Delete photo error:', error);
    res.status(500).json({ error: 'Failed to delete photo' });
  }
});

// Request email change (sends verification to new email)
router.post('/profile/email', verifyToken, async (req, res) => {
  const { newEmail } = req.body;

  if (!newEmail) {
    return res.status(400).json({ error: 'New email required' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(newEmail)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  try {
    const user = await User.findById(req.userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.email === newEmail.toLowerCase()) {
      return res.status(400).json({ error: 'This is already your email' });
    }

    // Check if new email is already taken
    const existing = await User.findOne({ email: newEmail.toLowerCase() });
    if (existing) {
      return res.status(400).json({ error: 'Email already in use' });
    }

    // Generate verification token
    const verifyToken = generateVerificationToken({
      userId: user._id,
      newEmail: newEmail.toLowerCase(),
      type: 'email-change'
    });

    user.pendingEmail = newEmail.toLowerCase();
    user.pendingEmailToken = verifyToken;
    user.pendingEmailExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
    await user.save();

    await sendEmailChangeVerification(newEmail.toLowerCase(), verifyToken);

    console.log(`Email change requested: ${user.email} -> ${newEmail}`);

    res.json({
      success: true,
      message: 'Verification email sent to new address'
    });

  } catch (error) {
    console.error('Email change error:', error);
    res.status(500).json({ error: 'Failed to request email change' });
  }
});

// Verify email change
router.post('/profile/email/verify', async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'Token required' });
  }

  try {
    const decoded = verifyEmailToken(token);

    if (!decoded || decoded.type !== 'email-change') {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }

    const user = await User.findById(decoded.userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.pendingEmailToken !== token) {
      return res.status(400).json({ error: 'Invalid token' });
    }

    if (user.pendingEmailExpires < new Date()) {
      return res.status(400).json({ error: 'Token expired' });
    }

    // Check again that new email isn't taken
    const existing = await User.findOne({ email: user.pendingEmail });
    if (existing) {
      return res.status(400).json({ error: 'Email already in use' });
    }

    const oldEmail = user.email;
    user.email = user.pendingEmail;
    user.pendingEmail = undefined;
    user.pendingEmailToken = undefined;
    user.pendingEmailExpires = undefined;
    user.emailVerified = true;
    await user.save();

    console.log(`Email changed: ${oldEmail} -> ${user.email}`);

    res.json({
      success: true,
      message: 'Email changed successfully',
      newEmail: user.email
    });

  } catch (error) {
    console.error('Verify email change error:', error);
    res.status(500).json({ error: 'Failed to verify email change' });
  }
});

module.exports = router;
