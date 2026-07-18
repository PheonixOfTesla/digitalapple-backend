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
router.put('/profile', verifyToken, async (req, res) => {
  const { firstName, lastName, marketingOptIn } = req.body;

  try {
    const user = await User.findById(req.userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
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
