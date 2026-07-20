/**
 * Edge - Blueprint canvas connection
 *
 * Connects two nodes on the canvas to show relationships.
 */

const mongoose = require('mongoose');

const edgeSchema = new mongoose.Schema({
  // Which project this belongs to
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true,
    index: true
  },

  // Source node
  fromNodeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Node',
    required: true
  },

  // Target node
  toNodeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Node',
    required: true
  },

  // Edge type for styling
  type: {
    type: String,
    enum: ['dependency', 'alternative', 'expansion', 'rejection', 'contains'],
    default: 'dependency'
  }
}, {
  timestamps: true
});

// Compound index for project queries
edgeSchema.index({ projectId: 1 });

// Unique constraint: no duplicate edges
edgeSchema.index({ projectId: 1, fromNodeId: 1, toNodeId: 1 }, { unique: true });

module.exports = mongoose.model('Edge', edgeSchema);
