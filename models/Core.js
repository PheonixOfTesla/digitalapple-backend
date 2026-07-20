/**
 * Core - Identity anchor for a Blueprint map
 *
 * Every map has exactly ONE Core. Every node traces back to it.
 * The Core stores the premise, classification, and frame metadata
 * that define the map's identity.
 */

const mongoose = require('mongoose');

const coreSchema = new mongoose.Schema({
  // One Core per Project (unique)
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true,
    unique: true,
    index: true
  },

  // Reference to the Core node (kind='core') in the Node collection
  coreNodeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Node',
    required: true
  },

  // Original premise that seeded this map
  premise: {
    type: String,
    required: true,
    maxlength: 2000
  },

  // Classification result
  classification: {
    type: {
      type: String,
      enum: ['venture', 'event', 'personal-goal', 'creative-work',
             'life-transition', 'career', 'research', 'campaign', 'unknown'],
      required: true
    },
    confidence: {
      type: Number,
      min: 0,
      max: 1,
      required: true
    },
    alternates: [{
      type: { type: String },
      confidence: Number
    }],
    reasoning: String
  },

  // Frame loader metadata
  frameMeta: {
    selectedType: String,
    confidence: Number,
    usedFallback: Boolean,
    isStraddle: Boolean,
    straddleWith: String
  },

  // Whether stage UI should be shown for this map
  stagesEnabled: {
    type: Boolean,
    default: true
  },

  // Fork origin (null if original, populated if forked)
  origin: {
    coreId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Core',
      default: null
    },
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      default: null
    },
    forkedAt: {
      type: Date,
      default: null
    },
    forkedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    }
  }
}, {
  timestamps: true
});

// Transform for API responses
coreSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('Core', coreSchema);
