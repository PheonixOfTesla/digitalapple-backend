/**
 * Node - Blueprint canvas node
 *
 * Represents an idea, goal, constraint, or rejected concept on the canvas.
 * Supports drag positioning and scoring.
 */

const mongoose = require('mongoose');

const nodeSchema = new mongoose.Schema({
  // Which project this belongs to
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true,
    index: true
  },

  // Node classification
  kind: {
    type: String,
    enum: ['goal', 'idea', 'orchestration', 'constraint', 'rejected'],
    default: 'idea',
    index: true
  },

  // Content
  title: {
    type: String,
    required: true,
    maxlength: 300
  },

  body: {
    type: String,
    maxlength: 5000
  },

  // Scores for evaluation
  scores: {
    economy: {
      type: Number,
      min: 0,
      max: 10,
      default: 0
    },
    orchestration: {
      type: Number,
      min: 0,
      max: 10,
      default: 0
    },
    demand: {
      type: Number,
      min: 0,
      max: 10,
      default: 0
    }
  },

  // Canvas position
  x: {
    type: Number,
    default: 100
  },

  y: {
    type: Number,
    default: 100
  },

  // Kept/favorited status
  kept: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Compound index for project queries
nodeSchema.index({ projectId: 1, kind: 1 });
nodeSchema.index({ projectId: 1, kept: 1 });

module.exports = mongoose.model('Node', nodeSchema);
