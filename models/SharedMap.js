/**
 * SharedMap - A published version of a project for the public feed
 *
 * Contains a snapshot of the graph at share time, with excluded branches
 * physically omitted (not just hidden client-side).
 */

const mongoose = require('mongoose');

const sharedMapSchema = new mongoose.Schema({
  // Reference to the source project
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true,
    index: true
  },

  // Owner of the map
  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // Display info
  title: {
    type: String,
    required: true,
    maxlength: 200
  },

  description: {
    type: String,
    maxlength: 2000
  },

  category: {
    type: String,
    enum: ['business', 'career', 'product', 'creative', 'other'],
    default: 'other',
    index: true
  },

  // Computed metrics
  coverage: {
    type: Number,
    min: 0,
    max: 100,
    default: 0
  },

  nodeCount: {
    type: Number,
    default: 0
  },

  // Visibility
  visibility: {
    type: String,
    enum: ['private', 'unlisted', 'public'],
    default: 'private',
    index: true
  },

  publishedAt: {
    type: Date,
    index: true
  },

  unpublishedAt: {
    type: Date
  },

  // Snapshot of the graph at share time
  // This physically contains only the included nodes - excluded branches are omitted
  snapshot: {
    // Core node
    core: {
      _id: mongoose.Schema.Types.ObjectId,
      label: String,
      statement: String,
      detail: String,
      x: Number,
      y: Number
    },

    // Included nodes (excluded branches physically absent)
    nodes: [{
      _id: mongoose.Schema.Types.ObjectId,
      parentNodeId: mongoose.Schema.Types.ObjectId,
      label: String,
      statement: String,
      detail: String,
      constellation: String,
      stage: Number,
      scores: {
        economy: { value: Number, reason: String },
        orchestration: { value: Number, reason: String },
        demand: { value: Number, reason: String }
      },
      confidence: { value: Number, basis: String },
      cost: { low: Number, high: Number, basis: String },
      dependencies: [String],
      status: String,
      sources: [String],
      depth: Number,
      x: Number,
      y: Number
    }],

    // Edges between included nodes
    edges: [{
      _id: mongoose.Schema.Types.ObjectId,
      sourceId: mongoose.Schema.Types.ObjectId,
      targetId: mongoose.Schema.Types.ObjectId
    }]
  },

  // IDs of branches (node subtrees) excluded from sharing
  // Stored for reference when updating the share
  excludedBranchRoots: [{
    type: mongoose.Schema.Types.ObjectId
  }],

  // Engagement counts (denormalized for query performance)
  starCount: {
    type: Number,
    default: 0,
    index: true
  },

  repostCount: {
    type: Number,
    default: 0
  },

  forkCount: {
    type: Number,
    default: 0,
    index: true // Primary ranking metric
  },

  commentCount: {
    type: Number,
    default: 0
  },

  // Owner display info (denormalized)
  ownerName: String,
  ownerHandle: String,
  ownerAvatar: String,

  // Pre-rendered SVG preview of the graph
  // Generated at publish time for efficient feed rendering
  previewSvg: {
    type: String,
    maxlength: 50000
  },

  // For seed maps from Clockwork account
  isSeed: {
    type: Boolean,
    default: false,
    index: true
  }

}, {
  timestamps: true
});

// Compound indexes for feed queries
sharedMapSchema.index({ visibility: 1, publishedAt: -1 });
sharedMapSchema.index({ visibility: 1, forkCount: -1 });
sharedMapSchema.index({ visibility: 1, starCount: -1 });
sharedMapSchema.index({ visibility: 1, coverage: -1 });
sharedMapSchema.index({ ownerId: 1, publishedAt: -1 });

// Text search index
sharedMapSchema.index({ title: 'text', description: 'text' });

module.exports = mongoose.model('SharedMap', sharedMapSchema);
