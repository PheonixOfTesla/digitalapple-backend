/**
 * TokenLedger - Audit trail for token transactions
 *
 * Every change to a user's tokenBalance MUST have a corresponding ledger entry.
 * This provides an immutable audit trail for billing reconciliation.
 */

const mongoose = require('mongoose');

const tokenLedgerSchema = new mongoose.Schema({
  // User who owns this transaction (for authenticated users)
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true,
    sparse: true
  },

  // Session ID for anonymous users (mutually exclusive with userId)
  sessionId: {
    type: String,
    index: true,
    sparse: true
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

// Compound index for session history queries
tokenLedgerSchema.index({ sessionId: 1, createdAt: -1 });

// Index for reconciliation by reason
tokenLedgerSchema.index({ reason: 1, createdAt: -1 });

// Index for idempotency on Stripe events
tokenLedgerSchema.index({ 'metadata.stripeEventId': 1 }, { sparse: true, unique: true });

// Validation: must have either userId or sessionId
tokenLedgerSchema.pre('validate', function(next) {
  if (!this.userId && !this.sessionId) {
    next(new Error('TokenLedger must have either userId or sessionId'));
  } else {
    next();
  }
});

module.exports = mongoose.model('TokenLedger', tokenLedgerSchema);
