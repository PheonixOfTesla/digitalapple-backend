/**
 * Self-Rescoping Engine - The plan reshapes as defining questions get answered
 *
 * CORE PRINCIPLE: Re-scoping is EXTEND-AND-FLAG, never delete.
 * - New nodes extend paths
 * - Obsolete nodes get kind='road-not-taken' but stay in trace
 * - Survivor identity (stableId/path) NEVER mutates
 *
 * The engine:
 * 1. Detects DEFINING questions (decision nodes with disjoint branches)
 * 2. Re-scopes when defining questions are answered (archive unchosen, generate new)
 * 3. Provides continuous completeness feedback with downstream weighting
 * 4. Routes to next gap (fill-and-advance)
 * 5. Tracks PDF-readiness (defining questions + core constellations specified)
 */

const identity = require('./identity');
const scoping = require('./scoping');
const Node = require('../models/Node');
const Edge = require('../models/Edge');
const Core = require('../models/Core');

// Lazy-load AI client to avoid module load failures if API key is missing
let aiClient = null;
let aiModel = null;
let BLUEPRINT_SYSTEM_PREFIX = null;

function getAIClient() {
  if (!aiClient) {
    const ai = require('./aiClient');
    aiClient = ai.client;
    aiModel = ai.model;
    BLUEPRINT_SYSTEM_PREFIX = require('./blueprintPrompts').BLUEPRINT_SYSTEM_PREFIX;
  }
  return { client: aiClient, model: aiModel, prefix: BLUEPRINT_SYSTEM_PREFIX };
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 1: DEFINING-QUESTION DETECTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if a node is a DEFINING question.
 * Defining = decision node with ≥2 mutually-exclusive branches whose
 * downstream requirements are disjoint (answering one invalidates others).
 *
 * @param {Object} node - Node to check
 * @param {Array} allNodes - All nodes in the project
 * @returns {{ isDefining: boolean, reason: string, branches: number }}
 */
function isDefiningQuestion(node, allNodes = []) {
  // Must be a decision node
  if (node.nodeKind !== 'decision') {
    return { isDefining: false, reason: 'not_decision_node', branches: 0 };
  }

  // Must have scoped paths with ≥2 alternatives
  const paths = node.scopedPaths || [];
  if (paths.length < 2) {
    return { isDefining: false, reason: 'insufficient_paths', branches: paths.length };
  }

  // Check for mutual exclusivity via tradeoffs
  // If paths have explicit tradeoffs mentioning what you "lose", they're disjoint
  const hasTradeoffs = paths.filter(p => p.tradeoff && p.tradeoff.length > 10).length >= 2;

  // Check if paths represent fundamentally different directions
  // (e.g., "physical" vs "mobile" - not just variations of same approach)
  const labels = paths.map(p => (p.label || '').toLowerCase());
  const hasDisjointLabels = detectDisjointLabels(labels);

  if (hasTradeoffs || hasDisjointLabels) {
    return {
      isDefining: true,
      reason: hasTradeoffs ? 'has_tradeoffs' : 'disjoint_labels',
      branches: paths.length
    };
  }

  return { isDefining: false, reason: 'paths_not_disjoint', branches: paths.length };
}

/**
 * Detect if path labels represent disjoint/mutually-exclusive options.
 * @param {Array<string>} labels - Path labels
 * @returns {boolean}
 */
function detectDisjointLabels(labels) {
  const disjointPatterns = [
    // Location/format dichotomies
    [/physical|brick|storefront|retail/, /mobile|digital|online|virtual/],
    [/local|regional/, /national|global/],
    // Business model dichotomies
    [/b2b|enterprise|business/, /b2c|consumer|retail/],
    [/subscription|recurring/, /one.?time|transactional/],
    [/premium|luxury|high.?end/, /budget|affordable|mass/],
    // Operational dichotomies
    [/in.?house|internal/, /outsource|partner|third.?party/],
    [/manual|hands.?on/, /automated|self.?serve/],
    [/solo|individual/, /team|collaborative/],
  ];

  for (const [pattern1, pattern2] of disjointPatterns) {
    const matches1 = labels.some(l => pattern1.test(l));
    const matches2 = labels.some(l => pattern2.test(l));
    if (matches1 && matches2) {
      return true;
    }
  }

  // Check for explicit "vs" or "or" in any label
  if (labels.some(l => /\bvs\.?\b|\bor\b/.test(l))) {
    return true;
  }

  return false;
}

/**
 * Get all defining questions from nodes array, sorted by importance.
 * Defining questions are surfaced BEFORE ordinary detail gaps.
 *
 * @param {Array} allNodes - All nodes in the project
 * @param {Array} edges - All edges (optional, for downstream analysis)
 * @returns {Array} - Defining question nodes, sorted by depth (shallower first)
 */
function getDefiningQuestions(allNodes, edges = []) {
  // Filter to decision nodes that are scoped
  const decisionNodes = allNodes.filter(n =>
    n.nodeKind === 'decision' &&
    n.kind !== 'road-not-taken' &&
    n.scoped === true
  );

  const defining = [];
  for (const node of decisionNodes) {
    const result = isDefiningQuestion(node, allNodes, edges);
    if (result.isDefining) {
      // Only include if not yet answered (no chosen path)
      const hasChosenPath = (node.scopedPaths || []).some(p => p.chosen);
      if (!hasChosenPath) {
        defining.push({
          ...node,
          definingReason: result.reason,
          branches: result.branches,
          weight: calculateNodeWeight(node, allNodes, edges),
          priority: (node.depth || 0) * -1 + (result.branches || 0) // Higher branches + shallower = higher priority
        });
      }
    }
  }

  // Sort by depth (shallower = more defining) then by confidence
  return defining.sort((a, b) => {
    if ((a.depth || 0) !== (b.depth || 0)) {
      return (a.depth || 0) - (b.depth || 0);
    }
    return (b.confidence?.value || 0) - (a.confidence?.value || 0);
  });
}

/**
 * Get all gap nodes (dormant/incomplete), with defining questions first.
 * @param {Array} allNodes - All nodes in the project
 * @returns {{ defining: Array, detail: Array, total: number }}
 */
function getGapsWithPriority(allNodes, edges = []) {
  const defining = getDefiningQuestions(allNodes, edges);
  const definingIds = new Set(defining.map(n => n._id.toString()));

  // Get all dormant/incomplete nodes that aren't core or road-not-taken
  const activeNodes = allNodes.filter(n =>
    n.kind !== 'core' &&
    n.kind !== 'road-not-taken' &&
    n.kind !== 'rejected'
  );

  const allGaps = activeNodes.filter(n =>
    n.liveness === 'dormant' ||
    n.confidence?.basis === 'unknown' ||
    (n.terminal !== true && n.liveness !== 'walled')
  );

  // Sort by depth
  allGaps.sort((a, b) => (a.depth || 0) - (b.depth || 0));

  // Split into defining vs detail
  const detail = allGaps.filter(n => !definingIds.has(n._id.toString()));

  return {
    defining,
    detail,
    total: defining.length + detail.length
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 2: CONDITIONAL RE-SCOPING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Archive nodes by trace - any node whose path passes through an unchosen branch.
 * NEVER deletes - just flags as 'road-not-taken'.
 *
 * @param {string} projectId - Project ID
 * @param {string} decisionNodeId - The decision node that was answered
 * @param {string} chosenPathLabel - Label of the chosen path
 * @returns {Promise<{ archived: Array, archivedCount: number }>}
 */
async function archiveUnchosenBranches(projectId, decisionNodeId, chosenPathLabel) {
  const decisionNode = await Node.findById(decisionNodeId);
  if (!decisionNode || !decisionNode.scopedPaths) {
    return { archived: [], archivedCount: 0 };
  }

  // Find unchosen path labels
  const unchosenLabels = decisionNode.scopedPaths
    .filter(p => p.label !== chosenPathLabel)
    .map(p => p.label);

  if (unchosenLabels.length === 0) {
    return { archived: [], archivedCount: 0 };
  }

  // Find nodes created from unchosen paths (by checking chosenNodeId on scopedPaths)
  const unchosenNodeIds = decisionNode.scopedPaths
    .filter(p => p.label !== chosenPathLabel && p.chosenNodeId)
    .map(p => p.chosenNodeId);

  if (unchosenNodeIds.length === 0) {
    return { archived: [], archivedCount: 0 };
  }

  // Get all descendants of unchosen nodes
  const toArchive = [];
  for (const nodeId of unchosenNodeIds) {
    toArchive.push(nodeId);
    const descendants = await identity.getDescendants(nodeId, projectId);
    toArchive.push(...descendants);
  }

  if (toArchive.length === 0) {
    return { archived: [], archivedCount: 0 };
  }

  // Archive by setting kind='road-not-taken' - NEVER delete
  // Preserve stableId, path - identity stays intact
  const result = await Node.updateMany(
    { _id: { $in: toArchive }, projectId },
    {
      $set: {
        kind: 'road-not-taken',
        archivedAt: new Date(),
        archivedReason: `Unchosen branch: ${unchosenLabels.join(', ')}`
      }
    }
  );

  // Get archived node data for acknowledgment message
  const archivedNodes = await Node.find({ _id: { $in: toArchive } }).lean();

  return {
    archived: archivedNodes.map(n => ({
      id: n._id,
      title: n.title,
      constellation: n.constellation,
      stableId: n.stableId // Preserved!
    })),
    archivedCount: result.modifiedCount
  };
}

/**
 * Re-scope after answering a defining question.
 * - Archives unchosen branches (flags, never deletes)
 * - Generates new gaps from chosen branch
 * - Updates core summary
 * - Returns acknowledgment data
 *
 * IDENTITY GUARD: Assert no survivor's stableId changed.
 *
 * @param {string} projectId - Project ID
 * @param {string} decisionNodeId - Decision node that was answered
 * @param {string} chosenPathLabel - Label of chosen path
 * @returns {Promise<Object>} - Re-scope result with acknowledgment data
 */
async function rescopeOnDefiningAnswer(projectId, decisionNodeId, chosenPathLabel) {
  // Snapshot survivor stableIds BEFORE re-scope
  const survivorsBefore = await Node.find({
    projectId,
    kind: { $nin: ['road-not-taken', 'rejected'] }
  }).select('_id stableId title').lean();
  const stableIdsBefore = new Map(
    survivorsBefore.map(n => [n._id.toString(), n.stableId])
  );

  // 1. Archive unchosen branches
  const archiveResult = await archiveUnchosenBranches(projectId, decisionNodeId, chosenPathLabel);

  // 2. Get the chosen node (created by choosePath)
  const decisionNode = await Node.findById(decisionNodeId);
  const chosenPath = decisionNode.scopedPaths?.find(p => p.label === chosenPathLabel);
  const chosenNodeId = chosenPath?.chosenNodeId;

  let newGaps = [];
  if (chosenNodeId) {
    // 3. Generate new gaps by expanding the chosen node
    // The chosen node is now a component - it can be decomposed
    const chosenNode = await Node.findById(chosenNodeId);
    if (chosenNode && chosenNode.nodeKind === 'component' && !chosenNode.expanded) {
      // Trigger expansion to generate sub-gaps
      // This uses the existing expand logic which respects identity
      newGaps = await getNewGapsFromExpansion(chosenNode);
    }
  }

  // 4. Update core summary with resolved direction
  const coreUpdateResult = await updateCoreSummary(projectId, decisionNode, chosenPathLabel);

  // 5. IDENTITY GUARD: Verify survivor stableIds unchanged
  const survivorsAfter = await Node.find({
    projectId,
    kind: { $nin: ['road-not-taken', 'rejected'] }
  }).select('_id stableId title').lean();

  const identityViolations = [];
  for (const survivor of survivorsAfter) {
    const beforeId = stableIdsBefore.get(survivor._id.toString());
    if (beforeId && beforeId !== survivor.stableId) {
      identityViolations.push({
        nodeId: survivor._id,
        title: survivor.title,
        before: beforeId,
        after: survivor.stableId
      });
    }
  }

  if (identityViolations.length > 0) {
    console.error('[RESCOPE] IDENTITY VIOLATION - stableIds mutated:', identityViolations);
    // This should never happen - throw to catch bugs
    throw new Error(`Identity violation: ${identityViolations.length} stableIds changed during re-scope`);
  }

  // 6. Build acknowledgment message
  const acknowledgment = buildAcknowledgment(
    chosenPathLabel,
    archiveResult.archived,
    newGaps,
    projectId
  );

  return {
    success: true,
    chosenPath: chosenPathLabel,
    archived: archiveResult.archived,
    archivedCount: archiveResult.archivedCount,
    newGaps,
    newGapCount: newGaps.length,
    coreUpdated: coreUpdateResult.updated,
    acknowledgment,
    identityVerified: true
  };
}

/**
 * Get new gaps that would be generated from expanding a node.
 * (Placeholder - will be populated when expansion happens)
 * @param {Object} node - Node to check for expansion gaps
 * @returns {Promise<Array>}
 */
async function getNewGapsFromExpansion(node) {
  // New gaps come from the expansion process
  // For now, return empty - gaps appear when user expands the chosen node
  return [];
}

/**
 * Update core summary to reflect resolved direction.
 * @param {string} projectId - Project ID
 * @param {Object} decisionNode - Decision node that was answered
 * @param {string} chosenPathLabel - Chosen path label
 * @returns {Promise<{ updated: boolean, newSummary?: string }>}
 */
async function updateCoreSummary(projectId, decisionNode, chosenPathLabel) {
  const core = await Core.findOne({ projectId });
  if (!core) {
    return { updated: false };
  }

  // Add resolved decision to core's resolvedDirections
  const resolvedDirection = {
    nodeId: decisionNode._id,
    nodeTitle: decisionNode.title,
    chosenPath: chosenPathLabel,
    resolvedAt: new Date()
  };

  if (!core.resolvedDirections) {
    core.resolvedDirections = [];
  }
  core.resolvedDirections.push(resolvedDirection);
  await core.save();

  return { updated: true, resolvedDirection };
}

/**
 * Build acknowledgment message from re-scope results.
 * @param {string} nodeTitle - Title of the node being answered
 * @param {string} chosenLabel - Chosen path label
 * @param {Object} result - Re-scope result
 * @returns {string}
 */
function buildAcknowledgment(nodeTitle, chosenLabel, result) {
  let message = `Locked in: "${chosenLabel}" for ${nodeTitle}.`;

  if (result.archivedCount > 0) {
    message += ` Set aside ${result.archivedCount} alternate path${result.archivedCount !== 1 ? 's' : ''}.`;
  }

  return message;
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 3: CONTINUOUS COMPLETENESS FEEDBACK
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Calculate completeness with downstream weighting.
 * Defining questions are weighted by their downstream impact.
 *
 * @param {Array} allNodes - All nodes in the project
 * @param {Array} edges - All edges (optional)
 * @param {Object} coreDoc - Core document (optional)
 * @returns {Object} - Completeness data
 */
function calculateCompleteness(allNodes, edges = [], coreDoc = null) {
  // Filter out archived nodes
  const activeNodes = allNodes.filter(n =>
    n.kind !== 'road-not-taken' && n.kind !== 'rejected'
  );

  if (activeNodes.length === 0) {
    return {
      percent: 0,
      gapCount: 0,
      specifiedCount: 0,
      totalWeight: 0,
      message: 'No nodes yet'
    };
  }

  const nonCoreNodes = activeNodes.filter(n => n.kind !== 'core');

  // Calculate base completeness
  let totalWeight = 0;
  let specifiedWeight = 0;
  let gapCount = 0;
  let specifiedCount = 0;

  for (const node of nonCoreNodes) {
    const isGap = isNodeAGap(node);
    const weight = calculateNodeWeight(node, activeNodes, edges);

    totalWeight += weight;

    if (isGap) {
      gapCount++;
    } else {
      specifiedWeight += weight;
      specifiedCount++;
    }
  }

  // Calculate percentage
  const percent = totalWeight > 0
    ? Math.round((specifiedWeight / totalWeight) * 100)
    : 0;

  // Build message
  let message = '';
  if (percent === 0) {
    message = 'Just getting started';
  } else if (percent < 25) {
    message = 'Foundation laid';
  } else if (percent < 50) {
    message = 'Making progress';
  } else if (percent < 75) {
    message = 'More than halfway';
  } else if (percent < 100) {
    message = 'Almost there';
  } else {
    message = 'Complete';
  }

  return {
    percent,
    gapCount,
    specifiedCount,
    totalNodes: nonCoreNodes.length,
    totalWeight: Math.round(totalWeight * 100) / 100,
    specifiedWeight: Math.round(specifiedWeight * 100) / 100,
    message
  };
}

/**
 * Check if a node is a gap (needs to be filled).
 * @param {Object} node - Node to check
 * @returns {boolean}
 */
function isNodeAGap(node) {
  // Dormant nodes are gaps
  if (node.liveness === 'dormant') return true;

  // Unknown confidence basis means unspecified
  if (node.confidence?.basis === 'unknown') return true;

  // Decision nodes that haven't been scoped or chosen are gaps
  if (node.nodeKind === 'decision' && node.scoped && !hasChosenPath(node)) {
    return true;
  }

  return false;
}

/**
 * Check if a node has a chosen path (for decision nodes).
 */
function hasChosenPath(node) {
  return (node.scopedPaths || []).some(p => p.chosen);
}

/**
 * Calculate weight for a node (for completeness).
 * Defining questions get higher weight due to downstream impact.
 *
 * @param {Object} node - Node to weight
 * @param {Array} allNodes - All nodes for context
 * @returns {number}
 */
function calculateNodeWeight(node, allNodes) {
  let baseWeight = 1;

  // Decision nodes with scoped paths get higher weight
  if (node.nodeKind === 'decision' && node.scoped) {
    const result = isDefiningQuestion(node, allNodes);
    if (result.isDefining) {
      // Defining questions weighted by number of branches
      // More branches = more downstream impact
      baseWeight = 1 + (result.branches * 0.5);
    } else {
      baseWeight = 1.5;
    }
  }

  // Constellation nodes (direct children of core) slightly weighted
  if (node.kind === 'constellation') {
    baseWeight *= 1.2;
  }

  return baseWeight;
}

/**
 * Check for milestone achievements.
 * @param {Object} completeness - Completeness data
 * @returns {Object}
 */
function checkMilestones(completeness) {
  const milestones = {
    reached: [],
    next: null
  };

  const percent = completeness.percent || 0;

  // Milestone thresholds
  const thresholds = [
    { at: 25, label: 'Foundation', message: 'Core structure defined' },
    { at: 50, label: 'Halfway', message: 'Half specified' },
    { at: 75, label: 'Most Done', message: 'Three-quarters complete' },
    { at: 100, label: 'Complete', message: 'Fully specified' }
  ];

  for (const t of thresholds) {
    if (percent >= t.at) {
      milestones.reached.push(t);
    } else if (!milestones.next) {
      milestones.next = { ...t, remaining: t.at - percent };
    }
  }

  return milestones;
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 4: FILL-AND-ADVANCE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get the next gap to fill, prioritizing defining questions.
 * @param {Array} allNodes - All nodes
 * @param {Array} edges - All edges
 * @param {string} currentNodeId - Current node (to skip)
 * @returns {Object|null} - Next gap node or null if complete
 */
function getNextGap(allNodes, edges = [], currentNodeId = null) {
  const gaps = getGapsWithPriority(allNodes, edges);

  // Filter out current node
  const allGaps = [...gaps.defining, ...gaps.detail]
    .filter(n => n._id.toString() !== currentNodeId);

  if (allGaps.length === 0) {
    return null;
  }

  // Return first (highest priority)
  return allGaps[0];
}

/**
 * Route to next gap after filling one.
 * Returns routing data for frontend navigation.
 *
 * @param {Object} nextGap - Next gap node
 * @param {Array} allNodes - All nodes
 * @param {Array} edges - All edges
 * @returns {Object}
 */
function routeToNextGap(nextGap, allNodes, edges = []) {
  if (!nextGap) {
    return {
      complete: true,
      action: 'done',
      message: 'All gaps filled'
    };
  }

  const isDefining = isDefiningQuestion(nextGap, allNodes, edges);

  return {
    complete: false,
    action: isDefining.isDefining ? 'define' : 'fill',
    nextGap: {
      id: nextGap._id,
      title: nextGap.title,
      constellation: nextGap.constellation,
      isDefining: isDefining.isDefining,
      territory: nextGap.territory,
      invitation: nextGap.invitation
    },
    message: isDefining.isDefining
      ? `Next: defining question — ${nextGap.title}`
      : `Next gap: ${nextGap.title}`
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 5: PDF-READINESS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if plan is PDF-ready.
 * Ready = all defining questions answered + core constellations specified.
 * NOT requiring 100% detail gaps.
 *
 * @param {Array} allNodes - All nodes in the project
 * @param {Array} edges - All edges
 * @param {Object} coreDoc - Core document (optional)
 * @returns {Object}
 */
function checkPDFReadiness(allNodes, edges = [], coreDoc = null) {
  // Filter active nodes
  const activeNodes = allNodes.filter(n =>
    n.kind !== 'road-not-taken' && n.kind !== 'rejected'
  );

  const coreNode = activeNodes.find(n => n.kind === 'core');
  if (!coreNode) {
    return { ready: false, status: 'not_ready', reason: 'no_core', blockers: ['No core node'] };
  }

  const blockers = [];

  // Check 1: All defining questions answered
  const definingQuestions = getDefiningQuestions(activeNodes, edges);
  if (definingQuestions.length > 0) {
    blockers.push(`${definingQuestions.length} defining question${definingQuestions.length !== 1 ? 's' : ''} remaining`);
  }

  // Check 2: Core constellations specified
  const constellations = activeNodes.filter(n => n.kind === 'constellation');
  const coreConstellations = ['demand', 'offer', 'delivery', 'economy', 'orchestration'];

  const unspecifiedConstellations = constellations.filter(c => {
    const isCoreConstellation = coreConstellations.includes(c.constellation?.toLowerCase());
    const isGap = isNodeAGap(c);
    return isCoreConstellation && isGap;
  });

  if (unspecifiedConstellations.length > 0) {
    blockers.push(`Core sections incomplete: ${unspecifiedConstellations.map(c => c.constellation || c.title).join(', ')}`);
  }

  // Determine status
  if (blockers.length === 0) {
    const gaps = getGapsWithPriority(activeNodes, edges);
    return {
      ready: true,
      status: 'ready',
      message: 'Ready to export',
      detailGapsRemaining: gaps.detail.length,
      blockers: []
    };
  }

  return {
    ready: false,
    status: definingQuestions.length > 0 ? 'not_ready' : 'getting_there',
    reason: definingQuestions.length > 0 ? 'defining_questions_remain' : 'constellations_incomplete',
    blockers,
    message: blockers[0]
  };
}

/**
 * Get export readiness state for UI.
 * @param {Object} readiness - Readiness from checkPDFReadiness
 * @returns {Object}
 */
function getExportReadiness(readiness) {
  return {
    ...readiness,
    canExport: true, // Always can export, just with gaps marked
    exportQuality: readiness.ready ? 'complete' :
                   readiness.status === 'getting_there' ? 'partial' : 'draft'
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 6: CORE INTEGRATION (LLM-SYNTHESIZED)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build compact snapshot of current plan state for LLM synthesis.
 * Keeps it small for fast generation.
 */
function buildPlanSnapshot(allNodes, edges = [], coreDoc = null) {
  const activeNodes = allNodes.filter(n =>
    n.kind !== 'road-not-taken' && n.kind !== 'rejected'
  );

  const coreNode = activeNodes.find(n => n.kind === 'core');
  if (!coreNode) return null;

  const premise = coreDoc?.premise || coreNode.statement || '';
  const completeness = calculateCompleteness(activeNodes, edges, coreDoc);

  // Build constellation summaries (compact)
  const constellations = activeNodes
    .filter(n => n.kind === 'constellation')
    .map(cons => {
      const children = activeNodes.filter(n =>
        n.parentNodeId?.toString() === cons._id.toString()
      );
      const specified = children.filter(c => !isNodeAGap(c));
      const gaps = children.filter(c => isNodeAGap(c));

      return {
        label: cons.constellationLabel || cons.constellation || cons.title,
        statement: cons.statement || cons.detail || '',
        specified: specified.map(c => `${c.title}: ${c.detail || c.statement || ''}`).slice(0, 5),
        gapCount: gaps.length
      };
    });

  // Key decisions
  const decisions = (coreDoc?.resolvedDirections || []).map(d =>
    `${d.nodeTitle}: ${d.chosenPath}`
  );

  return {
    premise,
    decisions,
    constellations,
    completeness: completeness.percent,
    gapCount: completeness.gapCount
  };
}

/**
 * Generate core integration - Clockwork's advisory consultation on this plan.
 * Called with regenerate=true after each gap fill.
 *
 * Voice: Sharp, plain-spoken advisor. Second person ("you"). Names the real
 * decision and the first move. Never generic, never a premise restatement.
 *
 * @param {Array} allNodes - All nodes in the project
 * @param {Array} edges - All edges
 * @param {Object} coreDoc - Core document
 * @returns {Promise<string>} - Advisory synthesis in Clockwork's voice
 */
async function generateCoreIntegration(allNodes, edges = [], coreDoc = null) {
  const snapshot = buildPlanSnapshot(allNodes, edges, coreDoc);

  if (!snapshot) {
    return 'No core defined yet.';
  }

  // For very early plans with nothing specified, give initial advisory
  const hasSpecified = snapshot.constellations.some(c => c.specified.length > 0);
  const gapLabels = snapshot.constellations
    .filter(c => c.gapCount > 0)
    .map(c => c.label)
    .slice(0, 3);

  if (!hasSpecified) {
    // Early plan — point to the pivotal first question
    const firstGap = gapLabels[0] || 'the basics';
    return `You have the seed of an idea here. The shape isn't clear yet — ${snapshot.gapCount} questions will define what this actually becomes. Start with ${firstGap}. That's where the real choices live.`;
  }

  // Build compact prompt
  const snapshotText = JSON.stringify(snapshot, null, 0);

  // Lazy-load AI client
  const { client, model, prefix } = getAIClient();

  const systemPrompt = prefix + `You are Clockwork — a sharp, plain-spoken advisor who thinks with users about their plans.

VOICE RULES:
- Second person: "you", "your" — never "the user" or "one"
- Direct and specific to THIS plan — never generic templates
- Name what the plan IS and its current shape (don't just repeat the premise)
- Identify the PIVOTAL open decision — the thing that drives everything downstream
- Tell them what to tackle FIRST and why
- Plain-spoken, no jargon, no filler
- 2-4 sentences max

EXAMPLE (coffee shop with location decided but customers open):
"Your downtown Sarasota coffee shop has a clear shape, but the pieces that decide whether it works are still open. You know where — downtown foot traffic — but not who. That choice drives everything else. Start here: who's walking past your door, and which of them are you actually for?"

EXAMPLE (after filling customers = remote workers):
"Good — now it's a remote-worker café, and that reshapes the plan. Storefront throughput matters less; dwell time, wifi, and whether a $5 latte for three hours pencils out matter more. Your central risk now: can the unit economics work on low-turnover seats?"`;

  const userPrompt = `Consult on this plan. What's its current shape? What's the pivotal open decision? What should they tackle first?

PLAN STATE:
${snapshotText}

Respond ONLY with your advisory paragraph (2-4 sentences). No preamble, no labels.`;

  try {
    const startTime = Date.now();

    const response = await client.chat.completions.create({
      model,
      max_tokens: 250,
      temperature: 0.4,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });

    const summary = response.choices?.[0]?.message?.content?.trim();
    const elapsed = Date.now() - startTime;
    console.log(`[Rescoping:integration] generated in ${elapsed}ms`);

    if (!summary) {
      return `Your plan is taking shape. ${snapshot.gapCount} questions remain — start with ${gapLabels[0] || 'the first gap'} to see where this leads.`;
    }

    return summary;
  } catch (error) {
    console.error('[Rescoping:integration] LLM error:', error.message);
    // Fallback with advisory tone
    return `Your plan is taking shape. ${snapshot.gapCount} questions remain — start with ${gapLabels[0] || 'the first gap'} to see where this leads.`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════
// PART 7: GAP-FILL VALIDATION
// When user fills a gap, validate before marking complete
// ═══════════════════════════════════════════════════════════════════════════

// Vague terms that indicate insufficient specificity
const VAGUE_PATTERNS = [
  /\beveryone\b/i,
  /\banyone\b/i,
  /\bsometime[s]?\b/i,
  /\bmaybe\b/i,
  /\bprobably\b/i,
  /\bmight\b/i,
  /\bcould be\b/i,
  /\bvarious\b/i,
  /\bgeneral(ly)?\b/i,
  /\bmost people\b/i,
  /\bsome people\b/i,
  /\betc\.?\b/i,
  /\band so on\b/i,
  /\band more\b/i,
  /\btbd\b/i,
  /\bto be determined\b/i,
  /\blater\b/i,
  /\bsoon\b/i,
  /\beventually\b/i,
  /\bwhenever\b/i,
  /\bwherever\b/i,
  /\bwhatever\b/i,
  /\b(a )?lot\b/i,
  /\bmany\b/i,
  /\bfew\b/i,
  /\bsome\b/i,
  /\bseveral\b/i,
  /\boften\b/i,
  /\brarely\b/i,
  /\busually\b/i,
  /\bkind of\b/i,
  /\bsort of\b/i,
  /\bbasically\b/i
];

// Minimum content thresholds
const MIN_CONTENT_LENGTH = 10;
const MIN_WORD_COUNT = 3;

/**
 * Validate gap-fill input before marking a gap complete.
 * Returns validation result with feedback.
 *
 * @param {Object} node - The gap node being filled
 * @param {string} input - User's input to fill the gap
 * @param {Array} allNodes - All nodes in the project
 * @param {Object} coreIntegration - The integrated plan (for consistency check)
 * @returns {Object} - { valid, canComplete, feedback, issues }
 */
function validateGapFill(node, input, allNodes = [], coreIntegration = null) {
  const issues = [];
  const feedback = [];

  // Basic input check
  if (!input || typeof input !== 'string') {
    return {
      valid: false,
      canComplete: false,
      feedback: ['Please provide input to fill this gap.'],
      issues: ['empty_input']
    };
  }

  const trimmed = input.trim();

  // 1. RELEVANCE CHECK
  const relevanceResult = checkRelevance(node, trimmed, allNodes);
  if (!relevanceResult.relevant) {
    issues.push('relevance');
    feedback.push(relevanceResult.feedback);

    // If input belongs elsewhere, suggest routing
    if (relevanceResult.suggestedNode) {
      feedback.push(`This seems to answer "${relevanceResult.suggestedNode.title}" instead. Route it there?`);
    }
  }

  // 2. SPECIFICITY CHECK
  const specificityResult = checkSpecificity(trimmed, node);
  if (!specificityResult.specific) {
    issues.push('specificity');
    feedback.push(specificityResult.feedback);

    if (specificityResult.vagueTerms.length > 0) {
      feedback.push(`Vague terms found: "${specificityResult.vagueTerms.join('", "')}". Be more specific.`);
    }
  }

  // 3. CONSISTENCY CHECK (against integrated plan)
  if (coreIntegration) {
    const consistencyResult = checkConsistency(node, trimmed, allNodes, coreIntegration);
    if (!consistencyResult.consistent) {
      issues.push('consistency');
      // Consistency is flagged, not blocked
      feedback.push(`⚠️ Potential conflict: ${consistencyResult.feedback}`);
    }
  }

  // Determine if gap can be marked complete
  // Requires relevance + specificity; consistency is just flagged
  const passesCore = !issues.includes('relevance') && !issues.includes('specificity');

  return {
    valid: issues.length === 0,
    canComplete: passesCore,
    partiallySpecified: issues.includes('specificity') && !issues.includes('relevance'),
    hasConsistencyWarning: issues.includes('consistency'),
    feedback: feedback.length > 0 ? feedback : ['Input validated.'],
    issues
  };
}

/**
 * Check if input is relevant to this specific node.
 * @param {Object} node - Target node
 * @param {string} input - User input
 * @param {Array} allNodes - All nodes for routing suggestions
 * @returns {Object}
 */
function checkRelevance(node, input, allNodes) {
  // Extract key terms from node title/statement
  const nodeContext = `${node.title || ''} ${node.statement || ''}`.toLowerCase();
  const inputLower = input.toLowerCase();

  // Check for topical overlap using keyword extraction
  const nodeKeywords = extractKeywords(nodeContext);
  const inputKeywords = extractKeywords(inputLower);

  // Calculate overlap
  const overlap = nodeKeywords.filter(k => inputKeywords.includes(k) || inputLower.includes(k));
  const overlapRatio = nodeKeywords.length > 0 ? overlap.length / nodeKeywords.length : 0;

  // If very low overlap, check if it matches another node better
  if (overlapRatio < 0.15 && input.length > 20) {
    // Look for a better matching node
    const betterMatch = findBetterMatchingNode(input, node, allNodes);
    if (betterMatch) {
      return {
        relevant: false,
        feedback: `This doesn't seem to address "${node.title}".`,
        suggestedNode: betterMatch
      };
    }
  }

  // Check for completely off-topic input (no overlap at all)
  if (overlapRatio === 0 && nodeKeywords.length > 2 && input.length > 30) {
    return {
      relevant: false,
      feedback: `This input doesn't appear to relate to "${node.title}". Please address the specific question.`,
      suggestedNode: null
    };
  }

  return { relevant: true };
}

/**
 * Check if input is specific and actionable.
 * @param {string} input - User input
 * @param {Object} node - Context node
 * @returns {Object}
 */
function checkSpecificity(input, node) {
  const vagueTerms = [];

  // Check minimum length
  if (input.length < MIN_CONTENT_LENGTH) {
    return {
      specific: false,
      feedback: 'Please provide more detail.',
      vagueTerms: []
    };
  }

  // Check minimum word count
  const wordCount = input.split(/\s+/).filter(w => w.length > 0).length;
  if (wordCount < MIN_WORD_COUNT) {
    return {
      specific: false,
      feedback: 'Please elaborate with more specifics.',
      vagueTerms: []
    };
  }

  // Check for vague patterns
  for (const pattern of VAGUE_PATTERNS) {
    const match = input.match(pattern);
    if (match) {
      vagueTerms.push(match[0]);
    }
  }

  // If dominated by vague terms, flag as insufficient
  const vagueRatio = vagueTerms.length / wordCount;
  if (vagueRatio > 0.2 || vagueTerms.length >= 3) {
    return {
      specific: false,
      feedback: 'This is too vague to be actionable.',
      vagueTerms: [...new Set(vagueTerms)] // unique
    };
  }

  // Check for specificity indicators (numbers, names, dates, etc.)
  const hasSpecifics = /\d+/.test(input) || // numbers
                       /[A-Z][a-z]+/.test(input) || // proper nouns
                       /\$[\d,]+/.test(input) || // currency
                       /\d{1,2}[:/]\d{2}/.test(input) || // times
                       /\d{4}/.test(input) || // years
                       /@\w+/.test(input) || // handles/emails
                       /https?:\/\//.test(input); // URLs

  // For certain node types, require specifics
  const needsNumbers = (node.constellation === 'economy' || node.constellation === 'demand');
  if (needsNumbers && !hasSpecifics && vagueTerms.length > 0) {
    return {
      specific: false,
      feedback: `For ${node.constellation || 'this section'}, include specific numbers or details.`,
      vagueTerms: [...new Set(vagueTerms)]
    };
  }

  // Pass with possible warning
  if (vagueTerms.length > 0) {
    return {
      specific: true, // passes but with warning
      feedback: 'Consider replacing vague terms with specifics.',
      vagueTerms: [...new Set(vagueTerms)]
    };
  }

  return { specific: true, vagueTerms: [] };
}

/**
 * Check consistency against the integrated plan.
 * @param {Object} node - Node being filled
 * @param {string} input - User input
 * @param {Array} allNodes - All nodes
 * @param {Object} integration - Core integration
 * @returns {Object}
 */
function checkConsistency(node, input, allNodes, integration) {
  const conflicts = [];
  const inputLower = input.toLowerCase();

  // Extract numbers from input for numerical consistency
  const inputNumbers = extractNumbers(input);

  // Check against other specified nodes
  for (const n of allNodes) {
    if (n._id.toString() === node._id.toString()) continue;
    if (isNodeAGap(n)) continue; // Skip gaps

    const nodeContent = `${n.title || ''} ${n.statement || ''} ${n.detail || ''}`.toLowerCase();

    // Check for contradictory patterns
    // Example: hours/times that don't match
    if (inputLower.includes('hour') || inputLower.includes('time') || inputLower.includes('schedule')) {
      const inputTimes = extractTimeReferences(input);
      const nodeTimes = extractTimeReferences(nodeContent);

      if (inputTimes.length > 0 && nodeTimes.length > 0) {
        const timeConflict = detectTimeConflict(inputTimes, nodeTimes);
        if (timeConflict) {
          conflicts.push({
            nodeId: n._id,
            nodeTitle: n.title,
            type: 'time_conflict',
            detail: timeConflict
          });
        }
      }
    }

    // Check for audience/target conflicts
    if (node.constellation === 'demand' || n.constellation === 'demand') {
      const inputAudience = extractAudienceTerms(input);
      const nodeAudience = extractAudienceTerms(nodeContent);

      if (inputAudience.length > 0 && nodeAudience.length > 0) {
        const audienceConflict = detectAudienceConflict(inputAudience, nodeAudience);
        if (audienceConflict) {
          conflicts.push({
            nodeId: n._id,
            nodeTitle: n.title,
            type: 'audience_conflict',
            detail: audienceConflict
          });
        }
      }
    }

    // Check for numerical inconsistencies (prices, quantities, etc.)
    if (inputNumbers.length > 0) {
      const nodeNumbers = extractNumbers(nodeContent);
      const numConflict = detectNumberConflict(inputNumbers, nodeNumbers, input, nodeContent);
      if (numConflict) {
        conflicts.push({
          nodeId: n._id,
          nodeTitle: n.title,
          type: 'number_conflict',
          detail: numConflict
        });
      }
    }
  }

  if (conflicts.length > 0) {
    const conflict = conflicts[0]; // Report first conflict
    return {
      consistent: false,
      feedback: `This may conflict with "${conflict.nodeTitle}": ${conflict.detail}. Please reconcile.`,
      conflicts
    };
  }

  return { consistent: true };
}

/**
 * Extract keywords from text for relevance matching.
 */
function extractKeywords(text) {
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
    'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'this',
    'that', 'these', 'those', 'it', 'its', 'i', 'we', 'you', 'they',
    'what', 'which', 'who', 'whom', 'how', 'when', 'where', 'why'
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));
}

/**
 * Find a node that better matches the input.
 */
function findBetterMatchingNode(input, currentNode, allNodes) {
  const inputKeywords = extractKeywords(input.toLowerCase());
  let bestMatch = null;
  let bestScore = 0;

  for (const node of allNodes) {
    if (node._id.toString() === currentNode._id.toString()) continue;
    if (node.kind === 'core' || node.kind === 'road-not-taken') continue;

    const nodeContext = `${node.title || ''} ${node.statement || ''}`.toLowerCase();
    const nodeKeywords = extractKeywords(nodeContext);

    const overlap = inputKeywords.filter(k => nodeKeywords.includes(k));
    const score = nodeKeywords.length > 0 ? overlap.length / nodeKeywords.length : 0;

    if (score > bestScore && score > 0.3) {
      bestScore = score;
      bestMatch = node;
    }
  }

  return bestMatch;
}

/**
 * Extract numbers from text.
 */
function extractNumbers(text) {
  const matches = text.match(/\$?[\d,]+\.?\d*/g) || [];
  return matches.map(m => parseFloat(m.replace(/[$,]/g, ''))).filter(n => !isNaN(n));
}

/**
 * Extract time references.
 */
function extractTimeReferences(text) {
  const patterns = [
    /\d{1,2}:\d{2}\s*(am|pm)?/gi,
    /\d{1,2}\s*(am|pm)/gi,
    /morning|afternoon|evening|night/gi,
    /weekday|weekend|daily|weekly/gi,
    /monday|tuesday|wednesday|thursday|friday|saturday|sunday/gi
  ];

  const refs = [];
  for (const p of patterns) {
    const matches = text.match(p);
    if (matches) refs.push(...matches.map(m => m.toLowerCase()));
  }
  return refs;
}

/**
 * Extract audience/demographic terms.
 */
function extractAudienceTerms(text) {
  const patterns = [
    /\b(teens?|teenagers?|youth|young|elderly|seniors?|adults?|children|kids)\b/gi,
    /\b(students?|professionals?|workers?|families|parents|millennials?|gen[- ]?z)\b/gi,
    /\b(urban|rural|suburban)\b/gi,
    /\b(low[- ]income|high[- ]income|middle[- ]class|affluent)\b/gi,
    /\b(b2b|b2c|enterprise|small business|smb|startup)\b/gi
  ];

  const terms = [];
  for (const p of patterns) {
    const matches = text.match(p);
    if (matches) terms.push(...matches.map(m => m.toLowerCase()));
  }
  return terms;
}

/**
 * Detect time conflicts.
 */
function detectTimeConflict(times1, times2) {
  // Check for contradictory day patterns
  const hasWeekday1 = times1.some(t => t.includes('weekday'));
  const hasWeekend1 = times1.some(t => t.includes('weekend'));
  const hasWeekday2 = times2.some(t => t.includes('weekday'));
  const hasWeekend2 = times2.some(t => t.includes('weekend'));

  if ((hasWeekday1 && hasWeekend2 && !hasWeekend1 && !hasWeekday2) ||
      (hasWeekend1 && hasWeekday2 && !hasWeekday1 && !hasWeekend2)) {
    return 'Weekday vs. weekend timing mismatch';
  }

  // Check for time-of-day conflicts
  const hasMorning1 = times1.some(t => t.includes('morning'));
  const hasEvening1 = times1.some(t => t.includes('evening') || t.includes('night'));
  const hasMorning2 = times2.some(t => t.includes('morning'));
  const hasEvening2 = times2.some(t => t.includes('evening') || t.includes('night'));

  if ((hasMorning1 && hasEvening2 && !hasEvening1) ||
      (hasEvening1 && hasMorning2 && !hasMorning1)) {
    return 'Morning vs. evening timing mismatch';
  }

  return null;
}

/**
 * Detect audience conflicts.
 */
function detectAudienceConflict(audience1, audience2) {
  // Check for age-group conflicts
  const youngTerms = ['teen', 'teenager', 'youth', 'young', 'children', 'kids', 'gen z'];
  const oldTerms = ['elderly', 'senior', 'seniors'];

  const hasYoung1 = audience1.some(a => youngTerms.some(t => a.includes(t)));
  const hasOld1 = audience1.some(a => oldTerms.some(t => a.includes(t)));
  const hasYoung2 = audience2.some(a => youngTerms.some(t => a.includes(t)));
  const hasOld2 = audience2.some(a => oldTerms.some(t => a.includes(t)));

  if ((hasYoung1 && hasOld2) || (hasOld1 && hasYoung2)) {
    return 'Target age group mismatch';
  }

  // Check for B2B vs B2C conflicts
  const hasB2B1 = audience1.some(a => a.includes('b2b') || a.includes('enterprise'));
  const hasB2C1 = audience1.some(a => a.includes('b2c') || a.includes('consumer'));
  const hasB2B2 = audience2.some(a => a.includes('b2b') || a.includes('enterprise'));
  const hasB2C2 = audience2.some(a => a.includes('b2c') || a.includes('consumer'));

  if ((hasB2B1 && hasB2C2 && !hasB2C1) || (hasB2C1 && hasB2B2 && !hasB2B1)) {
    return 'B2B vs. B2C targeting mismatch';
  }

  return null;
}

/**
 * Detect significant numerical conflicts.
 */
function detectNumberConflict(nums1, nums2, context1, context2) {
  // Look for price/cost conflicts (same category, very different numbers)
  const priceTerms = ['price', 'cost', 'fee', 'charge', '$'];
  const hasPriceContext1 = priceTerms.some(t => context1.toLowerCase().includes(t));
  const hasPriceContext2 = priceTerms.some(t => context2.toLowerCase().includes(t));

  if (hasPriceContext1 && hasPriceContext2) {
    // Compare similar-scale numbers
    for (const n1 of nums1) {
      for (const n2 of nums2) {
        // If numbers are in same order of magnitude but very different
        const ratio = n1 > n2 ? n1 / n2 : n2 / n1;
        if (ratio > 5 && Math.abs(Math.log10(n1) - Math.log10(n2)) < 1) {
          return `Price/cost values differ significantly ($${n1} vs $${n2})`;
        }
      }
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  // Part 1: Defining-question detection
  isDefiningQuestion,
  detectDisjointLabels,
  getDefiningQuestions,
  getGapsWithPriority,

  // Part 2: Conditional re-scoping
  archiveUnchosenBranches,
  rescopeOnDefiningAnswer,
  updateCoreSummary,
  buildAcknowledgment,

  // Part 3: Completeness feedback
  calculateCompleteness,
  isNodeAGap,
  calculateNodeWeight,
  checkMilestones,

  // Part 4: Fill-and-advance
  getNextGap,
  routeToNextGap,

  // Part 5: PDF-readiness
  checkPDFReadiness,
  getExportReadiness,

  // Part 6: Core integration
  generateCoreIntegration,

  // Part 7: Gap-fill validation
  validateGapFill,
  checkRelevance,
  checkSpecificity,
  checkConsistency
};
