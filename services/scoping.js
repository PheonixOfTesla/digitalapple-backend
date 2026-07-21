/**
 * Scoping Service - Decision Node Classification and Path Generation
 *
 * Distinguishes between:
 * - COMPONENT nodes: parts that get decomposed (current behavior)
 * - DECISION nodes: forks where mutually-exclusive paths diverge
 *
 * For decision nodes, generates 2-4 ranked alternative paths with
 * scores, tradeoffs, and a recommendation.
 */

const { client, model, provider } = require('./aiClient');
const identity = require('./identity');
const Node = require('../models/Node');

// ═══════════════════════════════════════════════════════════════════════════
// PURE FUNCTIONS - CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════════

// Decision indicators: phrases that suggest a choice is being made
const DECISION_INDICATORS = [
  /^how\s+(to|you|we|they)\s+/i,
  /^which\s+/i,
  /^what\s+kind\s+of/i,
  /\s+vs\.?\s+/i,
  /\s+or\s+/i,
  /approach/i,
  /method/i,
  /strategy/i,
  /channel/i,
  /model\s*$/i,  // "revenue model", "pricing model"
  /structure$/i, // "cost structure", "org structure"
];

// Component indicators: phrases that name a part, not a choice
const COMPONENT_INDICATORS = [
  /^the\s+/i,
  /customers?$/i,
  /segments?$/i,
  /team$/i,
  /product$/i,
  /service$/i,
  /offering$/i,
  /platform$/i,
  /infrastructure$/i,
  /requirements?$/i,
  /dependencies$/i,
];

/**
 * Classify a node as component or decision based on its nature.
 * Pure function - no DB calls.
 *
 * @param {Object} node - Node with title, statement, constellation
 * @returns {{ kind: 'component' | 'decision', confidence: number, signals: string[] }}
 */
function classifyNodeKind(node) {
  const text = `${node.title || ''} ${node.statement || ''}`.toLowerCase();
  const signals = [];
  let decisionScore = 0;
  let componentScore = 0;

  // Check decision indicators
  for (const pattern of DECISION_INDICATORS) {
    if (pattern.test(text)) {
      decisionScore += 1;
      signals.push(`decision: matches ${pattern.source}`);
    }
  }

  // Check component indicators
  for (const pattern of COMPONENT_INDICATORS) {
    if (pattern.test(text)) {
      componentScore += 1;
      signals.push(`component: matches ${pattern.source}`);
    }
  }

  // Constellation-based hints
  // Risk and orchestration constellations more likely to have decisions
  if (node.constellation === 'orchestration' || node.constellation === 'delivery') {
    decisionScore += 0.5;
    signals.push('decision: orchestration/delivery constellation');
  }

  // Offer constellation often has decision points about product form
  if (node.constellation === 'offer' && /form|type|version/i.test(text)) {
    decisionScore += 0.5;
    signals.push('decision: offer form/type');
  }

  // Default to component when uncertain (over-forking is noise)
  const total = decisionScore + componentScore;
  if (total === 0 || componentScore >= decisionScore) {
    return {
      kind: 'component',
      confidence: total === 0 ? 0.5 : componentScore / (total + 1),
      signals
    };
  }

  return {
    kind: 'decision',
    confidence: decisionScore / (total + 1),
    signals
  };
}

/**
 * Rank paths by blended score (economy + orchestration + demand weighted).
 * Pure function.
 *
 * @param {Array} paths - Array of path objects with scores
 * @returns {Array} - Paths sorted by blended score (highest first)
 */
function rankPaths(paths) {
  // Weights: demand slightly higher (market validation matters most)
  const weights = { economy: 0.3, orchestration: 0.3, demand: 0.4 };

  return [...paths].sort((a, b) => {
    const scoreA = blendScore(a.scores, weights);
    const scoreB = blendScore(b.scores, weights);
    return scoreB - scoreA;
  });
}

/**
 * Compute blended score from individual axis scores.
 * @param {Object} scores - { economy, orchestration, demand } with value fields
 * @param {Object} weights - Weight for each axis
 * @returns {number} - Blended score 0-10
 */
function blendScore(scores, weights) {
  if (!scores) return 0;
  return (
    (scores.economy?.value || 0) * weights.economy +
    (scores.orchestration?.value || 0) * weights.orchestration +
    (scores.demand?.value || 0) * weights.demand
  );
}

/**
 * Generate recommendation from ranked paths.
 * Pure function.
 *
 * @param {Array} rankedPaths - Paths sorted by blended score
 * @returns {{ pathLabel: string, reasoning: string }}
 */
function generateRecommendation(rankedPaths) {
  if (!rankedPaths || rankedPaths.length === 0) {
    return { pathLabel: null, reasoning: 'No paths available' };
  }

  const top = rankedPaths[0];
  const scores = top.scores || {};

  // Build reasoning citing the scores
  const reasons = [];
  if (scores.demand?.value >= 7) {
    reasons.push(`strong demand (${scores.demand.value}/10)`);
  }
  if (scores.economy?.value >= 7) {
    reasons.push(`favorable economics (${scores.economy.value}/10)`);
  }
  if (scores.orchestration?.value >= 7) {
    reasons.push(`manageable complexity (${scores.orchestration.value}/10)`);
  }

  // Fallback if no strong scores
  if (reasons.length === 0) {
    reasons.push('best overall balance of scores');
  }

  return {
    pathLabel: top.label,
    reasoning: `Recommended because: ${reasons.join(', ')}.${top.tradeoff ? ` Tradeoff: ${top.tradeoff}` : ''}`
  };
}

/**
 * Validate that every path has required fields and reasons for scores.
 * Pure function.
 *
 * @param {Array} paths - Array of path objects
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validatePaths(paths) {
  const errors = [];

  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    if (!p.label?.trim()) {
      errors.push(`path[${i}]: missing label`);
    }
    if (!p.summary?.trim()) {
      errors.push(`path[${i}]: missing summary`);
    }

    // Check scores have reasons
    const scores = p.scores || {};
    for (const axis of ['economy', 'orchestration', 'demand']) {
      if (scores[axis]?.value !== undefined && !scores[axis]?.reason?.trim()) {
        errors.push(`path[${i}].${axis}: score missing reason`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// JSON SCHEMA FOR SCOPING
// ═══════════════════════════════════════════════════════════════════════════

const scopePathSchema = {
  type: 'object',
  properties: {
    label: { type: 'string', maxLength: 60 },
    summary: { type: 'string', maxLength: 300 },
    tradeoff: { type: 'string', maxLength: 200 },
    scores: {
      type: 'object',
      properties: {
        economy: {
          type: 'object',
          properties: {
            value: { type: 'number', minimum: 0, maximum: 10 },
            reason: { type: 'string', maxLength: 200 }
          },
          required: ['value', 'reason'],
          additionalProperties: false
        },
        orchestration: {
          type: 'object',
          properties: {
            value: { type: 'number', minimum: 0, maximum: 10 },
            reason: { type: 'string', maxLength: 200 }
          },
          required: ['value', 'reason'],
          additionalProperties: false
        },
        demand: {
          type: 'object',
          properties: {
            value: { type: 'number', minimum: 0, maximum: 10 },
            reason: { type: 'string', maxLength: 200 }
          },
          required: ['value', 'reason'],
          additionalProperties: false
        }
      },
      required: ['economy', 'orchestration', 'demand'],
      additionalProperties: false
    },
    confidence: {
      type: 'object',
      properties: {
        value: { type: 'number', minimum: 0, maximum: 1 },
        basis: { type: 'string', enum: ['stated', 'inferred', 'unknown'] }
      },
      required: ['value', 'basis'],
      additionalProperties: false
    },
    inferred: { type: 'boolean' }
  },
  required: ['label', 'summary', 'tradeoff', 'scores', 'confidence', 'inferred'],
  additionalProperties: false
};

const scopeResponseSchema = {
  type: 'object',
  properties: {
    paths: {
      type: 'array',
      items: scopePathSchema,
      minItems: 1,
      maxItems: 4
    },
    singlePath: { type: 'boolean' },
    reasoning: { type: 'string', maxLength: 500 }
  },
  required: ['paths', 'singlePath', 'reasoning'],
  additionalProperties: false
};

// ═══════════════════════════════════════════════════════════════════════════
// LLM OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

const SCOPE_SYSTEM_PROMPT = `You are Blueprint, an analyst that identifies decision forks in business structures.

When asked to scope a decision node, you generate the POSSIBILITIES the user did NOT explicitly state, rank them, and guide toward the best path.

CRITICAL RULES:
1. Generate 2-4 mutually-exclusive paths that represent real alternatives.
2. If the premise only supports ONE reasonable path, set singlePath=true and return just that path.
3. NEVER fabricate forks where none exist. Honesty > breadth.
4. Every score MUST have a non-empty reason.
5. Tradeoff must name what you LOSE by choosing this path.
6. inferred=true if you deduced this path; false if user stated it.

SCORING (0-10 for each):
- economy: Cost-effectiveness, capital efficiency, margin potential
- orchestration: Implementation complexity, operational burden, coordination needs
- demand: Market validation, customer pull, competitive fit

Return JSON with:
- paths: Array of 1-4 path alternatives
- singlePath: true if only one reasonable path exists
- reasoning: Why these paths were identified`;

/**
 * Generate scoped paths for a decision node.
 *
 * @param {Object} node - The decision node to scope
 * @param {string} traceString - Formatted trace for context
 * @param {Array} siblingContext - Other nodes at same level for context
 * @returns {Promise<{ paths: Array, singlePath: boolean, tokensUsed: number }>}
 */
async function scopeDecisionNode(node, traceString = '', siblingContext = []) {
  const userPrompt = `Scope this decision node into 2-4 alternative paths:

NODE TO SCOPE:
Title: ${node.title}
Statement: ${node.statement || '(no statement)'}
Constellation: ${node.constellation || 'unknown'}

TRACE (path from Core to this node):
${traceString || '[No trace available]'}

CONTEXT (sibling nodes):
${siblingContext.length > 0 ? JSON.stringify(siblingContext.slice(0, 5).map(n => ({
  title: n.title,
  statement: n.statement
})), null, 2) : '[No siblings]'}

Generate mutually-exclusive paths. If this premise only supports ONE way forward, return singlePath=true with that single path.

Every path needs:
- label: Short name (2-5 words)
- summary: What this path involves
- tradeoff: What you give up choosing this
- scores: economy, orchestration, demand (each with value 0-10 and reason)
- confidence: value 0-1 and basis (stated/inferred/unknown)
- inferred: true if you deduced it, false if user stated it`;

  const requestParams = {
    model,
    max_tokens: 3000,
    messages: [
      { role: 'system', content: SCOPE_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ]
  };

  // Use strict JSON schema for OpenAI
  if (provider === 'openai') {
    requestParams.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'scope_response',
        strict: true,
        schema: scopeResponseSchema
      }
    };
  } else {
    requestParams.response_format = { type: 'json_object' };
  }

  const response = await client.chat.completions.create(requestParams);
  const tokensUsed = (response.usage?.prompt_tokens || 0) + (response.usage?.completion_tokens || 0);

  // Parse response
  const choice = response.choices?.[0];
  if (choice?.message?.refusal) {
    throw new Error(`Model refused: ${choice.message.refusal}`);
  }
  if (choice?.finish_reason === 'length') {
    throw new Error('Response truncated');
  }

  const content = choice?.message?.content || '';
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    // Try extracting JSON from markdown fences
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      parsed = JSON.parse(match[0]);
    } else {
      throw new Error('Failed to parse scope response');
    }
  }

  // Validate paths have reasons
  const validation = validatePaths(parsed.paths || []);
  if (!validation.valid) {
    console.log('[Scoping] Validation errors:', validation.errors);
    // Filter out invalid paths rather than failing
    parsed.paths = (parsed.paths || []).filter((p, i) => {
      const hasLabel = p.label?.trim();
      const hasSummary = p.summary?.trim();
      return hasLabel && hasSummary;
    });
  }

  // Truncate to max 4 paths, sorted by confidence
  if (parsed.paths.length > 4) {
    parsed.paths = parsed.paths
      .sort((a, b) => (b.confidence?.value || 0) - (a.confidence?.value || 0))
      .slice(0, 4);
    console.log('[Scoping] Truncated to 4 paths');
  }

  return {
    paths: parsed.paths || [],
    singlePath: parsed.singlePath || false,
    reasoning: parsed.reasoning || '',
    tokensUsed
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ASYNC SERVICE METHODS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Scope a node: classify it and generate paths if it's a decision node.
 *
 * @param {string} nodeId - Node ID to scope
 * @param {string} projectId - Project ID for ownership
 * @returns {Promise<{ node: Object, paths: Array, recommendation: Object, tokensUsed: number }>}
 */
async function scopeNode(nodeId, projectId) {
  const node = await Node.findOne({ _id: nodeId, projectId });
  if (!node) {
    throw new Error('Node not found');
  }

  // Classify the node
  const classification = classifyNodeKind(node);
  console.log(`[Scoping] Node "${node.title}" classified as ${classification.kind} (${classification.confidence.toFixed(2)})`);

  // Update nodeKind on the node
  node.nodeKind = classification.kind;

  // If component, no scoping needed
  if (classification.kind === 'component') {
    await node.save();
    return {
      node: node.toJSON(),
      paths: [],
      recommendation: null,
      tokensUsed: 0,
      classification
    };
  }

  // It's a decision node - generate paths
  const traceString = await identity.evaluateTraceForExpansion(node);

  // Get sibling context
  const siblings = await Node.find({
    projectId,
    parentNodeId: node.parentNodeId,
    _id: { $ne: node._id }
  }).limit(5).lean();

  // Scope the decision
  const scopeResult = await scopeDecisionNode(node, traceString, siblings);

  // If singlePath returned, convert to component (not a real fork)
  if (scopeResult.singlePath && scopeResult.paths.length === 1) {
    console.log(`[Scoping] Single path returned - treating as component`);
    node.nodeKind = 'component';
    await node.save();
    return {
      node: node.toJSON(),
      paths: [],
      recommendation: null,
      tokensUsed: scopeResult.tokensUsed,
      classification: { ...classification, kind: 'component', singlePath: true }
    };
  }

  // Rank paths and generate recommendation
  const rankedPaths = rankPaths(scopeResult.paths);
  const recommendation = generateRecommendation(rankedPaths);

  // Persist to node
  node.scopedPaths = rankedPaths.map(p => ({
    label: p.label,
    summary: p.summary,
    tradeoff: p.tradeoff,
    scores: p.scores,
    confidence: p.confidence,
    inferred: p.inferred !== false,
    chosen: false,
    roadNotTaken: false,
    chosenNodeId: null
  }));
  node.scopeRecommendation = recommendation;
  node.scoped = true;
  await node.save();

  return {
    node: node.toJSON(),
    paths: rankedPaths,
    recommendation,
    tokensUsed: scopeResult.tokensUsed,
    classification
  };
}

/**
 * Choose a path from a scoped decision node.
 * Creates the chosen path as a component child, marks others as road-not-taken.
 *
 * @param {string} nodeId - Decision node ID
 * @param {string} projectId - Project ID
 * @param {string} pathLabel - Label of the path to choose
 * @returns {Promise<{ chosenNode: Object, node: Object }>}
 */
async function choosePath(nodeId, projectId, pathLabel) {
  const node = await Node.findOne({ _id: nodeId, projectId });
  if (!node) {
    throw new Error('Node not found');
  }

  if (!node.scoped || !node.scopedPaths?.length) {
    throw new Error('Node has not been scoped');
  }

  // Find the path
  const pathIndex = node.scopedPaths.findIndex(p => p.label === pathLabel);
  if (pathIndex === -1) {
    throw new Error(`Path "${pathLabel}" not found`);
  }

  const chosenPath = node.scopedPaths[pathIndex];

  // Check if already chosen - idempotent return
  if (chosenPath.chosen && chosenPath.chosenNodeId) {
    const existingNode = await Node.findById(chosenPath.chosenNodeId);
    if (existingNode) {
      return { chosenNode: existingNode.toJSON(), node: node.toJSON() };
    }
  }

  // Create the chosen path as a component child node
  const childNodeData = {
    projectId: node.projectId,
    parentNodeId: node._id,
    kind: 'star',
    nodeKind: 'component', // Chosen paths become decomposable components
    title: chosenPath.label,
    statement: chosenPath.summary,
    scores: chosenPath.scores,
    confidence: chosenPath.confidence,
    stage: node.stage,
    status: 'unexplored',
    depth: (node.depth || 0) + 1,
    constellation: node.constellation,
    constellationLabel: node.constellationLabel,
    x: node.x + 150,
    y: node.y
  };

  const childNode = new Node(childNodeData);

  // Set up identity
  if (node.coreId && node.path) {
    const childPath = identity.buildChildPath(node, { _id: childNode._id, title: childNode.title });
    childNode.coreId = node.coreId;
    childNode.path = childPath;
    childNode.stableId = identity.computeStableId(node.coreId, childPath);
    childNode.essence = identity.freezeEssence(childNode);
    childNode.derivation = {
      kind: 'fork',
      sourcePrompt: `Chose path: ${pathLabel}`,
      usedTrace: true
    };
  }

  await childNode.save();

  // Mark this path as chosen, others as road-not-taken
  for (let i = 0; i < node.scopedPaths.length; i++) {
    if (i === pathIndex) {
      node.scopedPaths[i].chosen = true;
      node.scopedPaths[i].roadNotTaken = false;
      node.scopedPaths[i].chosenNodeId = childNode._id;
    } else {
      node.scopedPaths[i].roadNotTaken = true;
    }
  }

  // Mark parent as expanded
  node.expanded = true;
  await node.save();

  return {
    chosenNode: childNode.toJSON(),
    node: node.toJSON()
  };
}

/**
 * Re-select a road-not-taken path (changing direction).
 * The previously chosen path is NOT deleted - just marked road-not-taken.
 *
 * @param {string} nodeId - Decision node ID
 * @param {string} projectId - Project ID
 * @param {string} pathLabel - Label of the path to select
 * @returns {Promise<{ chosenNode: Object, node: Object }>}
 */
async function reselectPath(nodeId, projectId, pathLabel) {
  const node = await Node.findOne({ _id: nodeId, projectId });
  if (!node) {
    throw new Error('Node not found');
  }

  if (!node.scoped || !node.scopedPaths?.length) {
    throw new Error('Node has not been scoped');
  }

  const pathIndex = node.scopedPaths.findIndex(p => p.label === pathLabel);
  if (pathIndex === -1) {
    throw new Error(`Path "${pathLabel}" not found`);
  }

  // If this path was already chosen, just return it
  if (node.scopedPaths[pathIndex].chosen && node.scopedPaths[pathIndex].chosenNodeId) {
    const existingNode = await Node.findById(node.scopedPaths[pathIndex].chosenNodeId);
    if (existingNode) {
      return { chosenNode: existingNode.toJSON(), node: node.toJSON() };
    }
  }

  // Mark all paths as road-not-taken, then choose the new one
  for (let i = 0; i < node.scopedPaths.length; i++) {
    if (node.scopedPaths[i].chosen) {
      node.scopedPaths[i].chosen = false;
      node.scopedPaths[i].roadNotTaken = true;
    }
  }

  await node.save();

  // Now choose the new path (this handles creating the child node)
  return choosePath(nodeId, projectId, pathLabel);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  // Pure functions (testable)
  classifyNodeKind,
  rankPaths,
  blendScore,
  generateRecommendation,
  validatePaths,

  // LLM operations
  scopeDecisionNode,

  // Async service methods
  scopeNode,
  choosePath,
  reselectPath
};
