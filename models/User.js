const mongoose = require('mongoose');
const { normalizeLinks } = require('../utils/links');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  passwordHash: {
    type: String,
    required: true
  },
  // Set when the account was created via / linked to Google Sign-In.
  googleId: {
    type: String,
    index: true,
    sparse: true
  },
  role: {
    type: String,
    enum: ['user', 'admin', 'system'],
    default: 'user'
  },
  firstName: {
    type: String,
    trim: true,
    maxlength: 50
  },
  lastName: {
    type: String,
    trim: true,
    maxlength: 50
  },
  // Who brought this person in. Set once, at signup, from the referral token
  // carried by the link they arrived on — and never again, so credit can't be
  // reassigned later. The handle IS the referral token: no separate code to
  // mint, expire or leak, and the link people already share is the attributed
  // one. Null for organic signups and for everyone who joined before this
  // existed.
  invitedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true
  },
  // About me — shown on the public profile so people landing on your Connect
  // know who you are before they knock.
  // Vanity Connect URL: theclockworkhub.com/<handle> → this person's lobby
  handle: {
    type: String,
    trim: true,
    lowercase: true,
    minlength: 3,
    maxlength: 30,
    match: /^[a-z0-9._-]+$/,
    unique: true,
    sparse: true
  },
  about: {
    type: String,
    trim: true,
    maxlength: 500
  },
  // Connect profile: what you're good at — shown as tags on the public profile.
  specialties: {
    type: [String],
    default: undefined
  },
  // Where else to find you — social/platform URLs, shown on the public profile.
  links: {
    x: String,
    instagram: String,
    facebook: String,
    twitch: String,
    youtube: String,
    tiktok: String,
    linkedin: String,
    github: String,
    maps: String,
    website: String
  },
  // Featured links — up to 6 custom label+URL pairs the person curates,
  // shown under "Featured links" on the public profile.
  featuredLinks: {
    type: [{ _id: false, label: String, url: String }],
    default: undefined
  },
  profilePhoto: {
    type: String // Cloudinary URL
  },
  profilePhotoThumb: {
    type: String // Thumbnail URL
  },
  // Clockwork Verified — a trust badge (admin-granted for now; unifies with the
  // Directory's legal verification). Surfaced across Connect / Hub / profiles.
  verified: {
    type: Boolean,
    default: false
  },
  marketingOptIn: {
    type: Boolean,
    default: false
  },
  // Stripe Express account — hosts collect room-entry payments here.
  stripeAccountId: {
    type: String,
    trim: true,
    maxlength: 64
  },
  emailVerified: {
    type: Boolean,
    default: false
  },
  // Pending email change (requires verification)
  pendingEmail: {
    type: String,
    lowercase: true,
    trim: true
  },
  pendingEmailToken: String,
  pendingEmailExpires: Date,
  // Password reset
  passwordResetToken: String,
  passwordResetExpires: Date,
  // Token balance for Blueprint (purchased units)
  tokenBalance: {
    type: Number,
    default: 0
  },
  // Drive capacity bought on top of the free allowance, in bytes. Paid for
  // out of tokenBalance (see services/storage.js) so extra storage rides the
  // existing Stripe -> tokens rail instead of a second billing system.
  storageBonusBytes: {
    type: Number,
    default: 0,
    min: 0
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Update timestamp on save
userSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Virtual for full name
userSchema.virtual('fullName').get(function() {
  if (this.firstName && this.lastName) {
    return `${this.firstName} ${this.lastName}`;
  }
  return this.firstName || this.lastName || null;
});

// Public profile data (safe to expose)
userSchema.methods.toPublicProfile = function() {
  return {
    id: this._id,
    firstName: this.firstName,
    lastName: this.lastName,
    profilePhoto: this.profilePhoto,
    profilePhotoThumb: this.profilePhotoThumb,
    handle: this.handle || null,
    specialties: this.specialties || [],
    links: normalizeLinks(this.links),
    featuredLinks: this.featuredLinks || []
  };
};

// Private profile data (for the user themselves)
userSchema.methods.toPrivateProfile = function() {
  return {
    id: this._id,
    email: this.email,
    firstName: this.firstName,
    lastName: this.lastName,
    handle: this.handle || null,
    about: this.about,
    specialties: this.specialties || [],
    links: normalizeLinks(this.links),
    featuredLinks: this.featuredLinks || [],
    profilePhoto: this.profilePhoto,
    profilePhotoThumb: this.profilePhotoThumb,
    marketingOptIn: this.marketingOptIn,
    emailVerified: this.emailVerified,
    pendingEmail: this.pendingEmail,
    tokenBalance: this.tokenBalance,
    createdAt: this.createdAt,
    // Admin flag derived server-side - never expose role string to client
    isAdmin: this.role === 'admin'
  };
};

module.exports = mongoose.model('User', userSchema);
