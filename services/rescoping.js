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
 * Get all defining questions in a project, sorted by importance.
 * Defining questions are surfaced BEFORE ordinary detail gaps.
 *
 * @param {string} projectId - Project ID
 * @returns {Promise<Array>} - Defining question nodes, sorted by depth (shallower first)
 */
async function getDefiningQuestions(projectId) {
  const allNodes = await Node.find({
    projectId,
    kind: { $ne: 'road-not-taken' },
    nodeKind: 'decision',
    scoped: true
  }).lean();

  const defining = [];
  for (const node of allNodes) {
    const result = isDefiningQuestion(node, allNodes);
    if (result.isDefining) {
      // Only include if not yet answered (no chosen path)
      const hasChosenPath = (node.scopedPaths || []).some(p => p.chosen);
      if (!hasChosenPath) {
        defining.push({
          ...node,
          definingReason: result.reason,
          branches: result.branches
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
 * @param {string} projectId - Project ID
 * @returns {Promise<{ defining: Array, detail: Array, total: number }>}
 */
async function getGapsWithPriority(projectId) {
  const defining = await getDefiningQuestions(projectId);
  const definingIds = new Set(defining.map(n => n._id.toString()));

  // Get all dormant/incomplete nodes
  const allGaps = await Node.find({
    projectId,
    kind: { $nin: ['core', 'road-not-taken', 'rejected'] },
    $or: [
      { liveness: 'dormant' },
      { 'confidence.basis': 'unknown' },
      { terminal: { $ne: true }, liveness: { $ne: 'walled' } }
    ]
  }).sort({ depth: 1 }).lean();

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
 * @param {string} chosenLabel - Chosen path label
 * @param {Array} archived - Archived nodes
 * @param {Array} newGaps - New gap nodes
 * @param {string} projectId - Project ID
 * @returns {Promise<string>}
 */
async function buildAcknowledgment(chosenLabel, archived, newGaps, projectId) {
  // Get remaining gap count
  const gaps = await getGapsWithPriority(projectId);
  const remainingGaps = gaps.total;

  // Build message
  let message = `Since it's ${chosenLabel}`;

  if (archived.length > 0) {
    const archivedLabels = [...new Set(archived.map(n => n.constellation || n.title))];
    message += `, I've set aside ${archived.length} question${archived.length !== 1 ? 's' : ''} about ${archivedLabels.slice(0, 2).join(', ')}`;
  }

  if (newGaps.length > 0) {
    const newLabels = newGaps.slice(0, 3).map(n => n.title);
    message += ` and opened ${newGaps.length} new one${newGaps.length !== 1 ? 's' : ''}: ${newLabels.join(', ')}`;
  }

  message += `. ${remainingGaps} gap${remainingGaps !== 1 ? 's' : ''} left.`;

  return message;
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 3: CONTINUOUS COMPLETENESS FEEDBACK
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Calculate completeness with downstream weighting.
 * Defining questions are weighted by their downstream impact.
 *
 * @param {string} projectId - Project ID
 * @returns {Promise<Object>} - Completeness data
 */
async function calculateCompleteness(projectId) {
  const allNodes = await Node.find({
    projectId,
    kind: { $nin: ['road-not-taken', 'rejected'] }
  }).lean();

  if (allNodes.length === 0) {
    return { percentage: 0, gapCount: 0, specifiedCount: 0, totalWeight: 0 };
  }

  const coreNode = allNodes.find(n => n.kind === 'core');
  const nonCoreNodes = allNodes.filter(n => n.kind !== 'core');

  // Calculate base completeness
  let totalWeight = 0;
  let specifiedWeight = 0;
  let gapCount = 0;
  let specifiedCount = 0;

  for (const node of nonCoreNodes) {
    const isGap = isNodeAGap(node);
    const weight = calculateNodeWeight(node, allNodes);

    totalWeight += weight;

    if (isGap) {
      gapCount++;
    } else {
      specifiedWeight += weight;
      specifiedCount++;
    }
  }

  // Calculate percentage
  const percentage = totalWeight > 0
    ? Math.round((specifiedWeight / totalWeight) * 100)
    : 0;

  // Check for milestones
  const milestones = await checkMilestones(projectId, allNodes, percentage);

  return {
    percentage,
    gapCount,
    specifiedCount,
    totalNodes: nonCoreNodes.length,
    totalWeight: Math.round(totalWeight * 100) / 100,
    specifiedWeight: Math.round(specifiedWeight * 100) / 100,
    milestones
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
 * @param {string} projectId - Project ID
 * @param {Array} allNodes - All nodes
 * @param {number} percentage - Current completion percentage
 * @returns {Promise<Array>}
 */
async function checkMilestones(projectId, allNodes, percentage) {
  const milestones = [];
  const coreNode = allNodes.find(n => n.kind === 'core');

  // Check constellation completion
  const constellations = allNodes.filter(n => n.kind === 'constellation');
  for (const cons of constellations) {
    const children = allNodes.filter(n => n.parentNodeId?.toString() === cons._id.toString());
    const allChildrenSpecified = children.length > 0 && children.every(c => !isNodeAGap(c));
    const consSpecified = !isNodeAGap(cons);

    if (consSpecified && allChildrenSpecified) {
      milestones.push({
        type: 'constellation_complete',
        message: `${cons.constellationLabel || cons.constellation || cons.title} is now complete`,
        nodeId: cons._id
      });
    }
  }

  // Check percentage milestones
  if (percentage >= 50) {
    milestones.push({
      type: 'half_complete',
      message: 'Half your plan is specified'
    });
  }

  // Check if only defining questions remain
  const gaps = await getGapsWithPriority(projectId);
  if (gaps.detail.length === 0 && gaps.defining.length > 0) {
    milestones.push({
      type: 'only_defining',
      message: 'Only defining questions left'
    });
  }

  // Check PDF readiness
  const readiness = await checkPDFReadiness(projectId, allNodes);
  if (readiness.ready) {
    milestones.push({
      type: 'pdf_ready',
      message: 'Ready to export'
    });
  }

  return milestones;
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 4: FILL-AND-ADVANCE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get the next gap to fill, prioritizing defining questions.
 * @param {string} projectId - Project ID
 * @param {string} currentNodeId - Current node (to skip)
 * @returns {Promise<Object|null>} - Next gap node or null if complete
 */
async function getNextGap(projectId, currentNodeId = null) {
  const gaps = await getGapsWithPriority(projectId);

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
 * @param {string} projectId - Project ID
 * @param {string} filledNodeId - Node that was just filled
 * @returns {Promise<Object>}
 */
async function routeToNextGap(projectId, filledNodeId) {
  const nextGap = await getNextGap(projectId, filledNodeId);
  const completeness = await calculateCompleteness(projectId);

  if (!nextGap) {
    return {
      complete: true,
      nextGap: null,
      completeness,
      message: 'All gaps filled — plan complete'
    };
  }

  const isDefining = isDefiningQuestion(nextGap, []);

  return {
    complete: false,
    nextGap: {
      id: nextGap._id,
      title: nextGap.title,
      constellation: nextGap.constellation,
      isDefining: isDefining.isDefining,
      territory: nextGap.territory,
      invitation: nextGap.invitation
    },
    completeness,
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
 * @param {string} projectId - Project ID
 * @param {Array} allNodes - Optional pre-fetched nodes
 * @returns {Promise<Object>}
 */
async function checkPDFReadiness(projectId, allNodes = null) {
  if (!allNodes) {
    allNodes = await Node.find({
      projectId,
      kind: { $nin: ['road-not-taken', 'rejected'] }
    }).lean();
  }

  const coreNode = allNodes.find(n => n.kind === 'core');
  if (!coreNode) {
    return { ready: false, status: 'not_ready', reason: 'no_core' };
  }

  // Check 1: All defining questions answered
  const definingQuestions = await getDefiningQuestions(projectId);
  if (definingQuestions.length > 0) {
    return {
      ready: false,
      status: 'not_ready',
      reason: 'defining_questions_remain',
      definingRemaining: definingQuestions.length,
      message: `${definingQuestions.length} defining question${definingQuestions.length !== 1 ? 's' : ''} remaining`
    };
  }

  // Check 2: Core constellations specified
  const constellations = allNodes.filter(n => n.kind === 'constellation');
  const coreConstellations = ['demand', 'offer', 'delivery', 'economy', 'orchestration'];

  const unspecifiedConstellations = constellations.filter(c => {
    const isCoreConstellation = coreConstellations.includes(c.constellation?.toLowerCase());
    const isGap = isNodeAGap(c);
    return isCoreConstellation && isGap;
  });

  if (unspecifiedConstellations.length > 0) {
    return {
      ready: false,
      status: 'getting_there',
      reason: 'constellations_incomplete',
      unspecifiedConstellations: unspecifiedConstellations.map(c => c.constellation || c.title),
      message: `Core sections need specification: ${unspecifiedConstellations.map(c => c.constellation || c.title).join(', ')}`
    };
  }

  // Ready!
  const gaps = await getGapsWithPriority(projectId);
  return {
    ready: true,
    status: 'ready',
    message: 'Ready to export',
    detailGapsRemaining: gaps.detail.length, // Info only, doesn't block
    completeness: await calculateCompleteness(projectId)
  };
}

/**
 * Get export readiness state for UI.
 * @param {string} projectId - Project ID
 * @returns {Promise<Object>}
 */
async function getExportReadiness(projectId) {
  const readiness = await checkPDFReadiness(projectId);
  const completeness = await calculateCompleteness(projectId);

  return {
    ...readiness,
    completeness,
    canExport: true, // Always can export, just with gaps marked
    exportQuality: readiness.ready ? 'complete' :
                   readiness.status === 'getting_there' ? 'partial' : 'draft'
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 6: CORE INTEGRATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate core integration - the synthesis of all developed nodes.
 * This is what all exports render from.
 *
 * @param {string} projectId - Project ID
 * @returns {Promise<Object>} - Integrated plan data
 */
async function generateCoreIntegration(projectId) {
  const allNodes = await Node.find({
    projectId,
    kind: { $nin: ['road-not-taken', 'rejected'] }
  }).lean();

  const edges = await Edge.find({ projectId }).lean();
  const core = await Core.findOne({ projectId }).lean();
  const coreNode = allNodes.find(n => n.kind === 'core');

  if (!coreNode || !core) {
    return null;
  }

  // Build constellation structure
  const constellations = allNodes
    .filter(n => n.kind === 'constellation')
    .sort((a, b) => {
      const order = ['demand', 'offer', 'delivery', 'economy', 'orchestration', 'risk'];
      const ai = order.indexOf(a.constellation) >= 0 ? order.indexOf(a.constellation) : 99;
      const bi = order.indexOf(b.constellation) >= 0 ? order.indexOf(b.constellation) : 99;
      return ai - bi;
    })
    .map(cons => {
      const children = allNodes.filter(n => n.parentNodeId?.toString() === cons._id.toString());
      const grandchildren = [];
      for (const child of children) {
        const gc = allNodes.filter(n => n.parentNodeId?.toString() === child._id.toString());
        grandchildren.push(...gc);
      }

      return {
        id: cons._id,
        constellation: cons.constellation,
        constellationLabel: cons.constellationLabel,
        title: cons.title,
        statement: cons.statement,
        detail: cons.detail,
        confidence: cons.confidence,
        liveness: cons.liveness,
        isGap: isNodeAGap(cons),
        children: children.map(child => ({
          id: child._id,
          title: child.title,
          statement: child.statement,
          detail: child.detail,
          confidence: child.confidence,
          liveness: child.liveness,
          isGap: isNodeAGap(child),
          isAction: child.terminal || child.liveness === 'walled',
          children: allNodes
            .filter(n => n.parentNodeId?.toString() === child._id.toString())
            .map(gc => ({
              id: gc._id,
              title: gc.title,
              statement: gc.statement,
              detail: gc.detail,
              confidence: gc.confidence,
              liveness: gc.liveness,
              isGap: isNodeAGap(gc),
              isAction: gc.terminal || gc.liveness === 'walled'
            }))
        }))
      };
    });

  // Get completeness and readiness
  const completeness = await calculateCompleteness(projectId);
  const readiness = await checkPDFReadiness(projectId, allNodes);
  const gaps = await getGapsWithPriority(projectId);

  return {
    core: {
      id: coreNode._id,
      premise: core.premise || coreNode.statement,
      classification: core.classification,
      frameMeta: core.frameMeta,
      resolvedDirections: core.resolvedDirections || [],
      stagesEnabled: core.stagesEnabled
    },
    constellations,
    completeness,
    readiness,
    gaps: {
      defining: gaps.defining.length,
      detail: gaps.detail.length,
      total: gaps.total
    },
    nodeCount: allNodes.length,
    generatedAt: new Date()
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
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
  generateCoreIntegration
};
