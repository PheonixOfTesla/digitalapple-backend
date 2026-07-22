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

  // === IDENTITY LAYER ===

  // Reference to the Core document (identity anchor)
  coreId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Core',
    index: true
  },

  // Trace from Core to this node: [{nodeId, title}, ...]
  path: [{
    nodeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Node',
      required: true
    },
    title: {
      type: String,
      required: true
    }
  }],

  // Stable identity hash: SHA-256(coreId + JSON(path))
  stableId: {
    type: String,
    index: true,
    sparse: true
  },

  // Frozen snapshot of identity-relevant fields at creation
  essence: {
    title: String,
    statement: String,
    constellation: String,
    constellationLabel: String
  },

  // How this node was derived
  derivation: {
    kind: {
      type: String,
      enum: ['nebula', 'expand', 'manual', 'fork', null],
      default: null
    },
    sourcePrompt: String,       // The prompt that generated this
    usedTrace: {                // Whether parent trace was in LLM context
      type: Boolean,
      default: false
    }
  },

  // === END IDENTITY LAYER ===


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

  // Human-readable constellation label (domain-specific, no W-words)
  constellationLabel: {
    type: String,
    maxlength: 50,
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

  // Content - title is a short label (2-4 words), statement is the full sentence
  title: {
    type: String,
    required: true,
    maxlength: 50 // Short label: 2-4 words
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
      enum: ['stated', 'inferred', 'unknown', 'confirmed'],
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
  },

  // Expansion state (infinite recursion support)
  expanded: {
    type: Boolean,
    default: false
  },

  // Terminal node (actionable, no further expansion)
  terminal: {
    type: Boolean,
    default: false
  },

  // Action field (present when terminal=true) — the concrete doable step
  action: {
    type: String,
    maxlength: 500,
    default: null
  },

  // How this node was expanded
  expansionType: {
    type: String,
    enum: ['sub-nebula', 'star-children', null],
    default: null
  },

  // If sub-nebula: which premise frame type was used
  subFrameType: {
    type: String,
    enum: ['venture', 'event', 'personal-goal', 'creative-work',
           'life-transition', 'career', 'research', 'campaign',
           'procedure', 'unknown', null],
    default: null
  },

  // === SCOPING LAYER ===

  // Node classification for scoping: component (decompose) vs decision (fork)
  nodeKind: {
    type: String,
    enum: ['component', 'decision', null],
    default: null
  },

  // For decision nodes: the scoped paths
  scopedPaths: [{
    label: { type: String, required: true, maxlength: 60 },
    summary: { type: String, maxlength: 300 },
    tradeoff: { type: String, maxlength: 200 },
    scores: {
      economy: {
        value: { type: Number, min: 0, max: 10 },
        reason: { type: String, maxlength: 200 }
      },
      orchestration: {
        value: { type: Number, min: 0, max: 10 },
        reason: { type: String, maxlength: 200 }
      },
      demand: {
        value: { type: Number, min: 0, max: 10 },
        reason: { type: String, maxlength: 200 }
      }
    },
    confidence: {
      value: { type: Number, min: 0, max: 1 },
      basis: { type: String, enum: ['stated', 'inferred', 'unknown'] }
    },
    inferred: { type: Boolean, default: true },
    chosen: { type: Boolean, default: false },
    roadNotTaken: { type: Boolean, default: false },
    chosenNodeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Node',
      default: null
    }
  }],

  // For decision nodes: the recommendation
  scopeRecommendation: {
    pathLabel: { type: String, maxlength: 60 },
    reasoning: { type: String, maxlength: 500 }
  },

  // Whether this node has been scoped
  scoped: {
    type: Boolean,
    default: false
  },

  // For component nodes: suggested sub-aspects (preview of expansion)
  suggestedSubAspects: [{
    type: String,
    maxlength: 100
  }],

  // Question state - node needs user input to scope (cannot be inferred)
  needsInput: {
    type: Boolean,
    default: false
  },

  // Question field (present when needsInput=true) — the specific question to ask
  question: {
    type: String,
    maxlength: 500,
    default: null
  }

  // === END SCOPING LAYER ===
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
nodeSchema.index({ projectId: 1, expanded: 1 });
nodeSchema.index({ projectId: 1, terminal: 1 });
// Note: coreId and stableId indexes already declared inline with field definitions

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
