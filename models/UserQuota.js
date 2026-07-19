/**
 * UserQuota - Daily usage tracking
 *
 * Tracks LLM chat requests per user per day.
 * Anonymous users have smaller quotas.
 */

const mongoose = require('mongoose');

const userQuotaSchema = new mongoose.Schema({
  // User ID (null for anonymous)
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },

  // Anonymous session ID
  anonymousSessionId: {
    type: String,
    index: true,
    sparse: true
  },

  // Date (YYYY-MM-DD format for daily tracking)
  date: {
    type: String,
    required: true,
    index: true
  },

  // Chat requests used today
  chatRequests: {
    type: Number,
    default: 0
  },

  // Projects created today
  projectsCreated: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// Compound indexes
userQuotaSchema.index({ userId: 1, date: 1 }, { unique: true, sparse: true });
userQuotaSchema.index({ anonymousSessionId: 1, date: 1 }, { unique: true, sparse: true });

// TTL - auto-delete after 7 days
userQuotaSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

// Quota limits
userQuotaSchema.statics.LIMITS = {
  authenticated: {
    chatRequests: 50,
    projectsCreated: 10
  },
  anonymous: {
    chatRequests: 5,
    projectsCreated: 1
  }
};

module.exports = mongoose.model('UserQuota', userQuotaSchema);
