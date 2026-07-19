/**
 * Fork - User forking a shared map into their own project
 * This is the deepest engagement signal - measures usefulness
 */

const mongoose = require('mongoose');

const forkSchema = new mongoose.Schema({
  // The shared map being forked
  sourceMapId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SharedMap',
    required: true,
    index: true
  },

  // The new project created from the fork
  newProjectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true,
    index: true
  },

  // User who forked
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

// Compound indexes
forkSchema.index({ sourceMapId: 1, userId: 1 });
forkSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Fork', forkSchema);
