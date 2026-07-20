/**
 * Identity Service - Blueprint Node Identity Layer
 *
 * Every node traces back to exactly one Core. Identity is verified
 * through path resolution and stableId computation.
 *
 * Key invariants:
 * - Every node has coreId pointing to the map's Core
 * - path contains the full trace from Core to this node
 * - stableId = SHA-256(coreId + JSON(path))
 * - essence is frozen at creation and never changes
 * - derivation tracks how the node was created
 */

const crypto = require('crypto');
const Node = require('../models/Node');
const Core = require('../models/Core');

/**
 * Compute stable identity hash from coreId and path
 * @param {ObjectId} coreId - Core document ID
 * @param {Array} path - Array of {nodeId, title} objects
 * @returns {string} - SHA-256 hex hash
 */
function computeStableId(coreId, path) {
  if (!coreId) {
    throw new Error('Cannot compute stableId without coreId');
  }
  const payload = JSON.stringify({
    coreId: coreId.toString(),
    path: path.map(p => ({
      nodeId: p.nodeId.toString(),
      title: p.title
    }))
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Build trace from a node back to its Core
 * @param {ObjectId} nodeId - Node to trace from
 * @param {ObjectId} projectId - Project ID for safety check
 * @returns {Promise<{path: Array, coreId: ObjectId, valid: boolean, error?: string}>}
 */
async function buildTrace(nodeId, projectId) {
  const visited = new Set();
  const path = [];
  let currentId = nodeId;
  let coreId = null;

  while (currentId) {
    // Prevent infinite loops
    if (visited.has(currentId.toString())) {
      return {
        path: [],
        coreId: null,
        valid: false,
        error: 'circular_reference'
      };
    }
    visited.add(currentId.toString());

    const node = await Node.findById(currentId).lean();
    if (!node) {
      return {
        path: [],
        coreId: null,
        valid: false,
        error: 'missing_node'
      };
    }

    // Verify node belongs to same project
    if (node.projectId.toString() !== projectId.toString()) {
      return {
        path: [],
        coreId: null,
        valid: false,
        error: 'project_mismatch'
      };
    }

    // Prepend to path (building from node toward root)
    path.unshift({
      nodeId: node._id,
      title: node.title
    });

    // Check if we reached the core
    if (node.kind === 'core') {
      coreId = node.coreId;
      break;
    }

    // Move to parent
    currentId = node.parentNodeId;
  }

  // Must have reached a core
  if (!path.length || path[0].nodeId.toString() !== currentId?.toString()) {
    // Didn't reach a core node
    const firstNode = await Node.findById(path[0]?.nodeId).lean();
    if (!firstNode || firstNode.kind !== 'core') {
      return {
        path: [],
        coreId: null,
        valid: false,
        error: 'unreachable_root'
      };
    }
  }

  return {
    path,
    coreId,
    valid: true
  };
}

/**
 * Verify a node's identity is valid
 * @param {Object} node - Node document (or ID)
 * @returns {Promise<{valid: boolean, reason?: string}>}
 */
async function verifyNodeIdentity(node) {
  // Load node if ID was passed
  if (typeof node === 'string' || node._bsontype === 'ObjectId') {
    node = await Node.findById(node).lean();
  }

  if (!node) {
    return { valid: false, reason: 'node_not_found' };
  }

  // Must have coreId
  if (!node.coreId) {
    return { valid: false, reason: 'missing_coreId' };
  }

  // Must have path
  if (!node.path || !Array.isArray(node.path) || node.path.length === 0) {
    return { valid: false, reason: 'missing_path' };
  }

  // Must have stableId
  if (!node.stableId) {
    return { valid: false, reason: 'missing_stableId' };
  }

  // Verify Core exists
  const core = await Core.findById(node.coreId).lean();
  if (!core) {
    return { valid: false, reason: 'core_not_found' };
  }

  // Verify Core belongs to same project
  if (core.projectId.toString() !== node.projectId.toString()) {
    return { valid: false, reason: 'core_project_mismatch' };
  }

  // Path must start with the core node
  const coreNode = await Node.findById(core.coreNodeId).lean();
  if (!coreNode) {
    return { valid: false, reason: 'core_node_not_found' };
  }
  if (node.path[0].nodeId.toString() !== coreNode._id.toString()) {
    return { valid: false, reason: 'path_not_rooted_at_core' };
  }

  // Path must end with this node
  const lastInPath = node.path[node.path.length - 1];
  if (lastInPath.nodeId.toString() !== node._id.toString()) {
    return { valid: false, reason: 'path_not_ending_at_self' };
  }

  // Verify stableId matches
  const expectedStableId = computeStableId(node.coreId, node.path);
  if (node.stableId !== expectedStableId) {
    return { valid: false, reason: 'stableId_mismatch' };
  }

  // Verify path is contiguous (each node's parent is the previous in path)
  for (let i = 1; i < node.path.length; i++) {
    const pathNode = await Node.findById(node.path[i].nodeId).lean();
    if (!pathNode) {
      return { valid: false, reason: 'path_node_missing' };
    }
    const expectedParent = node.path[i - 1].nodeId.toString();
    if (pathNode.parentNodeId?.toString() !== expectedParent) {
      return { valid: false, reason: 'path_discontinuity' };
    }
  }

  return { valid: true };
}

/**
 * Quick verification (no DB lookups for path continuity)
 * Use for hot paths; full verifyNodeIdentity for mutations
 * @param {Object} node - Node document
 * @returns {{valid: boolean, reason?: string}}
 */
function quickVerifyIdentity(node) {
  if (!node.coreId) {
    return { valid: false, reason: 'missing_coreId' };
  }
  if (!node.path || !Array.isArray(node.path) || node.path.length === 0) {
    return { valid: false, reason: 'missing_path' };
  }
  if (!node.stableId) {
    return { valid: false, reason: 'missing_stableId' };
  }

  // Verify stableId matches computed value
  const expectedStableId = computeStableId(node.coreId, node.path);
  if (node.stableId !== expectedStableId) {
    return { valid: false, reason: 'stableId_mismatch' };
  }

  return { valid: true };
}

/**
 * Freeze essence from node data
 * @param {Object} nodeData - Node fields
 * @returns {Object} - Essence snapshot
 */
function freezeEssence(nodeData) {
  return {
    title: nodeData.title || null,
    statement: nodeData.statement || null,
    constellation: nodeData.constellation || null,
    constellationLabel: nodeData.constellationLabel || null
  };
}

/**
 * Build path for a new child node
 * @param {Object} parentNode - Parent node document
 * @param {Object} childData - Child node data (needs _id and title)
 * @returns {Array} - Path array for child
 */
function buildChildPath(parentNode, childData) {
  const parentPath = parentNode.path || [];
  return [
    ...parentPath,
    {
      nodeId: childData._id,
      title: childData.title
    }
  ];
}

/**
 * Initialize identity fields for a new node
 * @param {Object} nodeData - Node data being created
 * @param {ObjectId} coreId - Core document ID
 * @param {Array} path - Path to this node
 * @param {Object} derivation - How node was created
 * @returns {Object} - Node data with identity fields
 */
function initializeIdentity(nodeData, coreId, path, derivation) {
  const essence = freezeEssence(nodeData);
  const stableId = computeStableId(coreId, path);

  return {
    ...nodeData,
    coreId,
    path,
    stableId,
    essence,
    derivation: {
      kind: derivation.kind || null,
      sourcePrompt: derivation.sourcePrompt || null,
      usedTrace: derivation.usedTrace || false
    }
  };
}

/**
 * Format trace for LLM context (human-readable)
 * @param {Array} path - Node path array
 * @returns {string} - Formatted trace string
 */
function formatTraceForLLM(path) {
  if (!path || path.length === 0) {
    return '[No trace available]';
  }
  return path.map((p, i) => {
    const indent = '  '.repeat(i);
    return `${indent}→ ${p.title}`;
  }).join('\n');
}

/**
 * Evaluate trace for expansion context
 * Returns full trace as string for LLM grounding
 * @param {Object} node - Node being expanded
 * @returns {Promise<string>}
 */
async function evaluateTraceForExpansion(node) {
  if (!node.path || node.path.length === 0) {
    // Legacy node without path - try to build it
    const trace = await buildTrace(node._id, node.projectId);
    if (trace.valid) {
      return formatTraceForLLM(trace.path);
    }
    return '[Trace unavailable - legacy node]';
  }
  return formatTraceForLLM(node.path);
}

/**
 * Get all descendants of a node (for cascade operations)
 * @param {ObjectId} nodeId - Parent node ID
 * @param {ObjectId} projectId - Project ID
 * @returns {Promise<Array>} - Array of descendant node IDs
 */
async function getDescendants(nodeId, projectId) {
  const descendants = [];
  const queue = [nodeId];

  while (queue.length > 0) {
    const currentId = queue.shift();
    const children = await Node.find({
      projectId,
      parentNodeId: currentId
    }).select('_id').lean();

    for (const child of children) {
      descendants.push(child._id);
      queue.push(child._id);
    }
  }

  return descendants;
}

module.exports = {
  computeStableId,
  buildTrace,
  verifyNodeIdentity,
  quickVerifyIdentity,
  freezeEssence,
  buildChildPath,
  initializeIdentity,
  formatTraceForLLM,
  evaluateTraceForExpansion,
  getDescendants
};
