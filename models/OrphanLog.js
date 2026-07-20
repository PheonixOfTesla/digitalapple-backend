/**
 * OrphanLog - Tracks premises that don't fit templates well
 *
 * Used to identify when new template types are needed:
 * - Low confidence classifications (< 0.6)
 * - Straddle cases (two types within 0.1 of each other)
 * - Fallback uses
 *
 * Query this to find patterns that suggest a new template type.
 */

const mongoose = require('mongoose');

const orphanLogSchema = new mongoose.Schema({
  // The original premise text
  premise: {
    type: String,
    required: true,
    maxlength: 1000
  },

  // Classification result from the model
  classification: {
    type: {
      type: String,
      enum: ['venture', 'event', 'personal-goal', 'creative-work',
             'life-transition', 'career', 'research', 'campaign', 'unknown']
    },
    confidence: Number,
    alternates: [{
      type: { type: String },
      confidence: Number
    }],
    reasoning: String
  },

  // Frame loader metadata
  meta: {
    selectedType: String,
    confidence: Number,
    usedFallback: Boolean,
    isStraddle: Boolean,
    straddleWith: String
  },

  // Why this was logged
  reason: {
    type: String,
    enum: ['fallback', 'straddle', 'low-confidence'],
    required: true
  },

  // When it happened
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  }
});

// Index for finding patterns
orphanLogSchema.index({ reason: 1, timestamp: -1 });
orphanLogSchema.index({ 'classification.type': 1, timestamp: -1 });

// TTL: auto-delete after 90 days (we only need recent patterns)
orphanLogSchema.index(
  { timestamp: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60 }
);

module.exports = mongoose.model('OrphanLog', orphanLogSchema);
