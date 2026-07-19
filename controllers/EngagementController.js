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
const User = require('../models/User');
const { verifyToken } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');

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
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const mapId = req.params.mapId;
    const userId = req.userId;

    // Get the shared map with snapshot
    const map = await SharedMap.findById(mapId);
    if (!map || map.visibility === 'private' || map.unpublishedAt) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, error: 'Map not found' });
    }

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
    await project.save({ session });

    // Create nodes from snapshot
    const nodeIdMap = new Map(); // old ID -> new ID

    // Create core node
    if (map.snapshot.core) {
      const coreNode = new Node({
        projectId: project._id,
        label: map.snapshot.core.label,
        statement: map.snapshot.core.statement,
        detail: map.snapshot.core.detail,
        x: map.snapshot.core.x || 600,
        y: map.snapshot.core.y || 400,
        depth: 0
      });
      await coreNode.save({ session });
      nodeIdMap.set(map.snapshot.core._id.toString(), coreNode._id);
    }

    // Create other nodes
    for (const snapNode of (map.snapshot.nodes || [])) {
      const node = new Node({
        projectId: project._id,
        parentNodeId: snapNode.parentNodeId ? nodeIdMap.get(snapNode.parentNodeId.toString()) : null,
        label: snapNode.label,
        statement: snapNode.statement,
        detail: snapNode.detail,
        constellation: snapNode.constellation,
        stage: snapNode.stage,
        scores: snapNode.scores,
        confidence: snapNode.confidence,
        cost: snapNode.cost,
        dependencies: snapNode.dependencies,
        status: snapNode.status,
        sources: snapNode.sources,
        depth: snapNode.depth,
        x: snapNode.x,
        y: snapNode.y
      });
      await node.save({ session });
      nodeIdMap.set(snapNode._id.toString(), node._id);
    }

    // Create edges
    for (const snapEdge of (map.snapshot.edges || [])) {
      const sourceId = nodeIdMap.get(snapEdge.sourceId.toString());
      const targetId = nodeIdMap.get(snapEdge.targetId.toString());
      if (sourceId && targetId) {
        const edge = new Edge({
          projectId: project._id,
          sourceId,
          targetId
        });
        await edge.save({ session });
      }
    }

    // Record fork
    await new Fork({
      sourceMapId: mapId,
      newProjectId: project._id,
      userId
    }).save({ session });

    // Update fork count
    await SharedMap.updateOne(
      { _id: mapId },
      { $inc: { forkCount: 1 } }
    ).session(session);

    await session.commitTransaction();

    res.json({
      success: true,
      action: 'forked',
      projectId: project._id,
      forkCount: map.forkCount + 1
    });
  } catch (err) {
    await session.abortTransaction();
    console.error('Fork error:', err);
    res.status(500).json({ success: false, error: 'Failed to fork' });
  } finally {
    session.endSession();
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
