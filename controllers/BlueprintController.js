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

const router = express.Router();

// Quota limits
const QUOTA = {
  authenticated: { chat: 50, projects: 10 },
  anonymous: { chat: 5, projects: 1 }
};

// Helper: get today's date string
function getToday() {
  return new Date().toISOString().split('T')[0];
}

// Helper: check/increment quota
async function checkQuota(userId, anonymousSessionId, type) {
  const date = getToday();
  const isAuth = !!userId;
  const limits = isAuth ? QUOTA.authenticated : QUOTA.anonymous;

  // Must have either userId or anonymousSessionId
  if (!userId && !anonymousSessionId) {
    return { allowed: false, remaining: 0, limit: 0, error: 'No session identifier' };
  }

  const query = userId
    ? { userId, date }
    : { anonymousSessionId, date };

  const field = type === 'chat' ? 'chatRequests' : 'projectsCreated';
  const limit = type === 'chat' ? limits.chat : limits.projects;

  // Atomically find or create quota, then check limit before incrementing
  const quota = await UserQuota.findOneAndUpdate(
    query,
    { $setOnInsert: { chatRequests: 0, projectsCreated: 0 } },
    { upsert: true, new: true }
  );

  if (quota[field] >= limit) {
    return { allowed: false, remaining: 0, limit };
  }

  // Increment the field
  await UserQuota.updateOne(query, { $inc: { [field]: 1 } });

  return { allowed: true, remaining: limit - quota[field] - 1, limit };
}

// Helper: verify project ownership
async function verifyOwnership(projectId, userId, anonymousSessionId) {
  const project = await Project.findById(projectId);
  if (!project) return null;

  if (userId && project.ownerId?.toString() === userId) return project;
  if (!userId && project.anonymousSessionId === anonymousSessionId) return project;

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

// Create project
router.post('/projects', optionalAuth, async (req, res) => {
  try {
    const quotaCheck = await checkQuota(req.userId, req.anonymousSessionId, 'projects');
    if (!quotaCheck.allowed) {
      return res.status(429).json({
        error: 'Project limit reached',
        message: `You can create ${quotaCheck.limit} projects per day`,
        remaining: 0
      });
    }

    const { name } = req.body;

    const project = new Project({
      name: name?.trim() || 'Untitled Project',
      ownerId: req.userId || null,
      anonymousSessionId: req.userId ? null : req.anonymousSessionId
    });

    await project.save();

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
  try {
    const project = await verifyOwnership(req.params.projectId, req.userId, req.anonymousSessionId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Check quota
    const quotaCheck = await checkQuota(req.userId, req.anonymousSessionId, 'chat');
    if (!quotaCheck.allowed) {
      return res.status(429).json({
        error: 'Chat limit reached',
        message: `You have ${quotaCheck.limit} chat requests per day`,
        remaining: 0
      });
    }

    const { message } = req.body;
    if (!message?.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

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
      quota: { remaining: quotaCheck.remaining, limit: quotaCheck.limit }
    });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: 'Failed to process chat' });
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
 * Core at center, constellations in a ring, children clustered near parent
 */
function computeLayout(nebula) {
  const CANVAS_CENTER_X = 600;
  const CANVAS_CENTER_Y = 400;
  const CONSTELLATION_RADIUS = 280;
  const CHILD_RADIUS = 120;
  const CHILD_SPREAD = 0.4; // radians spread for children

  const positions = [];

  // Core node at center
  positions.push({
    nodeRef: 'core',
    x: CANVAS_CENTER_X,
    y: CANVAS_CENTER_Y
  });

  // 6 constellations evenly distributed
  const constellationAngles = {};
  nebula.constellations.forEach((c, i) => {
    const angle = (i * 2 * Math.PI / 6) - Math.PI / 2; // Start from top
    constellationAngles[c.constellation] = angle;
    positions.push({
      nodeRef: `constellation:${c.constellation}`,
      x: CANVAS_CENTER_X + Math.cos(angle) * CONSTELLATION_RADIUS,
      y: CANVAS_CENTER_Y + Math.sin(angle) * CONSTELLATION_RADIUS
    });

    // Children clustered around their constellation
    if (c.children) {
      const childCount = c.children.length;
      c.children.forEach((child, j) => {
        // Spread children in an arc behind the constellation
        const childAngle = angle + (j - (childCount - 1) / 2) * CHILD_SPREAD * 0.5;
        const childDist = CONSTELLATION_RADIUS + CHILD_RADIUS + j * 15;
        positions.push({
          nodeRef: `child:${c.constellation}:${j}`,
          x: CANVAS_CENTER_X + Math.cos(childAngle) * childDist,
          y: CANVAS_CENTER_Y + Math.sin(childAngle) * childDist
        });
      });
    }
  });

  return positions;
}

/**
 * Generate nebula from premise
 * POST /blueprint/nebula
 */
router.post('/nebula', optionalAuth, async (req, res) => {
  try {
    // Check quota
    const quotaCheck = await checkQuota(req.userId, req.anonymousSessionId, 'chat');
    if (!quotaCheck.allowed) {
      return res.status(429).json({
        error: 'Quota exceeded',
        message: 'Log in for more requests',
        remaining: 0
      });
    }

    const { premise, constraints } = req.body;
    if (!premise?.trim()) {
      return res.status(400).json({ error: 'Premise is required' });
    }

    // Generate nebula via LLM
    const llm = getLLM();
    const { nebula, tokensUsed } = await llm.generateNebula(premise, constraints || {});

    // Compute layout positions
    const layout = computeLayout(nebula);

    // Create project
    const project = new Project({
      name: premise.substring(0, 100),
      premise: premise,
      ownerId: req.userId || null,
      anonymousSessionId: req.userId ? null : req.anonymousSessionId
    });
    await project.save();

    // Build operations to create all nodes
    const ops = [];
    const nodeMap = {}; // Track created node IDs

    // Create core node
    const corePos = layout.find(l => l.nodeRef === 'core');
    const coreNode = new Node({
      projectId: project._id,
      kind: 'core',
      title: nebula.core.statement,
      statement: nebula.core.statement,
      detail: nebula.core.detail,
      body: nebula.core.detail,
      scores: nebula.core.scores,
      confidence: nebula.core.confidence,
      stage: nebula.core.stage || 0,
      status: nebula.core.status || 'mapped',
      cost: nebula.core.cost,
      sources: nebula.core.sources || [],
      x: corePos?.x || 600,
      y: corePos?.y || 400,
      depth: 0
    });
    await coreNode.save();
    nodeMap.core = coreNode._id;
    ops.push({ op: 'createNode', nodeId: coreNode._id.toString(), data: formatNodeForClient(coreNode) });

    // Create constellation nodes and their children
    for (const c of nebula.constellations) {
      const constPos = layout.find(l => l.nodeRef === `constellation:${c.constellation}`);
      const constNode = new Node({
        projectId: project._id,
        parentNodeId: coreNode._id,
        kind: 'constellation',
        constellation: c.constellation,
        title: c.statement,
        statement: c.statement,
        detail: c.detail,
        body: c.detail,
        scores: c.scores,
        confidence: c.confidence,
        stage: c.stage || 0,
        status: c.status || 'mapped',
        cost: c.cost,
        sources: c.sources || [],
        x: constPos?.x || 600,
        y: constPos?.y || 400,
        depth: 1
      });
      await constNode.save();
      nodeMap[`constellation:${c.constellation}`] = constNode._id;
      ops.push({ op: 'createNode', nodeId: constNode._id.toString(), data: formatNodeForClient(constNode) });

      // Create edge from core to constellation
      const constEdge = new Edge({
        projectId: project._id,
        fromNodeId: coreNode._id,
        toNodeId: constNode._id,
        type: 'contains'
      });
      await constEdge.save();
      ops.push({ op: 'createEdge', edgeId: constEdge._id.toString(), data: { fromNodeId: coreNode._id.toString(), toNodeId: constNode._id.toString(), type: 'contains' } });

      // Create children
      if (c.children) {
        for (let j = 0; j < c.children.length; j++) {
          const child = c.children[j];
          const childPos = layout.find(l => l.nodeRef === `child:${c.constellation}:${j}`);
          const childNode = new Node({
            projectId: project._id,
            parentNodeId: constNode._id,
            kind: 'star',
            title: child.statement,
            statement: child.statement,
            detail: child.detail,
            body: child.detail,
            scores: child.scores,
            confidence: child.confidence,
            stage: child.stage || constNode.stage,
            status: child.status || 'unexplored',
            cost: child.cost,
            sources: child.sources || [],
            x: childPos?.x || constNode.x + 100,
            y: childPos?.y || constNode.y + j * 60,
            depth: 2
          });
          await childNode.save();
          ops.push({ op: 'createNode', nodeId: childNode._id.toString(), data: formatNodeForClient(childNode) });

          // Create edge from constellation to child
          const childEdge = new Edge({
            projectId: project._id,
            fromNodeId: constNode._id,
            toNodeId: childNode._id,
            type: 'contains'
          });
          await childEdge.save();
          ops.push({ op: 'createEdge', edgeId: childEdge._id.toString(), data: { fromNodeId: constNode._id.toString(), toNodeId: childNode._id.toString(), type: 'contains' } });
        }
      }
    }

    res.json({
      success: true,
      project: {
        id: project._id,
        name: project.name,
        premise: premise
      },
      ops,
      tokensUsed,
      quota: { remaining: quotaCheck.remaining - 1, limit: quotaCheck.limit }
    });

  } catch (error) {
    console.error('Nebula generation error:', error);
    res.status(500).json({ error: 'Failed to generate nebula', message: error.message });
  }
});

/**
 * Expand a star into children
 * POST /blueprint/expand
 */
router.post('/expand', optionalAuth, async (req, res) => {
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

    // Check quota
    const quotaCheck = await checkQuota(req.userId, req.anonymousSessionId, 'chat');
    if (!quotaCheck.allowed) {
      return res.status(429).json({
        error: 'Quota exceeded',
        message: 'Log in for more requests',
        remaining: 0
      });
    }

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

module.exports = router;
