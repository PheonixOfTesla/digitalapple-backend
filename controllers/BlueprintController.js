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
const UserQuota = require('../models/UserQuota');
const { verifyToken } = require('../middleware/auth');

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
async function checkQuota(userId, anonymousSessionId, operationType) {
  const date = getToday();
  const isAuth = !!userId;
  const limits = isAuth ? QUOTA.authenticated : QUOTA.anonymous;
  const unitCost = UNIT_COSTS[operationType] || 1;

  // Must have either userId or anonymousSessionId
  if (!userId && !anonymousSessionId) {
    return { allowed: false, error: 'No session identifier' };
  }

  const query = userId
    ? { userId, date }
    : { anonymousSessionId, date };

  // Find or create quota record
  const quota = await UserQuota.findOneAndUpdate(
    query,
    { $setOnInsert: { unitsUsed: 0, projectsCreated: 0 } },
    { upsert: true, new: true }
  );

  const unitsRemaining = limits.units - (quota.unitsUsed || 0);
  const projectsRemaining = limits.projects - (quota.projectsCreated || 0);

  // Check units
  if (unitsRemaining < unitCost) {
    return {
      allowed: false,
      quotaType: 'units',
      used: quota.unitsUsed || 0,
      limit: limits.units,
      remaining: unitsRemaining,
      cost: unitCost,
      resetsAt: getResetTime(),
      error: `Requires ${unitCost} units, only ${unitsRemaining} remaining`
    };
  }

  // Check projects for nebula operations
  if (operationType === 'nebula' && projectsRemaining <= 0) {
    return {
      allowed: false,
      quotaType: 'projects',
      used: quota.projectsCreated || 0,
      limit: limits.projects,
      remaining: 0,
      resetsAt: getResetTime(),
      error: `Daily project limit (${limits.projects}) reached`
    };
  }

  return {
    allowed: true,
    unitsRemaining: unitsRemaining - unitCost,
    projectsRemaining: operationType === 'nebula' ? projectsRemaining - 1 : projectsRemaining,
    cost: unitCost,
    query // Pass query for later consumption
  };
}

// Helper: consume quota after successful operation
async function consumeQuota(query, operationType) {
  const unitCost = UNIT_COSTS[operationType] || 1;
  const incFields = { unitsUsed: unitCost };
  if (operationType === 'nebula') {
    incFields.projectsCreated = 1;
  }
  await UserQuota.updateOne(query, { $inc: incFields });
}

// Helper: refund quota on failure
async function refundQuota(query, operationType) {
  const unitCost = UNIT_COSTS[operationType] || 1;
  const incFields = { unitsUsed: -unitCost };
  if (operationType === 'nebula') {
    incFields.projectsCreated = -1;
  }
  // Use $max to prevent negative values
  await UserQuota.updateOne(query, {
    $inc: incFields,
    $max: { unitsUsed: 0, projectsCreated: 0 }
  });
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
        remaining: quotaCheck.remaining,
        resetsAt: quotaCheck.resetsAt
      });
    }

    // Also check project limit
    const date = getToday();
    const query = req.userId ? { userId: req.userId, date } : { anonymousSessionId: req.anonymousSessionId, date };
    const limits = req.userId ? QUOTA.authenticated : QUOTA.anonymous;
    const quota = await UserQuota.findOne(query);
    if ((quota?.projectsCreated || 0) >= limits.projects) {
      return res.status(429).json({
        error: 'Quota exceeded',
        message: `Daily project limit (${limits.projects}) reached`,
        quotaType: 'projects',
        used: quota.projectsCreated,
        limit: limits.projects,
        remaining: 0,
        resetsAt: getResetTime()
      });
    }

    const { name } = req.body;

    const project = new Project({
      name: name?.trim() || 'Untitled Project',
      ownerId: req.userId || null,
      anonymousSessionId: req.userId ? null : req.anonymousSessionId
    });

    await project.save();

    // Consume quota
    await consumeQuota(quotaCheck.query, 'chat');
    await UserQuota.updateOne(query, { $inc: { projectsCreated: 1 } });

    res.json({
      success: true,
      project: {
        id: project._id,
        name: project.name,
        createdAt: project.createdAt
      },
      quota: { remaining: quotaCheck.remaining, limit: quotaCheck.limit }
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

    res.json({
      success: true,
      project: {
        id: project._id,
        name: project.name,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt
      },
      nodes: nodes.map(n => ({
        id: n._id,
        kind: n.kind,
        title: n.title,
        body: n.body,
        scores: n.scores,
        x: n.x,
        y: n.y,
        kept: n.kept
      })),
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

// Create node
router.post('/projects/:projectId/nodes', optionalAuth, async (req, res) => {
  try {
    const project = await verifyOwnership(req.params.projectId, req.userId, req.anonymousSessionId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const { kind, title, body, scores, x, y } = req.body;

    if (!title?.trim()) {
      return res.status(400).json({ error: 'Title is required' });
    }

    const node = new Node({
      projectId: project._id,
      kind: kind || 'idea',
      title: title.trim(),
      body: body?.trim(),
      scores: scores || { economy: 0, orchestration: 0, demand: 0 },
      x: x ?? 100,
      y: y ?? 100
    });

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
        remaining: quotaCheck.remaining,
        cost: quotaCheck.cost,
        resetsAt: quotaCheck.resetsAt
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
      quota: { remaining: quotaCheck.unitsRemaining, limit: QUOTA[req.userId ? 'authenticated' : 'anonymous'].units }
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
    const date = getToday();
    const isAuth = !!req.userId;
    const limits = isAuth ? QUOTA.authenticated : QUOTA.anonymous;

    const query = req.userId
      ? { userId: req.userId, date }
      : { anonymousSessionId: req.anonymousSessionId, date };

    const quota = await UserQuota.findOne(query);

    res.json({
      success: true,
      quota: {
        chatRequests: {
          used: quota?.chatRequests || 0,
          limit: limits.chat,
          remaining: limits.chat - (quota?.chatRequests || 0)
        },
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
        remaining: quotaCheck.remaining,
        cost: quotaCheck.cost,
        resetsAt: quotaCheck.resetsAt
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

    // Create core node
    const corePos = layout.find(l => l.nodeRef === 'core');
    const coreNode = new Node({
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
    });
    await coreNode.save();
    nodeMap.core = coreNode._id;
    ops.push({ op: 'createNode', nodeId: coreNode._id.toString(), data: formatNodeForClient(coreNode) });

    // Create root nodes and their stars (new frame-aware format)
    const roots = nebula.roots || [];
    for (let i = 0; i < roots.length; i++) {
      const root = roots[i];
      const rootId = root.frameId || `root_${i}`;
      const rootPos = layout.find(l => l.nodeRef === `root:${rootId}`);

      const rootNode = new Node({
        projectId: project._id,
        parentNodeId: coreNode._id,
        kind: 'constellation',
        constellation: root.frameId, // W-spine key (who/what/where/etc)
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
      });
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

        const starNode = new Node({
          projectId: project._id,
          parentNodeId: rootNode._id,
          kind: 'star',
          constellation: root.frameId, // Inherit from parent
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
        });
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
      quota: { remaining: quotaCheck.unitsRemaining, limit: QUOTA[req.userId ? 'authenticated' : 'anonymous'].units }
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
 * Expand a star into children
 * POST /blueprint/expand
 * Costs: 3 units
 */
router.post('/expand', optionalAuth, async (req, res) => {
  let quotaCheck = null;
  try {
    const { nodeId } = req.body;
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

    // Check expansion depth limit (prevent runaway cost)
    const MAX_DEPTH = 5;
    if (node.depth >= MAX_DEPTH) {
      return res.status(400).json({
        error: 'Maximum expansion depth reached',
        message: `Nodes can only be expanded ${MAX_DEPTH} levels deep`
      });
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
        remaining: quotaCheck.remaining,
        cost: quotaCheck.cost,
        resetsAt: quotaCheck.resetsAt
      });
    }

    // Pre-consume quota (will refund on failure)
    await consumeQuota(quotaCheck.query, 'expand');

    // Get context nodes
    const contextNodes = await Node.find({ projectId: node.projectId }).limit(20).lean();

    // Expand via LLM
    const llm = getLLM();
    const { children, reasoning, tokensUsed } = await llm.expandStar(
      formatNodeForClient(node),
      contextNodes.map(n => ({ id: n._id.toString(), statement: n.statement || n.title, stage: n.stage }))
    );

    // Create child nodes
    const ops = [];
    const CHILD_SPREAD = 80;

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const childNode = new Node({
        projectId: node.projectId,
        parentNodeId: node._id,
        kind: 'star',
        title: child.statement,
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
      });
      await childNode.save();
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
    }

    // Mark parent as expanded
    node.status = 'mapped';
    await node.save();
    ops.push({ op: 'updateNode', nodeId: node._id.toString(), data: { status: 'mapped' } });

    res.json({
      success: true,
      reasoning,
      ops,
      tokensUsed,
      quota: { remaining: quotaCheck.remaining - 1, limit: quotaCheck.limit }
    });

  } catch (error) {
    console.error('Expand error:', error);
    res.status(500).json({ error: 'Failed to expand node', message: error.message });
  }
});

// Format node for client response
function formatNodeForClient(node) {
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
    kept: node.kept
  };
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
