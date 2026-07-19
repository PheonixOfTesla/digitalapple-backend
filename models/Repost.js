/**
 * Repost - User reposting a map to their followers' feed
 */

const mongoose = require('mongoose');

const repostSchema = new mongoose.Schema({
  mapId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SharedMap',
    required: true,
    index: true
  },

  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
});

// Compound index for feed queries (show reposts from followed users)
repostSchema.index({ userId: 1, createdAt: -1 });

// Prevent duplicate reposts in short time window (optional)
repostSchema.index({ mapId: 1, userId: 1 });

module.exports = mongoose.model('Repost', repostSchema);
