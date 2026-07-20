/**
 * Project - Blueprint canvas container
 *
 * Each user can have multiple projects (idea canvases).
 * Anonymous users get temporary in-memory boards until login.
 */

const mongoose = require('mongoose');

const projectSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    maxlength: 200,
    default: 'Untitled Project'
  },

  // Original premise that generated this nebula
  premise: {
    type: String,
    maxlength: 1000
  },

  // Owner (null for anonymous sessions)
  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },

  // Anonymous session ID (for pre-login boards)
  anonymousSessionId: {
    type: String,
    index: true,
    sparse: true
  },

  // Per-project unit budget (lifetime, does not reset)
  unitsUsed: {
    type: Number,
    default: 0
  },

  unitsAllowed: {
    type: Number,
    default: 5 // Free tier: 5 units per project
  },

  // Chat history for this project
  chatHistory: [{
    role: {
      type: String,
      enum: ['user', 'assistant'],
      required: true
    },
    content: {
      type: String,
      required: true,
      maxlength: 10000
    },
    operations: [{
      op: String,
      nodeId: mongoose.Schema.Types.ObjectId,
      edgeId: mongoose.Schema.Types.ObjectId,
      data: mongoose.Schema.Types.Mixed
    }],
    timestamp: {
      type: Date,
      default: Date.now
    }
  }]
}, {
  timestamps: true
});

// Compound index for owner queries
projectSchema.index({ ownerId: 1, createdAt: -1 });

// TTL for anonymous projects - auto-delete after 24 hours if not claimed
projectSchema.index(
  { createdAt: 1 },
  {
    expireAfterSeconds: 24 * 60 * 60,
    partialFilterExpression: { ownerId: null }
  }
);

module.exports = mongoose.model('Project', projectSchema);
