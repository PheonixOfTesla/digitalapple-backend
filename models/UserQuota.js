/**
 * UserQuota - Lifetime project count tracking
 *
 * Tracks how many projects a user has created (lifetime limit for free tier).
 * Anonymous users still have 24h TTL.
 *
 * Note: Per-project unit budget is now on the Project document itself,
 * not here. This model only tracks the project count cap.
 */

const mongoose = require('mongoose');

const userQuotaSchema = new mongoose.Schema({
  // User ID (null for anonymous)
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true,
    unique: true,
    sparse: true
  },

  // Anonymous session ID (for pre-login tracking)
  anonymousSessionId: {
    type: String,
    index: true,
    unique: true,
    sparse: true
  },

  // Total projects created (lifetime for auth, session for anon)
  projectsCreated: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// TTL - auto-delete anonymous quotas after 24 hours
userQuotaSchema.index(
  { createdAt: 1 },
  {
    expireAfterSeconds: 24 * 60 * 60,
    partialFilterExpression: { userId: null }
  }
);

// Free tier limits
userQuotaSchema.statics.LIMITS = {
  authenticated: {
    projects: 3 // 3 projects lifetime
  },
  anonymous: {
    projects: 1 // 1 project per 24h session
  }
};

// Per-project unit budget (stored on Project, not here)
userQuotaSchema.statics.PROJECT_UNITS = 5;

// Unit costs per operation type
userQuotaSchema.statics.UNIT_COSTS = {
  chat: 1,
  expand: 3,
  nebula: 0 // Free - creates the project
};

module.exports = mongoose.model('UserQuota', userQuotaSchema);
