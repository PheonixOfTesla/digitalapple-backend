/**
 * Comment - Comments on maps or specific nodes
 *
 * nodeId is nullable - if null, it's a map-level comment.
 * If set, it's attached to a specific node in the map.
 */

const mongoose = require('mongoose');

const commentSchema = new mongoose.Schema({
  mapId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SharedMap',
    required: true,
    index: true
  },

  // Nullable - if set, comment is on a specific node
  nodeId: {
    type: mongoose.Schema.Types.ObjectId,
    index: true,
    sparse: true
  },

  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  body: {
    type: String,
    required: true,
    maxlength: 2000
  },

  // Denormalized user info for display
  userName: String,
  userHandle: String,
  userAvatar: String,

  createdAt: {
    type: Date,
    default: Date.now
  },

  editedAt: {
    type: Date
  },

  // Soft delete - set by author or map owner
  deletedAt: {
    type: Date
  },

  // Hidden by map owner (not deleted, but not shown publicly)
  hiddenAt: {
    type: Date
  },

  hiddenBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
});

// Indexes for fetching comments
commentSchema.index({ mapId: 1, nodeId: 1, createdAt: 1 });
commentSchema.index({ mapId: 1, createdAt: -1 });
commentSchema.index({ nodeId: 1, createdAt: -1 });

module.exports = mongoose.model('Comment', commentSchema);
