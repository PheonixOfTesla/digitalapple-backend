/**
 * TokenLedger - Audit trail for token transactions
 *
 * Every change to a user's tokenBalance MUST have a corresponding ledger entry.
 * This provides an immutable audit trail for billing reconciliation.
 */

const mongoose = require('mongoose');

const tokenLedgerSchema = new mongoose.Schema({
  // User who owns this transaction
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // Amount changed (positive for credit, negative for spend)
  delta: {
    type: Number,
    required: true
  },

  // Transaction type
  reason: {
    type: String,
    enum: ['purchase', 'spend', 'refund', 'grant', 'expire'],
    required: true
  },

  // Related project (for spend/refund)
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    index: true
  },

  // Operation type for spend/refund
  operationType: {
    type: String,
    enum: ['chat', 'expand', 'nebula', null]
  },

  // Balance after this transaction
  balanceAfter: {
    type: Number,
    required: true
  },

  // Additional metadata (payment ID, error message, etc.)
  metadata: {
    type: mongoose.Schema.Types.Mixed
  }
}, {
  timestamps: true
});

// Compound index for user history queries
tokenLedgerSchema.index({ userId: 1, createdAt: -1 });

// Index for reconciliation by reason
tokenLedgerSchema.index({ reason: 1, createdAt: -1 });

module.exports = mongoose.model('TokenLedger', tokenLedgerSchema);
