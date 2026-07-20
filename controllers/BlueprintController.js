/**
 * BlueprintController - Canvas CRUD and LLM chat
 *
 * Full CRUD for projects, nodes, and edges.
 * LLM chat returns structured operations for canvas manipulation.
 * Nebula generation from premise with auto-layout.
 */

const express = require('express');
const Project = require('../models/Project');
const Node = require('../models/Node');
const Edge = require('../models/Edge');
const Core = require('../models/Core');
const UserQuota = require('../models/UserQuota');
const { verifyToken } = require('../middleware/auth');
const identity = require('../services/identity');

// LLM service - lazy loaded to avoid startup errors if API key missing
let BlueprintLLM = null;
function getLLM() {
  if (!BlueprintLLM) {
    BlueprintLLM = require('../services/BlueprintLLM');
  }
  return BlueprintLLM;
}

// Frame-aware blueprint service (new premise type system)
let BlueprintService = null;
function getBlueprint() {
  if (!BlueprintService) {
    BlueprintService = require('../services/blueprint');
  }
  return BlueprintService;
}

const router = express.Router();

// Quota limits
// Unit costs per operation type (weighted)
const UNIT_COSTS = {
  chat: 1,
  expand: 3,
  nebula: 4
};

// Quota limits
const QUOTA = {
  authenticated: { units: 15, projects: 3 },
  anonymous: { units: 5, projects: 1 }
};

// Helper: get today's date string
function getToday() {
  return new Date().toISOString().split('T')[0];
}

// Helper: get reset time (midnight UTC)
function getResetTime() {
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  return tomorrow.toISOString();
}

// Helper: check quota before operation (does NOT consume)
// Note: Now lifetime-based for authenticated users, session-based for anonymous
async function checkQuota(userId, anonymousSessionId, operationType) {
  const isAuth = !!userId;
  const limits = isAuth ? QUOTA.authenticated : QUOTA.anonymous;
  const unitCost = UNIT_COSTS[operationType] || 1;

  // Must have either userId or anonymousSessionId
  if (!userId && !anonymousSessionId) {
    return { allowed: false, error: 'No session identifier' };
  }

  // Query without date - lifetime for auth users, session-based for anonymous
  const query = userId
    ? { userId }
    : { anonymousSessionId };

  // Find or create quota record
  const quota = await UserQuota.findOneAndUpdate(
    query,
    { $setOnInsert: { projectsCreated: 0 } },
    { upsert: true, new: true }
  );

  const projectsRemaining = limits.projects - (quota.projectsCreated || 0);

  // Check projects for nebula operations
  if (operationType === 'nebula' && projectsRemaining <= 0) {
    return {
      allowed: false,
      quotaType: 'projects',
      used: quota.projectsCreated || 0,
      limit: limits.projects,
      remaining: 0,
      error: `Project limit (${limits.projects}) reached`
    };
  }

  return {
    allowed: true,
    projectsRemaining: operationType === 'nebula' ? projectsRemaining - 1 : projectsRemaining,
    cost: unitCost,
    query // Pass query for later consumption
  };
}

// Helper: consume quota after successful operation
async function consumeQuota(query, operationType) {
  if (operationType === 'nebula') {
    await UserQuota.updateOne(query, { $inc: { projectsCreated: 1 } });
  }
  // Other operations don't consume quota in the new lifetime model
  // Unit budget is per-project, tracked on the Project document
}

// Helper: refund quota on failure
async function refundQuota(query, operationType) {
  if (operationType === 'nebula') {
    // Decrement but prevent negative values
    await UserQuota.updateOne(
      { ...query, projectsCreated: { $gt: 0 } },
      { $inc: { projectsCreated: -1 } }
    );
  }
}

// Helper: verify project ownership
async function verifyOwnership(projectId, userId, anonymousSessionId) {
  const project = await Project.findById(projectId);
  if (!project) return null;

  // Authenticated user owns the project
  if (userId && project.ownerId?.toString() === userId) return project;

  // Anonymous project: allow if session matches OR if project has no owner (MVP leniency)
  if (!project.ownerId) {
    // Prefer session match, but allow access to anonymous projects for demo
    if (project.anonymousSessionId === anonymousSessionId) return project;
    // TODO: Tighten this for production - for now allow any anonymous access to anonymous projects
    if (!userId) return project;
  }

  return null;
}

// Optional auth middleware - extracts user if token present
async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.split(' ')[1];
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.userId = decoded.id;
    } catch (e) {
      // Invalid token, continue as anonymous
    }
  }
  // Get session ID from header/query, or use IP+UA hash as fallback
  req.anonymousSessionId = req.headers['x-session-id'] || req.query.sessionId;
  if (!req.anonymousSessionId && !req.userId) {
    // Generate deterministic session from IP + User-Agent
    const crypto = require('crypto');
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const ua = req.headers['user-agent'] || 'unknown';
    req.anonymousSessionId = crypto.createHash('sha256').update(`${ip}:${ua}`).digest('hex').slice(0, 16);
  }
  next();
}

// ============== PROJECTS ==============

// List user's projects
router.get('/projects', optionalAuth, async (req, res) => {
  try {
    const query = req.userId
      ? { ownerId: req.userId }
      : { anonymousSessionId: req.anonymousSessionId, ownerId: null };

    const projects = await Project.find(query)
      .select('name createdAt updatedAt')
      .sort({ updatedAt: -1 })
      .lean();

    res.json({
      success: true,
      projects: projects.map(p => ({
        id: p._id,
        name: p.name,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt
      }))
    });
  } catch (error) {
    console.error('List projects error:', error);
    res.status(500).json({ error: 'Failed to list projects' });
  }
});

// Create project (manual, not via nebula - minimal quota impact)
router.post('/projects', optionalAuth, async (req, res) => {
  try {
    // Manual project creation counts as 1 unit + 1 project
    const quotaCheck = await checkQuota(req.userId, req.anonymousSessionId, 'chat');
    if (!quotaCheck.allowed) {
      return res.status(429).json({
        error: 'Quota exceeded',
        message: quotaCheck.error,
        quotaType: quotaCheck.quotaType,
        used: quotaCheck.used,
        limit: quotaCheck.limit,
        remaining: quotaCheck.projectsRemaining || 0
      });
    }

    const { name } = req.body;

    const project = new Project({
      name: name?.trim() || 'Untitled Project',
      ownerId: req.userId || null,
      anonymousSessionId: req.userId ? null : req.anonymousSessionId
    });

    await project.save();

    // Consume quota (project creation counts against project limit)
    await consumeQuota(quotaCheck.query, 'nebula');

    res.json({
      success: true,
      project: {
        id: project._id,
        name: project.name,
        createdAt: project.createdAt
      },
      quota: { projectsRemaining: quotaCheck.projectsRemaining - 1, projectLimit: QUOTA[req.userId ? 'authenticated' : 'anonymous'].projects }
    });
  } catch (error) {
    console.error('Create project error:', error);
    res.status(500).json({ error: 'Failed to create project' });
  }
});

// Get project with nodes and edges
router.get('/projects/:id', optionalAuth, async (req, res) => {
  try {
    const project = await verifyOwnership(req.params.id, req.userId, req.anonymousSessionId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const [nodes, edges] = await Promise.all([
      Node.find({ projectId: project._id }).lean(),
      Edge.find({ projectId: project._id }).lean()
    ]);

    // Calculate depth-relative coverage and resolution
    const blueprint = getBlueprint();
    const [coverage, resolution] = await Promise.all([
      blueprint.calculateProjectCoverage(project._id),
      blueprint.calculateResolution(project._id)
    ]);

    res.json({
      success: true,
      project: {
        id: project._id,
        name: project.name,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        blueprint: project.blueprint
      },
      coverage,
      resolution, // Idea → Behavior gauge (distinct from coverage)
      nodes: nodes.map(formatNodeForClient),
      edges: edges.map(e => ({
        id: e._id,
        fromNodeId: e.fromNodeId,
        toNodeId: e.toNodeId,
        type: e.type
      }))
    });
  } catch (error) {
    console.error('Get project error:', error);
    res.status(500).json({ error: 'Failed to get project' });
  }
});

// Update project
router.put('/projects/:id', optionalAuth, async (req, res) => {
  try {
    const project = await verifyOwnership(req.params.id, req.userId, req.anonymousSessionId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const { name } = req.body;
    if (name) project.name = name.trim();
    await project.save();

    res.json({
      success: true,
      project: {
        id: project._id,
        name: project.name,
        updatedAt: project.updatedAt
      }
    });
  } catch (error) {
    console.error('Update project error:', error);
    res.status(500).json({ error: 'Failed to update project' });
  }
});

// Delete project (cascades to nodes and edges)
router.delete('/projects/:id', optionalAuth, async (req, res) => {
  try {
    const project = await verifyOwnership(req.params.id, req.userId, req.anonymousSessionId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    await Promise.all([
      Node.deleteMany({ projectId: project._id }),
      Edge.deleteMany({ projectId: project._id }),
      Project.deleteOne({ _id: project._id })
    ]);

    res.json({ success: true, message: 'Project deleted' });
  } catch (error) {
    console.error('Delete project error:', error);
    res.status(500).json({ error: 'Failed to delete project' });
  }
});

// Get project lineage (fork origin for frontend display)
router.get('/projects/:id/lineage', optionalAuth, async (req, res) => {
  try {
    const project = await verifyOwnership(req.params.id, req.userId, req.anonymousSessionId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Get Core document
    const coreDoc = await Core.findOne({ projectId: project._id });

    const lineage = {
      hasCore: !!coreDoc,
      coreId: coreDoc?._id.toString() || null,
      premise: coreDoc?.premise || project.premise
    };

    // Fork origin from Core.origin
    if (coreDoc?.origin?.coreId) {
      const originCore = await Core.findById(coreDoc.origin.coreId);
      const originProject = originCore
        ? await Project.findById(originCore.projectId)
        : null;

      lineage.origin = {
        coreId: coreDoc.origin.coreId.toString(),
        projectId: coreDoc.origin.projectId?.toString(),
        projectName: originProject?.name,
        forkedAt: coreDoc.origin.forkedAt,
        forkedBy: coreDoc.origin.forkedBy?.toString()
      };
    }

    // Fork origin from Project.forkedFrom (map-level)
    if (project.forkedFrom?.mapId) {
      lineage.forkedFromMap = {
        mapId: project.forkedFrom.mapId.toString(),
        mapTitle: project.forkedFrom.mapTitle,
        ownerId: project.forkedFrom.ownerId?.toString(),
        ownerName: project.forkedFrom.ownerName
      };
    }

    res.json({
      success: true,
      projectId: project._id.toString(),
      lineage
    });
  } catch (error) {
    console.error('Get project lineage error:', error);
    res.status(500).json({ error: 'Failed to get lineage' });
  }
});

// Claim anonymous project (attach to user on login)
router.post('/projects/:id/claim', verifyToken, async (req, res) => {
  try {
    const { anonymousSessionId } = req.body;

    const project = await Project.findOne({
      _id: req.params.id,
      anonymousSessionId,
      ownerId: null
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found or already claimed' });
    }

    project.ownerId = req.userId;
    project.anonymousSessionId = null;
    await project.save();

    res.json({
      success: true,
      message: 'Project claimed successfully',
      project: { id: project._id, name: project.name }
    });
  } catch (error) {
    console.error('Claim project error:', error);
    res.status(500).json({ error: 'Failed to claim project' });
  }
});

// ============== NODES ==============

// Create node (manual creation requires parent for identity)
router.post('/projects/:projectId/nodes', optionalAuth, async (req, res) => {
  try {
    const project = await verifyOwnership(req.params.projectId, req.userId, req.anonymousSessionId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const { kind, title, body, scores, x, y, parentNodeId } = req.body;

    if (!title?.trim()) {
      return res.status(400).json({ error: 'Title is required' });
    }

    // Find Core for this project
    const coreDoc = await Core.findOne({ projectId: project._id });

    // If project has identity, manual nodes MUST have a parent
    if (coreDoc && !parentNodeId) {
      return res.status(400).json({
        error: 'Parent node required',
        message: 'Manual nodes must be attached to an existing node in the map.',
        hint: 'Provide parentNodeId to specify where this node should attach.'
      });
    }

    // Validate parent exists and belongs to project
    let parentNode = null;
    let parentPath = [];
    if (parentNodeId) {
      parentNode = await Node.findById(parentNodeId);
      if (!parentNode || parentNode.projectId.toString() !== project._id.toString()) {
        return res.status(400).json({ error: 'Invalid parent node' });
      }
      parentPath = parentNode.path || [];

      // Verify parent identity if it has one
      if (parentNode.coreId && parentNode.stableId) {
        const identityCheck = identity.quickVerifyIdentity(parentNode);
        if (!identityCheck.valid) {
          return res.status(409).json({
            error: 'Parent node identity compromised',
            reason: identityCheck.reason,
            message: 'Cannot attach to a node with invalid identity trace.'
          });
        }
      }
    }

    const nodeData = {
      projectId: project._id,
      parentNodeId: parentNodeId || null,
      kind: kind || 'idea',
      title: title.trim(),
      body: body?.trim(),
      scores: scores || { economy: { value: 0 }, orchestration: { value: 0 }, demand: { value: 0 } },
      x: x ?? 100,
      y: y ?? 100,
      depth: parentNode ? (parentNode.depth || 0) + 1 : 0
    };

    const node = new Node(nodeData);
    await node.save();

    // Assign identity if project has Core
    if (coreDoc && parentNode) {
      const nodePath = [...parentPath, { nodeId: node._id, title: node.title }];
      node.coreId = coreDoc._id;
      node.path = nodePath;
      node.stableId = identity.computeStableId(coreDoc._id, nodePath);
      node.essence = identity.freezeEssence(node);
      node.derivation = {
        kind: 'manual',
        sourcePrompt: null,
        usedTrace: false
      };
      await node.save();
    }

    res.json({
      success: true,
      node: formatNodeForClient(node)
    });
  } catch (error) {
    console.error('Create node error:', error);
    res.status(500).json({ error: 'Failed to create node' });
  }
});

// Update node (position, content, scores)
router.put('/nodes/:id', optionalAuth, async (req, res) => {
  try {
    const node = await Node.findById(req.params.id);
    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }

    const project = await verifyOwnership(node.projectId, req.userId, req.anonymousSessionId);
    if (!project) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { kind, title, body, scores, x, y, kept } = req.body;

    if (kind !== undefined) node.kind = kind;
    if (title !== undefined) node.title = title.trim();
    if (body !== undefined) node.body = body?.trim() || '';
    if (scores !== undefined) {
      if (scores.economy !== undefined) node.scores.economy = scores.economy;
      if (scores.orchestration !== undefined) node.scores.orchestration = scores.orchestration;
      if (scores.demand !== undefined) node.scores.demand = scores.demand;
    }
    if (x !== undefined) node.x = x;
    if (y !== undefined) node.y = y;
    if (kept !== undefined) node.kept = kept;

    await node.save();

    res.json({
      success: true,
      node: {
        id: node._id,
        kind: node.kind,
        title: node.title,
        body: node.body,
        scores: node.scores,
        x: node.x,
        y: node.y,
        kept: node.kept
      }
    });
  } catch (error) {
    console.error('Update node error:', error);
    res.status(500).json({ error: 'Failed to update node' });
  }
});

// Delete node (and connected edges)
router.delete('/nodes/:id', optionalAuth, async (req, res) => {
  try {
    const node = await Node.findById(req.params.id);
    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }

    const project = await verifyOwnership(node.projectId, req.userId, req.anonymousSessionId);
    if (!project) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await Promise.all([
      Edge.deleteMany({ $or: [{ fromNodeId: node._id }, { toNodeId: node._id }] }),
      Node.deleteOne({ _id: node._id })
    ]);

    res.json({ success: true, message: 'Node deleted' });
  } catch (error) {
    console.error('Delete node error:', error);
    res.status(500).json({ error: 'Failed to delete node' });
  }
});

// Get node by stableId (cross-project identity lookup)
router.get('/nodes/by-stable/:stableId', optionalAuth, async (req, res) => {
  try {
    const { stableId } = req.params;

    if (!stableId || stableId.length !== 64) {
      return res.status(400).json({ error: 'Invalid stableId format' });
    }

    const node = await Node.findOne({ stableId }).lean();
    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }

    // Verify ownership for full access, or return limited info for public maps
    const project = await verifyOwnership(node.projectId, req.userId, req.anonymousSessionId);

    if (project) {
      // Full access - return complete node
      res.json({
        success: true,
        node: formatNodeForClient(node),
        projectId: node.projectId.toString(),
        projectName: project.name
      });
    } else {
      // Check if this is a public shared map
      const SharedMap = require('../models/SharedMap');
      const sharedMap = await SharedMap.findOne({
        projectId: node.projectId,
        visibility: { $ne: 'private' },
        unpublishedAt: null
      });

      if (sharedMap) {
        // Public map - return limited info
        res.json({
          success: true,
          node: {
            id: node._id.toString(),
            stableId: node.stableId,
            title: node.title,
            statement: node.statement,
            kind: node.kind
          },
          projectId: node.projectId.toString(),
          isPublic: true,
          mapId: sharedMap._id.toString()
        });
      } else {
        return res.status(403).json({ error: 'Access denied' });
      }
    }
  } catch (error) {
    console.error('Get node by stableId error:', error);
    res.status(500).json({ error: 'Failed to get node' });
  }
});

// Verify node identity (debugging/admin endpoint)
router.get('/nodes/:id/verify-identity', optionalAuth, async (req, res) => {
  try {
    const node = await Node.findById(req.params.id);
    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }

    const project = await verifyOwnership(node.projectId, req.userId, req.anonymousSessionId);
    if (!project) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Quick verification (no DB lookups)
    const quickResult = identity.quickVerifyIdentity(node);

    // Full verification (with DB lookups)
    const fullResult = await identity.verifyNodeIdentity(node);

    res.json({
      success: true,
      nodeId: node._id.toString(),
      quickCheck: quickResult,
      fullCheck: fullResult,
      identity: {
        coreId: node.coreId?.toString() || null,
        stableId: node.stableId || null,
        pathLength: node.path?.length || 0,
        derivation: node.derivation || null
      }
    });
  } catch (error) {
    console.error('Verify node identity error:', error);
    res.status(500).json({ error: 'Failed to verify identity' });
  }
});

// Get node lineage (fork origin tracking)
router.get('/nodes/:id/lineage', optionalAuth, async (req, res) => {
  try {
    const node = await Node.findById(req.params.id);
    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }

    const project = await verifyOwnership(node.projectId, req.userId, req.anonymousSessionId);
    if (!project) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get Core for this node
    const coreDoc = node.coreId
      ? await Core.findById(node.coreId)
      : await Core.findOne({ projectId: node.projectId });

    if (!coreDoc) {
      return res.json({
        success: true,
        lineage: null,
        message: 'No identity anchor found'
      });
    }

    // Build lineage response
    const lineage = {
      coreId: coreDoc._id.toString(),
      premise: coreDoc.premise,
      path: node.path || [],
      stableId: node.stableId,
      derivation: node.derivation
    };

    // If this project was forked, include origin info
    if (coreDoc.origin?.coreId) {
      const originCore = await Core.findById(coreDoc.origin.coreId);
      const originProject = originCore
        ? await Project.findById(originCore.projectId)
        : null;

      lineage.forkedFrom = {
        coreId: coreDoc.origin.coreId.toString(),
        projectId: coreDoc.origin.projectId?.toString(),
        projectName: originProject?.name,
        forkedAt: coreDoc.origin.forkedAt
      };
    }

    // Also check Project.forkedFrom for map origin
    if (project.forkedFrom?.mapId) {
      const SharedMap = require('../models/SharedMap');
      const sourceMap = await SharedMap.findById(project.forkedFrom.mapId);

      lineage.forkedFromMap = {
        mapId: project.forkedFrom.mapId.toString(),
        mapTitle: project.forkedFrom.mapTitle || sourceMap?.title,
        ownerName: project.forkedFrom.ownerName
      };
    }

    res.json({
      success: true,
      lineage
    });
  } catch (error) {
    console.error('Get node lineage error:', error);
    res.status(500).json({ error: 'Failed to get lineage' });
  }
});

// Get node coverage (for sub-nebula depth view)
router.get('/nodes/:id/coverage', optionalAuth, async (req, res) => {
  try {
    const node = await Node.findById(req.params.id);
    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }

    const project = await verifyOwnership(node.projectId, req.userId, req.anonymousSessionId);
    if (!project) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const blueprint = getBlueprint();
    const coverage = await blueprint.calculateNodeCoverage(node._id);

    res.json({
      success: true,
      nodeId: node._id.toString(),
      nodeTitle: node.title || node.statement,
      coverage
    });
  } catch (error) {
    console.error('Get node coverage error:', error);
    res.status(500).json({ error: 'Failed to get node coverage' });
  }
});

// ============== EDGES ==============

// Create edge
router.post('/projects/:projectId/edges', optionalAuth, async (req, res) => {
  try {
    const project = await verifyOwnership(req.params.projectId, req.userId, req.anonymousSessionId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const { fromNodeId, toNodeId, type } = req.body;

    if (!fromNodeId || !toNodeId) {
      return res.status(400).json({ error: 'fromNodeId and toNodeId are required' });
    }

    // Verify both nodes belong to this project
    const [fromNode, toNode] = await Promise.all([
      Node.findOne({ _id: fromNodeId, projectId: project._id }),
      Node.findOne({ _id: toNodeId, projectId: project._id })
    ]);

    if (!fromNode || !toNode) {
      return res.status(400).json({ error: 'Invalid node IDs' });
    }

    const edge = new Edge({
      projectId: project._id,
      fromNodeId,
      toNodeId,
      type: type || 'dependency'
    });

    await edge.save();

    res.json({
      success: true,
      edge: {
        id: edge._id,
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        type: edge.type
      }
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ error: 'Edge already exists' });
    }
    console.error('Create edge error:', error);
    res.status(500).json({ error: 'Failed to create edge' });
  }
});

// Delete edge
router.delete('/edges/:id', optionalAuth, async (req, res) => {
  try {
    const edge = await Edge.findById(req.params.id);
    if (!edge) {
      return res.status(404).json({ error: 'Edge not found' });
    }

    const project = await verifyOwnership(edge.projectId, req.userId, req.anonymousSessionId);
    if (!project) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await Edge.deleteOne({ _id: edge._id });

    res.json({ success: true, message: 'Edge deleted' });
  } catch (error) {
    console.error('Delete edge error:', error);
    res.status(500).json({ error: 'Failed to delete edge' });
  }
});

// ============== LLM CHAT ==============

/**
 * Chat endpoint - returns structured operations
 *
 * Response contract:
 * {
 *   reply: string,           // Natural language response
 *   ops: [                   // Canvas operations to execute
 *     { op: 'createNode', data: { kind, title, body, x, y } },
 *     { op: 'updateNode', nodeId: string, data: { title?, body?, scores?, kept? } },
 *     { op: 'deleteNode', nodeId: string },
 *     { op: 'createEdge', data: { fromNodeId, toNodeId, type? } },
 *     { op: 'deleteEdge', edgeId: string },
 *     { op: 'updateScores', nodeId: string, scores: { economy?, orchestration?, demand? } }
 *   ]
 * }
 */
router.post('/projects/:projectId/chat', optionalAuth, async (req, res) => {
  let quotaCheck = null;
  try {
    const project = await verifyOwnership(req.params.projectId, req.userId, req.anonymousSessionId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Check quota (chat = 1 unit)
    quotaCheck = await checkQuota(req.userId, req.anonymousSessionId, 'chat');
    if (!quotaCheck.allowed) {
      return res.status(429).json({
        error: 'Quota exceeded',
        message: quotaCheck.error,
        quotaType: quotaCheck.quotaType,
        used: quotaCheck.used,
        limit: quotaCheck.limit,
        remaining: quotaCheck.projectsRemaining || 0
      });
    }

    const { message } = req.body;
    if (!message?.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Pre-consume quota (will refund on failure)
    await consumeQuota(quotaCheck.query, 'chat');

    // Get current canvas state for context
    const [nodes, edges] = await Promise.all([
      Node.find({ projectId: project._id }).lean(),
      Edge.find({ projectId: project._id }).lean()
    ]);

    // Format nodes and edges for LLM context
    const formattedNodes = nodes.map(n => ({
      _id: n._id.toString(),
      kind: n.kind,
      title: n.title,
      body: n.body,
      scores: n.scores,
      confidence: n.confidence,
      constellation: n.constellation,
      kept: n.kept
    }));

    const formattedEdges = edges.map(e => ({
      _id: e._id.toString(),
      fromNodeId: e.fromNodeId.toString(),
      toNodeId: e.toNodeId.toString(),
      type: e.type
    }));

    // Generate response with operations via LLM
    const llm = getLLM();
    const response = await llm.processChat(message, formattedNodes, formattedEdges);

    // Save to chat history
    project.chatHistory.push(
      { role: 'user', content: message },
      { role: 'assistant', content: response.reply, operations: response.ops }
    );
    await project.save();

    // Execute operations and return created IDs
    const executedOps = await executeOperations(project._id, response.ops, nodes);

    res.json({
      success: true,
      reply: response.reply,
      ops: executedOps,
      quota: { projectsRemaining: quotaCheck.projectsRemaining, projectLimit: QUOTA[req.userId ? 'authenticated' : 'anonymous'].projects }
    });
  } catch (error) {
    console.error('Chat error:', error);
    // Refund quota on LLM failure
    if (quotaCheck?.query) {
      await refundQuota(quotaCheck.query, 'chat');
    }
    res.status(500).json({ error: 'Failed to process chat', message: error.message });
  }
});

// Execute operations and return results with created IDs
async function executeOperations(projectId, ops, existingNodes) {
  const results = [];
  const createdNodeIds = {}; // Map __NEW_X__ placeholders to real IDs

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];

    try {
      if (op.op === 'createNode') {
        const node = new Node({
          projectId,
          ...op.data
        });
        await node.save();
        createdNodeIds[`__NEW_${i}__`] = node._id.toString();
        results.push({
          ...op,
          success: true,
          nodeId: node._id.toString()
        });
      }
      else if (op.op === 'updateNode' || op.op === 'updateScores') {
        const updateData = op.op === 'updateScores'
          ? { scores: op.scores }
          : op.data;

        await Node.updateOne({ _id: op.nodeId }, { $set: updateData });
        results.push({ ...op, success: true });
      }
      else if (op.op === 'deleteNode') {
        await Promise.all([
          Edge.deleteMany({ $or: [{ fromNodeId: op.nodeId }, { toNodeId: op.nodeId }] }),
          Node.deleteOne({ _id: op.nodeId })
        ]);
        results.push({ ...op, success: true });
      }
      else if (op.op === 'createEdge') {
        // Resolve placeholder IDs
        let fromId = op.data.fromNodeId;
        let toId = op.data.toNodeId;

        if (fromId.startsWith('__NEW_')) fromId = createdNodeIds[fromId] || fromId;
        if (toId.startsWith('__NEW_')) toId = createdNodeIds[toId] || toId;

        const edge = new Edge({
          projectId,
          fromNodeId: fromId,
          toNodeId: toId,
          type: op.data.type || 'dependency'
        });
        await edge.save();
        results.push({
          ...op,
          success: true,
          edgeId: edge._id.toString(),
          data: { ...op.data, fromNodeId: fromId, toNodeId: toId }
        });
      }
      else if (op.op === 'deleteEdge') {
        await Edge.deleteOne({ _id: op.edgeId });
        results.push({ ...op, success: true });
      }
    } catch (error) {
      console.error(`Op ${op.op} failed:`, error.message);
      results.push({ ...op, success: false, error: error.message });
    }
  }

  return results;
}

// Get chat history
router.get('/projects/:projectId/chat', optionalAuth, async (req, res) => {
  try {
    const project = await verifyOwnership(req.params.projectId, req.userId, req.anonymousSessionId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    res.json({
      success: true,
      history: project.chatHistory.slice(-50) // Last 50 messages
    });
  } catch (error) {
    console.error('Get chat history error:', error);
    res.status(500).json({ error: 'Failed to get chat history' });
  }
});

// Get quota status
router.get('/quota', optionalAuth, async (req, res) => {
  try {
    const isAuth = !!req.userId;
    const limits = isAuth ? QUOTA.authenticated : QUOTA.anonymous;

    const query = req.userId
      ? { userId: req.userId }
      : { anonymousSessionId: req.anonymousSessionId };

    const quota = await UserQuota.findOne(query);

    res.json({
      success: true,
      quota: {
        projectsCreated: {
          used: quota?.projectsCreated || 0,
          limit: limits.projects,
          remaining: limits.projects - (quota?.projectsCreated || 0)
        }
      },
      authenticated: isAuth
    });
  } catch (error) {
    console.error('Get quota error:', error);
    res.status(500).json({ error: 'Failed to get quota' });
  }
});

// ============== NEBULA GENERATION ==============

/**
 * Auto-layout positions for nebula nodes
 * Core at center, roots in a ring, stars clustered near parent
 * Works with both old constellations format and new roots format
 */
function computeLayout(nebula) {
  const CANVAS_CENTER_X = 600;
  const CANVAS_CENTER_Y = 400;
  const ROOT_RADIUS = 280;
  const STAR_RADIUS = 120;
  const STAR_SPREAD = 0.4; // radians spread for stars

  const positions = [];

  // Core node at center
  positions.push({
    nodeRef: 'core',
    x: CANVAS_CENTER_X,
    y: CANVAS_CENTER_Y
  });

  // Support both old (constellations) and new (roots) format
  const roots = nebula.roots || nebula.constellations || [];
  const rootCount = roots.length || 6;

  roots.forEach((root, i) => {
    const angle = (i * 2 * Math.PI / rootCount) - Math.PI / 2; // Start from top
    const rootId = root.frameId || root.constellation || `root_${i}`;

    positions.push({
      nodeRef: `root:${rootId}`,
      x: CANVAS_CENTER_X + Math.cos(angle) * ROOT_RADIUS,
      y: CANVAS_CENTER_Y + Math.sin(angle) * ROOT_RADIUS
    });

    // Stars (children) clustered around their root
    const stars = root.stars || root.children || [];
    if (stars.length > 0) {
      stars.forEach((star, j) => {
        // Spread stars in an arc behind the root
        const starAngle = angle + (j - (stars.length - 1) / 2) * STAR_SPREAD * 0.5;
        const starDist = ROOT_RADIUS + STAR_RADIUS + j * 15;
        positions.push({
          nodeRef: `star:${rootId}:${j}`,
          x: CANVAS_CENTER_X + Math.cos(starAngle) * starDist,
          y: CANVAS_CENTER_Y + Math.sin(starAngle) * starDist
        });
      });
    }
  });

  return positions;
}

/**
 * Generate nebula from premise
 * POST /blueprint/nebula
 * Costs: 4 units + 1 project
 *
 * Now uses frame-aware classification to select appropriate template:
 * - venture, event, personal-goal, creative-work, life-transition, career, research, campaign
 */
router.post('/nebula', optionalAuth, async (req, res) => {
  let quotaCheck = null;
  let project = null;
  try {
    // Check quota (nebula = 4 units + 1 project)
    quotaCheck = await checkQuota(req.userId, req.anonymousSessionId, 'nebula');
    if (!quotaCheck.allowed) {
      return res.status(429).json({
        error: 'Quota exceeded',
        message: quotaCheck.error,
        quotaType: quotaCheck.quotaType,
        used: quotaCheck.used,
        limit: quotaCheck.limit,
        remaining: quotaCheck.projectsRemaining || 0
      });
    }

    const { premise } = req.body;
    if (!premise?.trim()) {
      return res.status(400).json({ error: 'Premise is required' });
    }

    // Pre-consume quota (will refund on failure)
    await consumeQuota(quotaCheck.query, 'nebula');

    // Create project first so we can store classification on it
    project = new Project({
      name: premise.substring(0, 100),
      premise: premise,
      ownerId: req.userId || null,
      anonymousSessionId: req.userId ? null : req.anonymousSessionId
    });
    await project.save();

    // Generate nebula via frame-aware blueprint service
    const blueprint = getBlueprint();
    const nebula = await blueprint.generateMap(premise, project._id);

    // Compute layout positions
    const layout = computeLayout(nebula);

    // Build operations to create all nodes
    const ops = [];
    const nodeMap = {}; // Track created node IDs

    // Create core node (without identity fields first - need _id)
    const corePos = layout.find(l => l.nodeRef === 'core');
    const coreNodeData = {
      projectId: project._id,
      kind: 'core',
      title: nebula.core?.title || premise.substring(0, 40),
      statement: nebula.core?.statement || premise,
      detail: nebula.core?.detail,
      body: nebula.core?.detail,
      scores: nebula.core?.scores,
      confidence: nebula.core?.confidence,
      stage: nebula.stagesEnabled ? (nebula.core?.stage || 0) : undefined,
      status: nebula.core?.status || 'mapped',
      x: corePos?.x || 600,
      y: corePos?.y || 400,
      depth: 0
    };
    const coreNode = new Node(coreNodeData);
    await coreNode.save();
    nodeMap.core = coreNode._id;

    // Create Core document (identity anchor)
    const coreDoc = new Core({
      projectId: project._id,
      coreNodeId: coreNode._id,
      premise: premise,
      classification: nebula.classification || {
        type: 'unknown',
        confidence: 0.5,
        alternates: [],
        reasoning: 'Generated via nebula'
      },
      frameMeta: nebula.frameMeta || {},
      stagesEnabled: nebula.stagesEnabled
    });
    await coreDoc.save();

    // Now assign identity to core node
    const corePath = [{ nodeId: coreNode._id, title: coreNode.title }];
    coreNode.coreId = coreDoc._id;
    coreNode.path = corePath;
    coreNode.stableId = identity.computeStableId(coreDoc._id, corePath);
    coreNode.essence = identity.freezeEssence(coreNode);
    coreNode.derivation = {
      kind: 'nebula',
      sourcePrompt: premise,
      usedTrace: false
    };
    await coreNode.save();

    ops.push({ op: 'createNode', nodeId: coreNode._id.toString(), data: formatNodeForClient(coreNode) });

    // Create root nodes and their stars (new frame-aware format)
    const roots = nebula.roots || [];
    for (let i = 0; i < roots.length; i++) {
      const root = roots[i];
      const rootId = root.frameId || `root_${i}`;
      const rootPos = layout.find(l => l.nodeRef === `root:${rootId}`);

      // Map W-spine frameId to legacy constellation enum if possible
      const constellationMap = {
        'what': 'offer',
        'who': 'demand',
        'where': 'delivery',
        'how': 'orchestration',
        'why': 'economy',
        'risk': 'risk',
        'when': null // No direct mapping
      };

      const rootNodeData = {
        projectId: project._id,
        parentNodeId: coreNode._id,
        kind: 'constellation',
        constellation: constellationMap[root.frameId] || null,
        constellationLabel: root.label, // Domain-specific label
        title: root.title || root.label,
        statement: root.statement,
        detail: root.detail,
        body: root.detail,
        scores: root.scores,
        confidence: root.confidence,
        stage: nebula.stagesEnabled ? (root.stage || 0) : undefined,
        status: root.status || 'mapped',
        x: rootPos?.x || 600,
        y: rootPos?.y || 400,
        depth: 1
      };
      const rootNode = new Node(rootNodeData);
      await rootNode.save();

      // Assign identity to root node
      const rootPath = [...corePath, { nodeId: rootNode._id, title: rootNode.title }];
      rootNode.coreId = coreDoc._id;
      rootNode.path = rootPath;
      rootNode.stableId = identity.computeStableId(coreDoc._id, rootPath);
      rootNode.essence = identity.freezeEssence(rootNode);
      rootNode.derivation = {
        kind: 'nebula',
        sourcePrompt: premise,
        usedTrace: true
      };
      await rootNode.save();

      nodeMap[`root:${rootId}`] = rootNode._id;
      ops.push({ op: 'createNode', nodeId: rootNode._id.toString(), data: formatNodeForClient(rootNode) });

      // Create edge from core to root
      const rootEdge = new Edge({
        projectId: project._id,
        fromNodeId: coreNode._id,
        toNodeId: rootNode._id,
        type: 'contains'
      });
      await rootEdge.save();
      ops.push({ op: 'createEdge', edgeId: rootEdge._id.toString(), data: { fromNodeId: coreNode._id.toString(), toNodeId: rootNode._id.toString(), type: 'contains' } });

      // Create stars (children)
      const stars = root.stars || [];
      for (let j = 0; j < stars.length; j++) {
        const star = stars[j];
        const starPos = layout.find(l => l.nodeRef === `star:${rootId}:${j}`);

        const starNodeData = {
          projectId: project._id,
          parentNodeId: rootNode._id,
          kind: 'star',
          constellation: constellationMap[root.frameId] || null, // Map to legacy enum
          constellationLabel: root.label,
          title: star.title,
          statement: star.statement,
          detail: star.detail,
          body: star.detail,
          scores: star.scores,
          confidence: star.confidence,
          stage: nebula.stagesEnabled ? (star.stage || rootNode.stage) : undefined,
          status: star.status || 'unexplored',
          x: starPos?.x || rootNode.x + 100,
          y: starPos?.y || rootNode.y + j * 60,
          depth: 2
        };
        const starNode = new Node(starNodeData);
        await starNode.save();

        // Assign identity to star node
        const starPath = [...rootPath, { nodeId: starNode._id, title: starNode.title }];
        starNode.coreId = coreDoc._id;
        starNode.path = starPath;
        starNode.stableId = identity.computeStableId(coreDoc._id, starPath);
        starNode.essence = identity.freezeEssence(starNode);
        starNode.derivation = {
          kind: 'nebula',
          sourcePrompt: premise,
          usedTrace: true
        };
        await starNode.save();

        ops.push({ op: 'createNode', nodeId: starNode._id.toString(), data: formatNodeForClient(starNode) });

        // Create edge from root to star
        const starEdge = new Edge({
          projectId: project._id,
          fromNodeId: rootNode._id,
          toNodeId: starNode._id,
          type: 'contains'
        });
        await starEdge.save();
        ops.push({ op: 'createEdge', edgeId: starEdge._id.toString(), data: { fromNodeId: rootNode._id.toString(), toNodeId: starNode._id.toString(), type: 'contains' } });
      }
    }

    // Reload project to get classification data
    const updatedProject = await Project.findById(project._id).lean();

    res.json({
      success: true,
      project: {
        id: project._id,
        name: project.name,
        premise: premise,
        blueprint: updatedProject?.blueprint
      },
      ops,
      stagesEnabled: nebula.stagesEnabled,
      quota: { projectsRemaining: quotaCheck.projectsRemaining, projectLimit: QUOTA[req.userId ? 'authenticated' : 'anonymous'].projects }
    });

  } catch (error) {
    console.error('Nebula generation error:', error);
    // Refund quota on LLM failure
    if (quotaCheck?.query) {
      await refundQuota(quotaCheck.query, 'nebula');
    }
    // Clean up project if created
    if (project?._id) {
      await Project.deleteOne({ _id: project._id }).catch(() => {});
    }
    res.status(500).json({ error: 'Failed to generate nebula', message: error.message });
  }
});

/**
 * Expand a node (infinite recursion engine)
 * POST /blueprint/expand
 * Costs: 3 units
 *
 * Mode A (sub-nebula): full classify → frame → nebula for domain-sized nodes
 * Mode B (star-children): lightweight 2-4 children for point-sized nodes
 */
router.post('/expand', optionalAuth, async (req, res) => {
  let quotaCheck = null;
  try {
    const { nodeId, refinePrompt, forceExpand } = req.body;
    if (!nodeId) {
      return res.status(400).json({ error: 'nodeId is required' });
    }

    const node = await Node.findById(nodeId);
    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }

    const project = await verifyOwnership(node.projectId, req.userId, req.anonymousSessionId);
    if (!project) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Verify node identity if it has identity fields
    if (node.coreId && node.stableId) {
      const identityCheck = identity.quickVerifyIdentity(node);
      if (!identityCheck.valid) {
        return res.status(409).json({
          error: 'Node identity compromised',
          reason: identityCheck.reason,
          message: 'This node\'s identity trace is invalid. It may have been corrupted.',
          nodeId: node._id.toString()
        });
      }
    }

    // Get Core document for identity assignment to children
    let coreDoc = null;
    if (node.coreId) {
      coreDoc = await Core.findById(node.coreId);
    } else {
      // Legacy node - try to find Core by project
      coreDoc = await Core.findOne({ projectId: node.projectId });
    }

    // Check if already expanded (unless refining)
    if (node.expanded && !refinePrompt) {
      return res.status(400).json({
        error: 'Node already expanded',
        message: 'Use refine to modify an expanded node'
      });
    }

    // Get blueprint service for recursion logic
    const blueprint = getBlueprint();

    // Check termination (unless force-expanding or refining)
    if (!forceExpand && !refinePrompt) {
      const terminalResult = await blueprint.judgeTerminal(node);
      if (terminalResult.terminal) {
        // Mark as terminal, no expansion
        node.terminal = true;
        node.expanded = false;
        await node.save();

        return res.json({
          success: true,
          terminal: true,
          reason: terminalResult.reason,
          ops: [{
            op: 'updateNode',
            nodeId: node._id.toString(),
            data: { terminal: true, expanded: false }
          }]
        });
      }
    }

    // Check quota (expand = 3 units)
    quotaCheck = await checkQuota(req.userId, req.anonymousSessionId, 'expand');
    if (!quotaCheck.allowed) {
      return res.status(429).json({
        error: 'Quota exceeded',
        message: quotaCheck.error,
        quotaType: quotaCheck.quotaType,
        used: quotaCheck.used,
        limit: quotaCheck.limit,
        remaining: quotaCheck.projectsRemaining || 0
      });
    }

    // Pre-consume quota (will refund on failure)
    await consumeQuota(quotaCheck.query, 'expand');

    // Decide expansion mode (A: sub-nebula or B: star-children)
    // Refine/force always uses star-children mode
    const forceStarChildren = !!refinePrompt || forceExpand;
    const { mode, classification } = forceStarChildren
      ? { mode: 'star-children' }
      : await blueprint.decideExpansionMode(node);

    const ops = [];
    let reasoning = '';
    let tokensUsed = 0;
    let prunedNodes = []; // Nodes removed by refine (for confirmation display)

    if (mode === 'sub-nebula' && !forceStarChildren) {
      // MODE A: Full sub-nebula expansion
      const result = await blueprint.expandAsSubNebula(node, classification);
      const nebula = result.nebula;

      // Create root nodes from nebula
      const CHILD_SPREAD = 100;
      const roots = nebula.roots || [];

      // Get parent path for identity inheritance
      const parentPath = node.path || [];

      for (let i = 0; i < roots.length; i++) {
        const root = roots[i];
        const childNodeData = {
          projectId: node.projectId,
          parentNodeId: node._id,
          kind: 'constellation',
          constellation: mapFrameIdToConstellation(root.frameId),
          constellationLabel: root.label,
          title: root.title || root.label,
          statement: root.statement,
          detail: root.detail,
          body: root.detail,
          scores: root.scores,
          confidence: root.confidence,
          stage: root.stage || node.stage,
          status: root.status || 'unexplored',
          x: node.x + 200,
          y: node.y + (i - (roots.length - 1) / 2) * CHILD_SPREAD,
          depth: node.depth + 1
        };
        const childNode = new Node(childNodeData);
        await childNode.save();

        // Assign identity (path continues from parent, NOT a new core)
        if (coreDoc) {
          const childPath = [...parentPath, { nodeId: childNode._id, title: childNode.title }];
          childNode.coreId = coreDoc._id;
          childNode.path = childPath;
          childNode.stableId = identity.computeStableId(coreDoc._id, childPath);
          childNode.essence = identity.freezeEssence(childNode);
          childNode.derivation = {
            kind: 'expand',
            sourcePrompt: node.statement || node.title,
            usedTrace: true
          };
          await childNode.save();
        }

        ops.push({ op: 'createNode', nodeId: childNode._id.toString(), data: formatNodeForClient(childNode) });

        // Create edge
        const edge = new Edge({
          projectId: node.projectId,
          fromNodeId: node._id,
          toNodeId: childNode._id,
          type: 'contains'
        });
        await edge.save();
        ops.push({ op: 'createEdge', edgeId: edge._id.toString(), data: { fromNodeId: node._id.toString(), toNodeId: childNode._id.toString(), type: 'contains' } });

        // Create star children under each root
        const stars = root.stars || [];
        const childPath = childNode.path || [...parentPath, { nodeId: childNode._id, title: childNode.title }];

        for (let j = 0; j < stars.length; j++) {
          const star = stars[j];
          const starNodeData = {
            projectId: node.projectId,
            parentNodeId: childNode._id,
            kind: 'star',
            title: star.title,
            statement: star.statement,
            detail: star.detail,
            body: star.detail,
            scores: star.scores,
            confidence: star.confidence,
            stage: star.stage || childNode.stage,
            status: star.status || 'unexplored',
            x: childNode.x + 180,
            y: childNode.y + (j - (stars.length - 1) / 2) * 70,
            depth: node.depth + 2
          };
          const starNode = new Node(starNodeData);
          await starNode.save();

          // Assign identity
          if (coreDoc) {
            const starPath = [...childPath, { nodeId: starNode._id, title: starNode.title }];
            starNode.coreId = coreDoc._id;
            starNode.path = starPath;
            starNode.stableId = identity.computeStableId(coreDoc._id, starPath);
            starNode.essence = identity.freezeEssence(starNode);
            starNode.derivation = {
              kind: 'expand',
              sourcePrompt: childNode.statement || childNode.title,
              usedTrace: true
            };
            await starNode.save();
          }

          ops.push({ op: 'createNode', nodeId: starNode._id.toString(), data: formatNodeForClient(starNode) });

          const starEdge = new Edge({
            projectId: node.projectId,
            fromNodeId: childNode._id,
            toNodeId: starNode._id,
            type: 'contains'
          });
          await starEdge.save();
          ops.push({ op: 'createEdge', edgeId: starEdge._id.toString(), data: { fromNodeId: childNode._id.toString(), toNodeId: starNode._id.toString(), type: 'contains' } });
        }
      }

      // Update parent node
      node.expanded = true;
      node.terminal = false;
      node.expansionType = 'sub-nebula';
      node.subFrameType = result.classification.type;
      node.status = 'mapped';
      await node.save();

      ops.push({
        op: 'updateNode',
        nodeId: node._id.toString(),
        data: {
          expanded: true,
          terminal: false,
          expansionType: 'sub-nebula',
          subFrameType: result.classification.type,
          status: 'mapped'
        }
      });

      reasoning = `Expanded as sub-nebula (${result.classification.type}): ${roots.length} roots with ${roots.reduce((sum, r) => sum + (r.stars?.length || 0), 0)} stars`;

    } else {
      // MODE B: Star-children expansion (lightweight)
      const contextNodes = await Node.find({ projectId: node.projectId }).limit(20).lean();

      // Build trace for LLM context (grounding)
      const traceString = await identity.evaluateTraceForExpansion(node);

      const llm = getLLM();
      const expandResult = await llm.expandStar(
        formatNodeForClient(node),
        contextNodes.map(n => ({
          id: n._id.toString(),
          statement: n.statement || n.title,
          stage: n.stage,
          parentNodeId: n.parentNodeId?.toString()
        })),
        1, // maxRetries
        refinePrompt || null,
        traceString // Pass trace for grounding
      );

      const children = expandResult.children || [];
      reasoning = expandResult.reasoning || '';
      tokensUsed = expandResult.tokensUsed || 0;

      // Handle prune ops (refine may invalidate existing children)
      const pruneIds = expandResult.prune || [];

      if (pruneIds.length > 0) {
        // Collect nodes to be pruned (for confirmation in response)
        for (const pruneId of pruneIds) {
          const prunedNode = await Node.findById(pruneId);
          if (prunedNode && prunedNode.projectId.toString() === node.projectId.toString()) {
            prunedNodes.push({
              id: pruneId,
              title: prunedNode.title || prunedNode.statement
            });

            // Cascade delete: find all descendants
            const descendants = await getDescendants(pruneId);
            const allToDelete = [pruneId, ...descendants.map(d => d._id.toString())];

            // Delete edges
            await Edge.deleteMany({
              $or: [
                { fromNodeId: { $in: allToDelete } },
                { toNodeId: { $in: allToDelete } }
              ]
            });

            // Delete nodes
            await Node.deleteMany({ _id: { $in: allToDelete } });

            // Add delete ops
            for (const delId of allToDelete) {
              ops.push({ op: 'deleteNode', nodeId: delId });
            }
          }
        }
      }

      // Handle parent update (refine may update the parent itself)
      if (expandResult.parentUpdate) {
        const updates = expandResult.parentUpdate;
        if (updates.statement) node.statement = updates.statement;
        if (updates.title) node.title = updates.title;
        if (updates.scores) node.scores = updates.scores;
        if (updates.confidence) node.confidence = updates.confidence;
        // Will be saved below
      }

      const CHILD_SPREAD = 80;
      const parentPath = node.path || [];

      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        // Truncate title to 50 chars (schema max)
        const childTitle = (child.statement || '').substring(0, 50);
        const childNodeData = {
          projectId: node.projectId,
          parentNodeId: node._id,
          kind: 'star',
          title: childTitle,
          statement: child.statement,
          detail: child.detail,
          body: child.detail,
          scores: child.scores,
          confidence: child.confidence,
          stage: child.stage || node.stage,
          status: child.status || 'unexplored',
          cost: child.cost,
          sources: child.sources || [],
          x: node.x + 180,
          y: node.y + (i - (children.length - 1) / 2) * CHILD_SPREAD,
          depth: node.depth + 1
        };
        const childNode = new Node(childNodeData);
        await childNode.save();

        // Assign identity
        if (coreDoc) {
          const childPath = [...parentPath, { nodeId: childNode._id, title: childNode.title }];
          childNode.coreId = coreDoc._id;
          childNode.path = childPath;
          childNode.stableId = identity.computeStableId(coreDoc._id, childPath);
          childNode.essence = identity.freezeEssence(childNode);
          childNode.derivation = {
            kind: 'expand',
            sourcePrompt: node.statement || node.title,
            usedTrace: true
          };
          await childNode.save();
        }

        ops.push({ op: 'createNode', nodeId: childNode._id.toString(), data: formatNodeForClient(childNode) });

        const edge = new Edge({
          projectId: node.projectId,
          fromNodeId: node._id,
          toNodeId: childNode._id,
          type: 'contains'
        });
        await edge.save();
        ops.push({ op: 'createEdge', edgeId: edge._id.toString(), data: { fromNodeId: node._id.toString(), toNodeId: childNode._id.toString(), type: 'contains' } });
      }

      // Update parent node
      node.expanded = true;
      node.terminal = false;
      node.expansionType = 'star-children';
      node.status = 'mapped';
      await node.save();

      ops.push({
        op: 'updateNode',
        nodeId: node._id.toString(),
        data: {
          expanded: true,
          terminal: false,
          expansionType: 'star-children',
          status: 'mapped'
        }
      });
    }

    res.json({
      success: true,
      expansionType: mode,
      reasoning,
      ops,
      tokensUsed,
      pruned: prunedNodes.length > 0 ? prunedNodes : undefined
    });

  } catch (error) {
    console.error('Expand error:', error);

    // Refund quota on failure
    if (quotaCheck?.query) {
      try {
        await refundQuota(quotaCheck.query, 'expand');
      } catch (refundErr) {
        console.error('Refund failed:', refundErr);
      }
    }

    res.status(500).json({ error: 'Failed to expand node', message: error.message });
  }
});

/**
 * Map frameId to legacy constellation enum.
 */
function mapFrameIdToConstellation(frameId) {
  const map = {
    'who': 'demand',
    'what': 'offer',
    'where': 'delivery',
    'when': null,
    'why': 'economy',
    'how': 'orchestration',
    'risk': 'risk'
  };
  return map[frameId] || null;
}

// Format node for client response
function formatNodeForClient(node) {
  // Derive liveness from existing flags (no new persisted field)
  // WALLED: terminal === true (arrived at actionable element)
  // DORMANT: basis === 'unknown' AND not terminal (empty doorway)
  // OPEN: grounded (basis stated/inferred) AND not terminal (live limb)
  const basis = node.confidence?.basis || 'unknown';
  const isTerminal = node.terminal || false;
  let liveness;
  if (isTerminal) {
    liveness = 'walled';
  } else if (basis === 'unknown') {
    liveness = 'dormant';
  } else {
    liveness = 'open';
  }

  return {
    id: node._id?.toString() || node.id,
    kind: node.kind,
    constellation: node.constellation,
    constellationLabel: node.constellationLabel, // Domain-specific label
    parentNodeId: node.parentNodeId?.toString(),
    title: node.title,
    statement: node.statement || node.title,
    detail: node.detail || node.body,
    body: node.body,
    scores: node.scores,
    confidence: node.confidence,
    stage: node.stage,
    status: node.status,
    cost: node.cost,
    sources: node.sources,
    owner: node.owner,
    dependencies: node.dependencies?.map(d => d.toString()) || [],
    x: node.x,
    y: node.y,
    depth: node.depth,
    kept: node.kept,
    // Infinite recursion fields
    expanded: node.expanded || false,
    terminal: node.terminal || false,
    expansionType: node.expansionType || null,
    subFrameType: node.subFrameType || null,
    // Liveness (derived, not persisted)
    liveness,
    // Identity fields
    coreId: node.coreId?.toString() || null,
    stableId: node.stableId || null,
    essence: node.essence || null,
    derivation: node.derivation || null
  };
}

/**
 * Get all descendants of a node (for cascade delete).
 * Recursively finds all children and their children.
 */
async function getDescendants(nodeId) {
  const descendants = [];
  const queue = [nodeId];

  while (queue.length > 0) {
    const currentId = queue.shift();
    const children = await Node.find({ parentNodeId: currentId }).lean();

    for (const child of children) {
      descendants.push(child);
      queue.push(child._id.toString());
    }
  }

  return descendants;
}

// ============== EXPORTS (AUTH REQUIRED) ==============

// Export rate limit tracking (in-memory, resets on restart - upgrade to Redis for prod)
const exportRateLimits = new Map();
const EXPORT_DAILY_LIMIT = 20;

function checkExportRateLimit(userId) {
  const today = getToday();
  const key = `${userId}:${today}`;
  const count = exportRateLimits.get(key) || 0;

  if (count >= EXPORT_DAILY_LIMIT) {
    return { allowed: false, used: count, limit: EXPORT_DAILY_LIMIT };
  }

  exportRateLimits.set(key, count + 1);
  return { allowed: true, used: count + 1, limit: EXPORT_DAILY_LIMIT };
}

// Middleware: require authentication for exports
function requireAuthForExport(req, res, next) {
  if (!req.userId) {
    return res.status(401).json({
      error: 'Authentication required',
      reason: 'export_requires_login',
      message: 'Create an account to export your map. Your current map will be saved to your account.',
      action: 'signup',
      projectId: req.params.projectId || req.body?.projectId
    });
  }
  next();
}

/**
 * Export project as JSON
 * GET /blueprint/projects/:projectId/export/json
 */
router.get('/projects/:projectId/export/json', optionalAuth, requireAuthForExport, async (req, res) => {
  try {
    const project = await Project.findById(req.params.projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Must own the project
    if (project.ownerId?.toString() !== req.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Check rate limit
    const rateCheck = checkExportRateLimit(req.userId);
    if (!rateCheck.allowed) {
      return res.status(429).json({
        error: 'Export limit reached',
        message: `You can export ${EXPORT_DAILY_LIMIT} times per day`,
        used: rateCheck.used,
        limit: rateCheck.limit
      });
    }

    const [nodes, edges] = await Promise.all([
      Node.find({ projectId: project._id }).lean(),
      Edge.find({ projectId: project._id }).lean()
    ]);

    res.json({
      success: true,
      format: 'json',
      project: {
        id: project._id,
        name: project.name,
        premise: project.premise,
        createdAt: project.createdAt
      },
      nodes: nodes.map(formatNodeForClient),
      edges: edges.map(e => ({
        id: e._id.toString(),
        fromNodeId: e.fromNodeId.toString(),
        toNodeId: e.toNodeId.toString(),
        type: e.type
      })),
      exportedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Export JSON error:', error);
    res.status(500).json({ error: 'Failed to export' });
  }
});

/**
 * Export project as CSV (sequence/timeline format)
 * GET /blueprint/projects/:projectId/export/csv
 */
router.get('/projects/:projectId/export/csv', optionalAuth, requireAuthForExport, async (req, res) => {
  try {
    const project = await Project.findById(req.params.projectId);
    if (!project || project.ownerId?.toString() !== req.userId) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const rateCheck = checkExportRateLimit(req.userId);
    if (!rateCheck.allowed) {
      return res.status(429).json({ error: 'Export limit reached', used: rateCheck.used, limit: rateCheck.limit });
    }

    const nodes = await Node.find({ projectId: project._id }).sort({ stage: 1, createdAt: 1 }).lean();

    // CSV header
    const header = 'Stage,Title,Statement,Economy,Orchestration,Demand,Confidence,Status\n';
    const rows = nodes.map(n => {
      const econ = n.scores?.economy?.value ?? '';
      const orch = n.scores?.orchestration?.value ?? '';
      const dem = n.scores?.demand?.value ?? '';
      const conf = n.confidence?.value ? Math.round(n.confidence.value * 100) + '%' : '';
      return `${n.stage},"${(n.title || '').replace(/"/g, '""')}","${(n.statement || '').replace(/"/g, '""')}",${econ},${orch},${dem},${conf},${n.status}`;
    }).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${project.name.replace(/[^a-z0-9]/gi, '_')}_sequence.csv"`);
    res.send(header + rows);
  } catch (error) {
    console.error('Export CSV error:', error);
    res.status(500).json({ error: 'Failed to export' });
  }
});

/**
 * Export formats - stub endpoints (return structured error until implemented)
 * These are gated behind auth but not yet built
 */
const STUB_FORMATS = ['pdf', 'xlsx', 'formation-pack', 'deck-outline'];

STUB_FORMATS.forEach(format => {
  router.get(`/projects/:projectId/export/${format}`, optionalAuth, requireAuthForExport, async (req, res) => {
    const project = await Project.findById(req.params.projectId);
    if (!project || project.ownerId?.toString() !== req.userId) {
      return res.status(404).json({ error: 'Project not found' });
    }

    res.status(501).json({
      error: 'Format not yet available',
      format,
      message: `${format.toUpperCase()} export is coming soon. Use JSON or CSV for now.`,
      availableFormats: ['json', 'csv']
    });
  });
});

/**
 * List available export formats
 * GET /blueprint/projects/:projectId/export
 */
router.get('/projects/:projectId/export', optionalAuth, async (req, res) => {
  const formats = [
    { format: 'json', name: 'Raw JSON', available: true, description: 'Complete map data for developers' },
    { format: 'csv', name: 'Sequence CSV', available: true, description: 'Timeline view for spreadsheets' },
    { format: 'pdf', name: 'PDF Brief', available: false, description: 'Executive summary document' },
    { format: 'xlsx', name: 'Model XLSX', available: false, description: 'Financial model template' },
    { format: 'formation-pack', name: 'Formation Pack', available: false, description: 'Complete founding documents' },
    { format: 'deck-outline', name: 'Deck Outline', available: false, description: 'Pitch deck structure' }
  ];

  res.json({
    success: true,
    requiresAuth: true,
    authenticated: !!req.userId,
    formats
  });
});

module.exports = router;
