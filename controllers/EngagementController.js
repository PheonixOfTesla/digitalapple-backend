/**
 * EngagementController - Star, Repost, Fork, Follow
 *
 * All write actions require authentication.
 * Guests get 401 which the client converts to login modal.
 */

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const SharedMap = require('../models/SharedMap');
const Star = require('../models/Star');
const Repost = require('../models/Repost');
const Fork = require('../models/Fork');
const Follow = require('../models/Follow');
const Project = require('../models/Project');
const Node = require('../models/Node');
const Edge = require('../models/Edge');
const Core = require('../models/Core');
const User = require('../models/User');
const NebulaLog = require('../models/NebulaLog');
const { verifyToken } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');
const identity = require('../services/identity');

// Rate limiters
const starLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 stars per minute
  message: { success: false, error: 'Too many stars. Slow down.' }
});

const repostLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // 20 reposts per hour
  message: { success: false, error: 'Repost limit reached. Try again later.' }
});

const forkLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 forks per hour
  message: { success: false, error: 'Fork limit reached. Try again later.' }
});

// POST /engage/star/:mapId - Toggle star on a map
router.post('/star/:mapId', verifyToken, starLimiter, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const mapId = req.params.mapId;
    const userId = req.userId;

    // Check map exists and is public
    const map = await SharedMap.findById(mapId);
    if (!map || map.visibility === 'private' || map.unpublishedAt) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, error: 'Map not found' });
    }

    // Check if already starred
    const existingStar = await Star.findOne({ mapId, userId });

    if (existingStar) {
      // Unstar
      await Star.deleteOne({ _id: existingStar._id }).session(session);
      await SharedMap.updateOne(
        { _id: mapId },
        { $inc: { starCount: -1 } }
      ).session(session);

      await session.commitTransaction();

      res.json({
        success: true,
        action: 'unstarred',
        starCount: Math.max(0, map.starCount - 1)
      });
    } else {
      // Star
      await new Star({ mapId, userId }).save({ session });
      await SharedMap.updateOne(
        { _id: mapId },
        { $inc: { starCount: 1 } }
      ).session(session);

      await session.commitTransaction();

      res.json({
        success: true,
        action: 'starred',
        starCount: map.starCount + 1
      });
    }
  } catch (err) {
    await session.abortTransaction();
    console.error('Star error:', err);
    res.status(500).json({ success: false, error: 'Failed to star' });
  } finally {
    session.endSession();
  }
});

// POST /engage/repost/:mapId - Repost a map to followers
router.post('/repost/:mapId', verifyToken, repostLimiter, async (req, res) => {
  try {
    const mapId = req.params.mapId;
    const userId = req.userId;

    // Check map exists and is public
    const map = await SharedMap.findById(mapId);
    if (!map || map.visibility === 'private' || map.unpublishedAt) {
      return res.status(404).json({ success: false, error: 'Map not found' });
    }

    // Check for recent repost (prevent spam)
    const recentRepost = await Repost.findOne({
      mapId,
      userId,
      createdAt: { $gt: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    });

    if (recentRepost) {
      return res.status(400).json({
        success: false,
        error: 'Already reposted this map recently'
      });
    }

    // Create repost
    await new Repost({ mapId, userId }).save();
    await SharedMap.updateOne({ _id: mapId }, { $inc: { repostCount: 1 } });

    res.json({
      success: true,
      action: 'reposted',
      repostCount: map.repostCount + 1
    });
  } catch (err) {
    console.error('Repost error:', err);
    res.status(500).json({ success: false, error: 'Failed to repost' });
  }
});

// POST /engage/fork/:mapId - Fork a map into user's own project
router.post('/fork/:mapId', verifyToken, forkLimiter, async (req, res) => {
  // NOTE: intentionally NOT using a multi-document transaction. The production
  // Mongo (Railway plugin) is a standalone instance, not a replica set, so
  // startTransaction() throws and every fork 500s. We do best-effort sequential
  // writes and clean up the partial project if anything fails partway.
  let createdProjectId = null;
  async function rollback() {
    if (!createdProjectId) return;
    try {
      await Promise.all([
        Node.deleteMany({ projectId: createdProjectId }),
        Edge.deleteMany({ projectId: createdProjectId }),
        Core.deleteMany({ projectId: createdProjectId }),
        Fork.deleteMany({ newProjectId: createdProjectId }),
        Project.deleteOne({ _id: createdProjectId })
      ]);
    } catch (e) { console.error('Fork rollback error:', e.message); }
  }

  try {
    const mapId = req.params.mapId;
    const userId = req.userId;

    // Get the shared map with snapshot
    const map = await SharedMap.findById(mapId);
    if (!map || map.visibility === 'private' || map.unpublishedAt) {
      return res.status(404).json({ success: false, error: 'Map not found' });
    }

    // Get source Core if exists (for origin tracking)
    const sourceCore = await Core.findOne({ projectId: map.projectId });

    // Get user info
    const user = await User.findById(userId);

    // Create new project from snapshot
    const project = new Project({
      name: `Fork of: ${map.title}`,
      premise: map.description,
      ownerId: userId,
      forkedFrom: {
        mapId: map._id,
        mapTitle: map.title,
        ownerId: map.ownerId,
        ownerName: map.ownerName
      }
    });
    await project.save();
    createdProjectId = project._id;

    // Create nodes from snapshot
    const nodeIdMap = new Map(); // old ID -> new ID
    const pathMap = new Map();   // old ID -> path in source (for rebuilding)
    let coreNodeId = null;

    // Create core node first
    if (map.snapshot.core) {
      const snapCore = map.snapshot.core;
      const coreNode = new Node({
        projectId: project._id,
        kind: 'core',
        title: snapCore.title || snapCore.label,
        label: snapCore.label,
        statement: snapCore.statement,
        detail: snapCore.detail,
        body: snapCore.detail,
        x: snapCore.x || 600,
        y: snapCore.y || 400,
        depth: 0,
        // Identity fields from snapshot
        liveness: snapCore.liveness,
        nodeKind: snapCore.nodeKind,
        terminal: snapCore.terminal,
        scoped: snapCore.scoped,
        scopedPaths: snapCore.scopedPaths,
        scopeRecommendation: snapCore.scopeRecommendation
      });
      await coreNode.save();
      nodeIdMap.set(snapCore._id.toString(), coreNode._id);
      coreNodeId = coreNode._id;

      // Store path for core (just itself)
      pathMap.set(snapCore._id.toString(), [{ nodeId: coreNode._id, title: coreNode.title }]);
    }

    // Create other nodes (collect in order for path building)
    const orderedNodes = [];
    const nodesById = new Map();
    for (const snapNode of (map.snapshot.nodes || [])) {
      nodesById.set(snapNode._id.toString(), snapNode);
      orderedNodes.push(snapNode);
    }

    // Sort by depth for proper path building
    orderedNodes.sort((a, b) => (a.depth || 0) - (b.depth || 0));

    for (const snapNode of orderedNodes) {
      const parentId = snapNode.parentNodeId?.toString();
      const newParentId = parentId ? nodeIdMap.get(parentId) : null;

      const node = new Node({
        projectId: project._id,
        parentNodeId: newParentId,
        kind: snapNode.kind || 'star',
        title: snapNode.title || snapNode.label,
        label: snapNode.label,
        statement: snapNode.statement,
        detail: snapNode.detail,
        body: snapNode.detail,
        constellation: snapNode.constellation,
        constellationLabel: snapNode.constellationLabel,
        stage: snapNode.stage,
        scores: snapNode.scores,
        confidence: snapNode.confidence,
        cost: snapNode.cost,
        dependencies: snapNode.dependencies,
        status: snapNode.status,
        sources: snapNode.sources,
        depth: snapNode.depth,
        expanded: snapNode.expanded,
        terminal: snapNode.terminal,
        expansionType: snapNode.expansionType,
        subFrameType: snapNode.subFrameType,
        x: snapNode.x,
        y: snapNode.y,
        // Identity fields from snapshot
        liveness: snapNode.liveness,
        nodeKind: snapNode.nodeKind,
        // Scoping fields from snapshot (for already-scoped nodes)
        scoped: snapNode.scoped,
        scopedPaths: snapNode.scopedPaths,
        scopeRecommendation: snapNode.scopeRecommendation
      });
      await node.save();
      nodeIdMap.set(snapNode._id.toString(), node._id);

      // Build path from parent's path
      const parentPath = parentId ? pathMap.get(parentId) : pathMap.get(map.snapshot.core?._id?.toString());
      const nodePath = parentPath ? [...parentPath, { nodeId: node._id, title: node.title }] : [{ nodeId: node._id, title: node.title }];
      pathMap.set(snapNode._id.toString(), nodePath);
    }

    // Create Core document for forked project
    const newCore = new Core({
      projectId: project._id,
      coreNodeId: coreNodeId,
      premise: map.description || map.title,
      classification: sourceCore?.classification || {
        type: 'unknown',
        confidence: 0.5,
        alternates: [],
        reasoning: 'Forked map'
      },
      frameMeta: sourceCore?.frameMeta || {},
      stagesEnabled: sourceCore?.stagesEnabled ?? true,
      origin: {
        coreId: sourceCore?._id || null,
        projectId: map.projectId || null,
        forkedAt: new Date(),
        forkedBy: userId
      }
    });
    await newCore.save();

    // Now assign identity to all nodes
    // Core node first
    if (coreNodeId) {
      const corePath = pathMap.get(map.snapshot.core._id.toString());
      await Node.updateOne(
        { _id: coreNodeId },
        {
          coreId: newCore._id,
          path: corePath,
          stableId: identity.computeStableId(newCore._id, corePath),
          essence: { title: map.snapshot.core.title || map.snapshot.core.label, statement: map.snapshot.core.statement },
          derivation: { kind: 'fork', sourcePrompt: null, usedTrace: false }
        }
      );
    }

    // Other nodes
    for (const snapNode of orderedNodes) {
      const newNodeId = nodeIdMap.get(snapNode._id.toString());
      const nodePath = pathMap.get(snapNode._id.toString());
      if (newNodeId && nodePath) {
        await Node.updateOne(
          { _id: newNodeId },
          {
            coreId: newCore._id,
            path: nodePath,
            stableId: identity.computeStableId(newCore._id, nodePath),
            essence: {
              title: snapNode.title || snapNode.label,
              statement: snapNode.statement,
              constellation: snapNode.constellation,
              constellationLabel: snapNode.constellationLabel
            },
            derivation: { kind: 'fork', sourcePrompt: null, usedTrace: false }
          }
        );
      }
    }

    // Create edges
    for (const snapEdge of (map.snapshot.edges || [])) {
      const sourceId = nodeIdMap.get(snapEdge.sourceId.toString());
      const targetId = nodeIdMap.get(snapEdge.targetId.toString());
      if (sourceId && targetId) {
        const edge = new Edge({
          projectId: project._id,
          fromNodeId: sourceId,
          toNodeId: targetId,
          type: snapEdge.type || 'contains'
        });
        await edge.save();
      }
    }

    // Record fork
    await new Fork({
      sourceMapId: mapId,
      newProjectId: project._id,
      userId
    }).save();

    // Update fork count (only after everything above succeeded)
    await SharedMap.updateOne(
      { _id: mapId },
      { $inc: { forkCount: 1 } }
    );

    // Durable creation record for the admin nebula tracker (best-effort).
    NebulaLog.create({
      creatorType: 'registered',
      ownerId: userId,
      projectId: project._id,
      premise: (map.description || '').slice(0, 1000),
      title: `Fork of: ${map.title}`.slice(0, 200),
      classificationType: 'fork',
      forked: true,
      forkedFromTitle: map.title
    }).catch((e) => console.error('NebulaLog (fork) write failed:', e.message));

    res.json({
      success: true,
      action: 'forked',
      projectId: project._id,
      coreId: newCore._id,
      forkCount: map.forkCount + 1,
      origin: sourceCore ? {
        coreId: sourceCore._id,
        projectId: map.projectId
      } : null
    });
  } catch (err) {
    console.error('Fork error:', err);
    await rollback();
    res.status(500).json({ success: false, error: 'Failed to fork' });
  }
});

// POST /engage/follow/:userId - Follow a user
router.post('/follow/:userId', verifyToken, async (req, res) => {
  try {
    const followeeId = req.params.userId;
    const followerId = req.userId;

    // Can't follow yourself
    if (followeeId === followerId) {
      return res.status(400).json({ success: false, error: 'Cannot follow yourself' });
    }

    // Check user exists
    const followee = await User.findById(followeeId);
    if (!followee) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Check if already following
    const existingFollow = await Follow.findOne({ followerId, followeeId });

    if (existingFollow) {
      // Unfollow
      await Follow.deleteOne({ _id: existingFollow._id });
      res.json({ success: true, action: 'unfollowed' });
    } else {
      // Follow
      await new Follow({ followerId, followeeId }).save();
      res.json({ success: true, action: 'followed' });
    }
  } catch (err) {
    console.error('Follow error:', err);
    res.status(500).json({ success: false, error: 'Failed to follow' });
  }
});

// GET /engage/following - Get list of users the current user follows
router.get('/following', verifyToken, async (req, res) => {
  try {
    const follows = await Follow.find({ followerId: req.userId })
      .populate('followeeId', 'firstName lastName email profilePhotoThumb')
      .sort({ createdAt: -1 })
      .lean();

    const users = follows.map(f => ({
      _id: f.followeeId._id,
      name: f.followeeId.firstName || f.followeeId.email.split('@')[0],
      avatar: f.followeeId.profilePhotoThumb
    }));

    res.json({ success: true, users });
  } catch (err) {
    console.error('Get following error:', err);
    res.status(500).json({ success: false, error: 'Failed to get following' });
  }
});

// GET /engage/followers - Get list of users following the current user
router.get('/followers', verifyToken, async (req, res) => {
  try {
    const follows = await Follow.find({ followeeId: req.userId })
      .populate('followerId', 'firstName lastName email profilePhotoThumb')
      .sort({ createdAt: -1 })
      .lean();

    const users = follows.map(f => ({
      _id: f.followerId._id,
      name: f.followerId.firstName || f.followerId.email.split('@')[0],
      avatar: f.followerId.profilePhotoThumb
    }));

    res.json({ success: true, users });
  } catch (err) {
    console.error('Get followers error:', err);
    res.status(500).json({ success: false, error: 'Failed to get followers' });
  }
});

module.exports = router;
