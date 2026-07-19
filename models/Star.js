/**
 * Star - User starring a shared map
 * Unique on (mapId, userId) - one star per user per map
 */

const mongoose = require('mongoose');

const starSchema = new mongoose.Schema({
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
    default: Date.now
  }
});

// Unique constraint - one star per user per map
starSchema.index({ mapId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('Star', starSchema);
