/**
 * Node - Blueprint canvas node (Star schema)
 *
 * Extended schema supporting:
 * - Core nodes (premise)
 * - Constellation nodes (Offer, Demand, Delivery, Economy, Orchestration, Risk)
 * - Star children (actionable components)
 * - Unbounded expansion hierarchy
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

  // Parent node for hierarchy (null = root)
  parentNodeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Node',
    default: null,
    index: true
  },

  // Node classification
  kind: {
    type: String,
    enum: ['core', 'constellation', 'star', 'goal', 'idea', 'orchestration', 'constraint', 'rejected'],
    default: 'star',
    index: true
  },

  // Constellation type (for kind=constellation)
  constellation: {
    type: String,
    enum: ['offer', 'demand', 'delivery', 'economy', 'orchestration', 'risk', null],
    default: null
  },

  // Stage axis (0-9)
  stage: {
    type: Number,
    min: 0,
    max: 9,
    default: 0,
    index: true
  },

  // Content - statement is the primary content, title kept for backwards compat
  title: {
    type: String,
    required: true,
    maxlength: 300
  },

  statement: {
    type: String,
    maxlength: 500
  },

  body: {
    type: String,
    maxlength: 5000
  },

  detail: {
    type: String,
    maxlength: 5000
  },

  // Extended scores with reasoning
  scores: {
    economy: {
      value: { type: Number, min: 0, max: 10, default: 0 },
      reason: { type: String, maxlength: 500 }
    },
    orchestration: {
      value: { type: Number, min: 0, max: 10, default: 0 },
      reason: { type: String, maxlength: 500 }
    },
    demand: {
      value: { type: Number, min: 0, max: 10, default: 0 },
      reason: { type: String, maxlength: 500 }
    }
  },

  // Confidence assessment
  confidence: {
    value: { type: Number, min: 0, max: 10, default: 5 },
    basis: {
      type: String,
      enum: ['stated', 'inferred', 'unknown'],
      default: 'unknown'
    }
  },

  // Cost estimates
  cost: {
    capitalLow: { type: Number, default: null },
    capitalHigh: { type: Number, default: null },
    timeLow: { type: Number, default: null }, // in days
    timeHigh: { type: Number, default: null },
    basis: { type: String, maxlength: 500, default: 'unknown' }
  },

  // Dependencies on other nodes
  dependencies: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Node'
  }],

  // Status workflow
  status: {
    type: String,
    enum: ['unexplored', 'mapped', 'kept', 'pruned', 'done'],
    default: 'unexplored',
    index: true
  },

  // Sources/references
  sources: [{
    type: String,
    maxlength: 500
  }],

  // Owner assignment
  owner: {
    type: String,
    maxlength: 100
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

  // Kept/favorited status (legacy, use status='kept' for new)
  kept: {
    type: Boolean,
    default: false
  },

  // Depth in expansion hierarchy
  depth: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// Compound indexes
nodeSchema.index({ projectId: 1, kind: 1 });
nodeSchema.index({ projectId: 1, kept: 1 });
nodeSchema.index({ projectId: 1, stage: 1 });
nodeSchema.index({ projectId: 1, status: 1 });
nodeSchema.index({ projectId: 1, parentNodeId: 1 });
nodeSchema.index({ projectId: 1, constellation: 1 });

// Virtual for getting children
nodeSchema.virtual('children', {
  ref: 'Node',
  localField: '_id',
  foreignField: 'parentNodeId'
});

// Transform for API responses
nodeSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('Node', nodeSchema);
