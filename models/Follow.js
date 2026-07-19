/**
 * Follow - User following another user
 */

const mongoose = require('mongoose');

const followSchema = new mongoose.Schema({
  followerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  followeeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Unique constraint - can only follow once
followSchema.index({ followerId: 1, followeeId: 1 }, { unique: true });

// Index for "who does this user follow"
followSchema.index({ followerId: 1, createdAt: -1 });

// Index for "who follows this user"
followSchema.index({ followeeId: 1, createdAt: -1 });

module.exports = mongoose.model('Follow', followSchema);
