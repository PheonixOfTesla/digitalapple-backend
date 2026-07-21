/**
 * SessionToken - Token balance for anonymous sessions
 *
 * Tracks token balance for users who haven't signed up yet.
 * On signup, balance transfers to User.tokenBalance via claim flow.
 * TTL: 30 days (tokens expire if session never converts)
 */

const mongoose = require('mongoose');

const sessionTokenSchema = new mongoose.Schema({
  // Anonymous session identifier (from X-Session-Id header)
  sessionId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  // Token balance for this session
  tokenBalance: {
    type: Number,
    default: 0,
    min: 0
  },

  // Track if this session has been claimed by an account
  claimedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },

  claimedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// TTL: expire unclaimed sessions after 30 days
sessionTokenSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

// Find or create session token record
sessionTokenSchema.statics.findOrCreate = async function(sessionId) {
  let session = await this.findOne({ sessionId, claimedBy: null });
  if (!session) {
    session = await this.create({ sessionId, tokenBalance: 0 });
  }
  return session;
};

// Credit tokens to session (atomic)
sessionTokenSchema.statics.creditTokens = async function(sessionId, amount) {
  return this.findOneAndUpdate(
    { sessionId, claimedBy: null },
    { $inc: { tokenBalance: amount } },
    { new: true, upsert: true }
  );
};

// Spend tokens from session (atomic, returns null if insufficient)
sessionTokenSchema.statics.spendTokens = async function(sessionId, amount) {
  return this.findOneAndUpdate(
    { sessionId, claimedBy: null, tokenBalance: { $gte: amount } },
    { $inc: { tokenBalance: -amount } },
    { new: true }
  );
};

// Claim session tokens to a user account
sessionTokenSchema.statics.claimToUser = async function(sessionId, userId) {
  const session = await this.findOne({ sessionId, claimedBy: null });
  if (!session || session.tokenBalance === 0) {
    return { transferred: 0 };
  }

  // Mark as claimed
  session.claimedBy = userId;
  session.claimedAt = new Date();
  await session.save();

  return { transferred: session.tokenBalance };
};

module.exports = mongoose.model('SessionToken', sessionTokenSchema);
