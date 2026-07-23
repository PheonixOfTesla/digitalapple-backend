/**
 * Blueprint - Main entry point for frame-aware map generation
 *
 * Flow:
 * 1. classifyPremise() - determine premise type
 * 2. loadFrame() - get appropriate frame template
 * 3. generateFramedNebula() - generate map with frame context
 * 4. Log orphans/straddles for template improvement
 */

const { classifyPremise } = require('./blueprintClassify');
const { loadFrame, buildNebulaFrameInput } = require('./frameLoader');
const { generateFramedNebula, judgeNodeTerminal } = require('./blueprintNebula');
const Project = require('../models/Project');
const OrphanLog = require('../models/OrphanLog');

/**
 * Generate a map from a premise using frame-aware classification.
 *
 * @param {string} premise - The user's premise text
 * @param {string} projectId - Project ID to store classification on
 * @returns {object} Generated nebula map
 */
async function generateMap(premise, projectId) {
  // 1. Classify the premise
  const classification = await classifyPremise(premise);
  console.log(`[Blueprint] Classified "${premise.substring(0, 50)}..." as ${classification.type} (${classification.confidence})`);

  // 2. Load the appropriate frame
  const { frame, meta } = loadFrame(classification);
  console.log(`[Blueprint] Using frame: ${frame.label}, fallback: ${meta.usedFallback}, straddle: ${meta.isStraddle}`);

  // Determination: what this map resolves TOWARD (PART 3)
  const determination = classification.determination === 'overview' ? 'overview' : 'actionable';
  console.log(`[Blueprint] Determination: ${determination}`);

  // 3. Store classification on project
  if (projectId) {
    await Project.findByIdAndUpdate(projectId, {
      'blueprint.classification': classification,
      'blueprint.frameMeta': meta,
      'blueprint.determination': determination,
      'blueprint.stagesEnabled': frame.stagesEnabled
    });
  }

  // 4. Build nebula input with frame context + determination
  const frameInput = buildNebulaFrameInput(frame, premise, determination);

  // 5. Generate the map
  const map = await generateFramedNebula(frameInput);

  // Attach classification + frame meta so the controller persists the real
  // type on the Core (previously always defaulted to 'unknown').
  map.classification = {
    type: classification.type,
    confidence: classification.confidence,
    alternates: classification.alternates || [],
    reasoning: classification.reasoning || ''
  };
  map.frameMeta = meta;
  map.determination = determination;

  // 6. Log orphans, straddles, and low-confidence for review
  if (meta.usedFallback || meta.isStraddle || classification.confidence < 0.7) {
    await logForReview(premise, classification, meta);
  }

  return map;
}

/**
 * Log premises that need review for template improvement.
 */
async function logForReview(premise, classification, meta) {
  try {
    let reason = 'low-confidence';
    if (meta.usedFallback) reason = 'fallback';
    else if (meta.isStraddle) reason = 'straddle';

    await OrphanLog.create({
      premise,
      classification,
      meta,
      reason,
      timestamp: new Date()
    });

    console.log(`[Blueprint] Logged ${reason} premise for review`);
  } catch (err) {
    // Don't fail generation if logging fails
    console.error('[Blueprint] Failed to log orphan:', err.message);
  }
}

/**
 * Get classification without generating a map.
 * Useful for previewing what type a premise would be classified as.
 */
async function previewClassification(premise) {
  const classification = await classifyPremise(premise);
  const { frame, meta } = loadFrame(classification);

  return {
    classification,
    frame: {
      label: frame.label,
      description: frame.description,
      stagesEnabled: frame.stagesEnabled,
      rootLabels: frame.roots.map(r => r.label).filter(Boolean)
    },
    meta
  };
}

// ============== INFINITE RECURSION ENGINE ==============

/**
 * Decide expansion mode: sub-nebula (A) or star-children (B).
 *
 * Biased heavily toward B (star-children). Sub-nebula only when:
 * - Node statement is 10+ words AND
 * - Node is at depth 0 or 1 AND
 * - Classification returns confidence > 0.7 on a known type
 *
 * @param {object} node - The node to expand
 * @returns {Promise<{mode: 'sub-nebula'|'star-children', classification?: object}>}
 */
async function decideExpansionMode(node) {
  const statement = node.statement || node.title || '';
  const wordCount = statement.trim().split(/\s+/).length;
  const depth = node.depth || 0;

  // Quick checks: bias toward star-children
  if (wordCount < 10) {
    console.log(`[Blueprint:Recursion] B (star-children): statement too short (${wordCount} words)`);
    return { mode: 'star-children' };
  }

  if (depth > 1) {
    console.log(`[Blueprint:Recursion] B (star-children): too deep (depth ${depth})`);
    return { mode: 'star-children' };
  }

  // Depth 0-1 and 10+ words: check classification confidence
  try {
    const classification = await classifyPremise(statement);

    if (classification.type !== 'unknown' && classification.confidence > 0.7) {
      console.log(`[Blueprint:Recursion] A (sub-nebula): ${classification.type} @ ${classification.confidence}`);
      return { mode: 'sub-nebula', classification };
    }

    console.log(`[Blueprint:Recursion] B (star-children): low confidence (${classification.confidence})`);
    return { mode: 'star-children', classification };

  } catch (err) {
    console.error('[Blueprint:Recursion] Classification failed, defaulting to B:', err.message);
    return { mode: 'star-children' };
  }
}

/**
 * Judge if a node is terminal (resolved endpoint, should not expand).
 *
 * Delegates to the determination-aware judge (PART 2/3):
 *   - actionable maps terminate at concrete doable steps
 *   - overview maps terminate at evidenced findings
 *
 * Determination is read from the node (denormalized from Core); defaults to
 * actionable for legacy nodes without the field.
 *
 * @param {object} node - The node to judge (must carry depth; determination optional)
 * @param {'actionable'|'overview'} [determinationOverride]
 * @returns {Promise<{terminal: boolean, reason: string, action: string|null}>}
 */
async function judgeTerminal(node, determinationOverride = null) {
  const depth = node.depth || 0;
  const determination = determinationOverride
    || node.determination
    || 'actionable';

  // Evaluate at the node's real depth. Core/root (depth 0/1) are branch points
  // and won't qualify as terminal; leaves (depth 2+) resolve when grounded.
  const result = judgeNodeTerminal(node, depth, determination);
  return {
    terminal: result.terminal,
    reason: result.reason,
    action: result.action
  };
}

/**
 * Expand a node as a sub-nebula (mode A).
 * Runs the full classify → frame → nebula pipeline on the node's statement.
 *
 * @param {object} node - The node to expand
 * @param {object} classification - Pre-computed classification (optional)
 * @returns {Promise<object>} Generated sub-nebula
 */
async function expandAsSubNebula(node, classification = null) {
  const premise = node.statement || node.title;

  // Use provided classification or classify fresh
  const classResult = classification || await classifyPremise(premise);

  // Load frame for this type
  const { frame, meta } = loadFrame(classResult);
  console.log(`[Blueprint:SubNebula] Frame: ${frame.label}, type: ${classResult.type}`);

  // Build nebula input
  const frameInput = buildNebulaFrameInput(frame, premise);

  // Generate the sub-nebula
  const nebula = await generateFramedNebula(frameInput);

  return {
    nebula,
    classification: classResult,
    frame: {
      type: meta.selectedType,
      label: frame.label,
      stagesEnabled: frame.stagesEnabled
    }
  };
}

/**
 * Main entry point: expand a node using the appropriate mode.
 *
 * @param {object} node - The node to expand
 * @param {boolean} forceStarChildren - Skip A/B decision, use star-children
 * @returns {Promise<object>} Expansion result
 */
async function expandNode(node, forceStarChildren = false) {
  // First check if terminal
  const terminalResult = await judgeTerminal(node);
  if (terminalResult.terminal) {
    console.log(`[Blueprint:Recursion] Terminal: ${terminalResult.reason}`);
    return {
      terminal: true,
      reason: terminalResult.reason,
      children: [],
      expansionType: null
    };
  }

  // Decide expansion mode (unless forced to star-children)
  if (forceStarChildren) {
    return {
      terminal: false,
      expansionType: 'star-children',
      // Actual children generation happens in controller via existing expandStar
    };
  }

  const { mode, classification } = await decideExpansionMode(node);

  if (mode === 'sub-nebula') {
    const result = await expandAsSubNebula(node, classification);
    return {
      terminal: false,
      expansionType: 'sub-nebula',
      subFrameType: result.classification.type,
      nebula: result.nebula,
      frame: result.frame
    };
  }

  // star-children mode
  return {
    terminal: false,
    expansionType: 'star-children',
    // Actual children generation happens in controller via existing expandStar
  };
}

// ============== DEPTH-RELATIVE COVERAGE ==============

const Node = require('../models/Node');

/**
 * Calculate coverage for a specific node's children.
 * Coverage is computed on explored (expanded) nodes only.
 *
 * Formula: min(1, answered/3) × mean(confidence)
 * - answered = children with confidence >= 0.5
 * - mean confidence = average confidence of all children
 * - Unexpanded children don't count against coverage
 *
 * @param {string} nodeId - The parent node ID
 * @returns {Promise<{coverage: number, explored: number, total: number}>}
 */
async function calculateNodeCoverage(nodeId) {
  // Get direct children of this node
  const children = await Node.find({ parentNodeId: nodeId }).lean();

  if (children.length === 0) {
    return { coverage: 0, explored: 0, total: 0 };
  }

  // Only count expanded children (explored)
  const exploredChildren = children.filter(c => c.expanded);

  if (exploredChildren.length === 0) {
    // No children explored yet - coverage is 0 but not "incomplete"
    return {
      coverage: 0,
      explored: 0,
      total: children.length,
      unexplored: children.length
    };
  }

  // Answered = children with confidence >= 0.5
  const answered = exploredChildren.filter(c => (c.confidence?.value || 0) >= 0.5).length;

  // Mean confidence of explored children
  const confidenceSum = exploredChildren.reduce((sum, c) => sum + (c.confidence?.value || 0), 0);
  const meanConfidence = confidenceSum / exploredChildren.length;

  // Formula: min(1, answered/3) × meanConfidence
  const coverage = Math.min(1, answered / 3) * meanConfidence;

  return {
    coverage,
    explored: exploredChildren.length,
    total: children.length,
    unexplored: children.length - exploredChildren.length
  };
}

/**
 * Calculate coverage for a project's top-level roots.
 * Same formula as calculateNodeCoverage but for depth 0 nodes.
 *
 * @param {string} projectId - The project ID
 * @returns {Promise<object>} Coverage info
 */
async function calculateProjectCoverage(projectId) {
  // Get all nodes at depth 0 and 1 (core + constellations)
  const roots = await Node.find({
    projectId,
    kind: { $in: ['core', 'constellation'] }
  }).lean();

  const constellations = roots.filter(r => r.kind === 'constellation');

  if (constellations.length === 0) {
    return { coverage: 0, byConstellation: {}, explored: 0, total: 0 };
  }

  // Group by constellation
  const byConstellation = {};
  const constellationTypes = ['offer', 'demand', 'delivery', 'economy', 'orchestration', 'risk'];

  for (const type of constellationTypes) {
    const typeNodes = constellations.filter(c => c.constellation === type);

    if (typeNodes.length === 0) {
      byConstellation[type] = 0;
      continue;
    }

    // Only count expanded nodes
    const explored = typeNodes.filter(n => n.expanded);

    if (explored.length === 0) {
      byConstellation[type] = 0;
      continue;
    }

    const answered = explored.filter(n => (n.confidence?.value || 0) >= 0.5).length;
    const confidenceSum = explored.reduce((sum, n) => sum + (n.confidence?.value || 0), 0);
    const meanConfidence = confidenceSum / explored.length;

    byConstellation[type] = Math.min(1, answered / 3) * meanConfidence;
  }

  // Total coverage = mean of all constellations
  const totalCoverage = Object.values(byConstellation).reduce((a, b) => a + b, 0) / constellationTypes.length;

  return {
    coverage: totalCoverage,
    byConstellation,
    explored: constellations.filter(c => c.expanded).length,
    total: constellations.length
  };
}

/**
 * Calculate resolution gauge for a project.
 * Resolution = how far the map has walked toward actual behavior.
 *
 * Unlike coverage (how explored), resolution measures how REAL:
 * - Only counts LIVE nodes (non-dormant, non-rejected)
 * - Measures what fraction of leaf branches are WALLED (terminal)
 * - Weighted by grounding (confidence)
 *
 * HONESTY RULE:
 * - Dormant nodes (basis 'unknown') do NOT contribute
 * - Adding dormant nodes cannot raise the gauge
 * - Only grounded terminal nodes increase resolution
 *
 * @param {string} projectId - The project ID
 * @returns {Promise<{resolution: number, walledCount: number, liveCount: number, dormantCount: number}>}
 */
async function calculateResolution(projectId) {
  // Get all nodes for this project
  const allNodes = await Node.find({ projectId }).lean();

  if (allNodes.length === 0) {
    return { resolution: 0, walledCount: 0, liveCount: 0, dormantCount: 0 };
  }

  // Build parent-child lookup to identify leaf nodes
  const childrenOf = new Map();
  for (const node of allNodes) {
    const parentId = node.parentNodeId?.toString();
    if (parentId) {
      if (!childrenOf.has(parentId)) {
        childrenOf.set(parentId, []);
      }
      childrenOf.get(parentId).push(node);
    }
  }

  // Categorize nodes by liveness
  let walledCount = 0;
  let walledWeight = 0;
  let liveCount = 0;
  let liveWeight = 0;
  let dormantCount = 0;

  for (const node of allNodes) {
    // Skip rejected nodes
    if (node.kind === 'rejected') continue;

    const basis = node.confidence?.basis || 'unknown';
    const confidence = node.confidence?.value || 0;
    const isTerminal = node.terminal || false;
    const nodeId = node._id.toString();

    // Check if this is a leaf (no children) or terminal
    const hasChildren = childrenOf.has(nodeId) && childrenOf.get(nodeId).length > 0;
    const isLeafOrTerminal = !hasChildren || isTerminal;

    if (basis === 'unknown' && !isTerminal) {
      // DORMANT: has identity but no content - does NOT contribute
      dormantCount++;
      continue;
    }

    if (isTerminal) {
      // WALLED: arrived at an actionable element
      walledCount++;
      walledWeight += confidence;
      liveCount++;
      liveWeight += confidence;
    } else if (isLeafOrTerminal && basis !== 'unknown') {
      // OPEN leaf: grounded but could go deeper - contributes to live but not walled
      liveCount++;
      liveWeight += confidence;
    }
    // Non-leaf open nodes are branches, not endpoints - don't count as "needing to reach wall"
  }

  // Resolution = (walled weight) / (live weight)
  // This is the fraction of live grounding that has reached walls
  const resolution = liveWeight > 0 ? walledWeight / liveWeight : 0;

  return {
    resolution: Math.round(resolution * 100) / 100, // 0.00 - 1.00
    walledCount,
    liveCount,
    dormantCount
  };
}

module.exports = {
  generateMap,
  previewClassification,
  decideExpansionMode,
  judgeTerminal,
  expandAsSubNebula,
  expandNode,
  calculateNodeCoverage,
  calculateProjectCoverage,
  calculateResolution
};
