/**
 * CommentController - Comments on maps and specific nodes
 *
 * Node-level comments are the primary UX.
 * Map-level comments (nodeId = null) are secondary.
 */

const express = require('express');
const router = express.Router();
const Comment = require('../models/Comment');
const SharedMap = require('../models/SharedMap');
const User = require('../models/User');
const { verifyToken, optionalAuth } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');

// Rate limiter for comments
const commentLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 comments per minute
  message: { success: false, error: 'Too many comments. Slow down.' }
});

// GET /comments/:mapId - Get all comments for a map (public)
router.get('/:mapId', optionalAuth, async (req, res) => {
  try {
    const { nodeId } = req.query;

    // Check map exists and is accessible
    const map = await SharedMap.findById(req.params.mapId);
    if (!map) {
      return res.status(404).json({ success: false, error: 'Map not found' });
    }

    // Build query
    const query = {
      mapId: req.params.mapId,
      deletedAt: null,
      hiddenAt: null
    };

    // If nodeId specified, filter to that node
    if (nodeId) {
      query.nodeId = nodeId;
    }

    const comments = await Comment.find(query)
      .sort({ createdAt: 1 })
      .lean();

    // Group by nodeId for easier client rendering
    const byNode = {};
    const mapLevel = [];

    comments.forEach(c => {
      if (c.nodeId) {
        const nid = c.nodeId.toString();
        if (!byNode[nid]) byNode[nid] = [];
        byNode[nid].push(c);
      } else {
        mapLevel.push(c);
      }
    });

    // Count comments per node
    const nodeCounts = {};
    for (const [nid, cmts] of Object.entries(byNode)) {
      nodeCounts[nid] = cmts.length;
    }

    res.json({
      success: true,
      comments: nodeId ? comments : mapLevel,
      byNode: nodeId ? undefined : byNode,
      nodeCounts,
      total: comments.length
    });
  } catch (err) {
    console.error('Get comments error:', err);
    res.status(500).json({ success: false, error: 'Failed to load comments' });
  }
});

// POST /comments/:mapId - Create a comment
router.post('/:mapId', verifyToken, commentLimiter, async (req, res) => {
  try {
    const { nodeId, body } = req.body;

    if (!body || body.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Comment body required' });
    }

    if (body.length > 2000) {
      return res.status(400).json({ success: false, error: 'Comment too long (max 2000 chars)' });
    }

    // Check map exists and is public
    const map = await SharedMap.findById(req.params.mapId);
    if (!map || map.visibility === 'private' || map.unpublishedAt) {
      return res.status(404).json({ success: false, error: 'Map not found' });
    }

    // If nodeId specified, verify it exists in the snapshot
    if (nodeId) {
      const nodeExists = map.snapshot.nodes?.some(n => n._id.toString() === nodeId) ||
                         map.snapshot.core?._id?.toString() === nodeId;
      if (!nodeExists) {
        return res.status(400).json({ success: false, error: 'Node not found in map' });
      }
    }

    // Get user info
    const user = await User.findById(req.userId);

    const comment = new Comment({
      mapId: req.params.mapId,
      nodeId: nodeId || null,
      userId: req.userId,
      body: body.trim(),
      userName: user.firstName || user.email.split('@')[0],
      userHandle: user.email.split('@')[0],
      userAvatar: user.profilePhotoThumb
    });

    await comment.save();

    // Update comment count
    await SharedMap.updateOne(
      { _id: req.params.mapId },
      { $inc: { commentCount: 1 } }
    );

    res.json({
      success: true,
      comment: {
        _id: comment._id,
        nodeId: comment.nodeId,
        userId: comment.userId,
        body: comment.body,
        userName: comment.userName,
        userHandle: comment.userHandle,
        userAvatar: comment.userAvatar,
        createdAt: comment.createdAt
      }
    });
  } catch (err) {
    console.error('Create comment error:', err);
    res.status(500).json({ success: false, error: 'Failed to create comment' });
  }
});

// PUT /comments/:commentId - Edit own comment
router.put('/:commentId', verifyToken, async (req, res) => {
  try {
    const { body } = req.body;

    if (!body || body.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Comment body required' });
    }

    if (body.length > 2000) {
      return res.status(400).json({ success: false, error: 'Comment too long (max 2000 chars)' });
    }

    const comment = await Comment.findById(req.params.commentId);

    if (!comment) {
      return res.status(404).json({ success: false, error: 'Comment not found' });
    }

    // Only author can edit
    if (comment.userId.toString() !== req.userId) {
      return res.status(403).json({ success: false, error: 'Cannot edit another user\'s comment' });
    }

    // Can't edit deleted comments
    if (comment.deletedAt) {
      return res.status(400).json({ success: false, error: 'Comment has been deleted' });
    }

    comment.body = body.trim();
    comment.editedAt = new Date();
    await comment.save();

    res.json({
      success: true,
      comment: {
        _id: comment._id,
        body: comment.body,
        editedAt: comment.editedAt
      }
    });
  } catch (err) {
    console.error('Edit comment error:', err);
    res.status(500).json({ success: false, error: 'Failed to edit comment' });
  }
});

// DELETE /comments/:commentId - Delete own comment
router.delete('/:commentId', verifyToken, async (req, res) => {
  try {
    const comment = await Comment.findById(req.params.commentId);

    if (!comment) {
      return res.status(404).json({ success: false, error: 'Comment not found' });
    }

    // Only author can delete
    if (comment.userId.toString() !== req.userId) {
      return res.status(403).json({ success: false, error: 'Cannot delete another user\'s comment' });
    }

    // Soft delete
    comment.deletedAt = new Date();
    await comment.save();

    // Update comment count
    await SharedMap.updateOne(
      { _id: comment.mapId },
      { $inc: { commentCount: -1 } }
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Delete comment error:', err);
    res.status(500).json({ success: false, error: 'Failed to delete comment' });
  }
});

// POST /comments/:commentId/hide - Map owner hides a comment
router.post('/:commentId/hide', verifyToken, async (req, res) => {
  try {
    const comment = await Comment.findById(req.params.commentId);

    if (!comment) {
      return res.status(404).json({ success: false, error: 'Comment not found' });
    }

    // Check if user is map owner
    const map = await SharedMap.findById(comment.mapId);
    if (!map || map.ownerId.toString() !== req.userId) {
      return res.status(403).json({ success: false, error: 'Only map owner can hide comments' });
    }

    if (comment.hiddenAt) {
      // Unhide
      comment.hiddenAt = null;
      comment.hiddenBy = null;
    } else {
      // Hide
      comment.hiddenAt = new Date();
      comment.hiddenBy = req.userId;
    }

    await comment.save();

    res.json({
      success: true,
      hidden: !!comment.hiddenAt
    });
  } catch (err) {
    console.error('Hide comment error:', err);
    res.status(500).json({ success: false, error: 'Failed to hide comment' });
  }
});

module.exports = router;
