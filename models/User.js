const mongoose = require('mongoose');

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
  profilePhoto: {
    type: String // Cloudinary URL
  },
  profilePhotoThumb: {
    type: String // Thumbnail URL
  },
  marketingOptIn: {
    type: Boolean,
    default: false
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
    profilePhotoThumb: this.profilePhotoThumb
  };
};

// Private profile data (for the user themselves)
userSchema.methods.toPrivateProfile = function() {
  return {
    id: this._id,
    email: this.email,
    firstName: this.firstName,
    lastName: this.lastName,
    profilePhoto: this.profilePhoto,
    profilePhotoThumb: this.profilePhotoThumb,
    marketingOptIn: this.marketingOptIn,
    emailVerified: this.emailVerified,
    pendingEmail: this.pendingEmail,
    tokenBalance: this.tokenBalance,
    createdAt: this.createdAt
  };
};

module.exports = mongoose.model('User', userSchema);
