/**
 * OrphanedNode - Quarantine for nodes that failed identity verification during migration
 *
 * Nodes whose parentNodeId points to a missing node, or whose trace never
 * reaches a root, are moved here rather than deleted. Data preservation
 * over silent destruction.
 */

const mongoose = require('mongoose');

const orphanedNodeSchema = new mongoose.Schema({
  // Original node ID
  originalNodeId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true
  },

  // Project it belonged to
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true,
    index: true
  },

  // Why it was orphaned
  reason: {
    type: String,
    enum: [
      'missing_parent',           // parentNodeId points to non-existent node
      'unreachable_root',         // trace never reaches a root/core
      'circular_reference',       // path contains cycle
      'invalid_project',          // projectId doesn't match parent's
      'migration_error'           // unexpected error during migration
    ],
    required: true
  },

  // Additional context
  details: {
    type: String,
    maxlength: 1000
  },

  // The full original node data (preserved)
  nodeData: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },

  // When it was quarantined
  quarantinedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Compound index for project queries
orphanedNodeSchema.index({ projectId: 1, reason: 1 });

module.exports = mongoose.model('OrphanedNode', orphanedNodeSchema);
