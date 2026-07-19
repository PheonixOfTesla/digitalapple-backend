/**
 * ShareController - Publish/Unpublish maps with branch exclusion
 *
 * Privacy: Maps are private by default. Sharing is explicit.
 * Branch exclusion: Excluded branches are physically omitted from snapshot.
 */

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const SharedMap = require('../models/SharedMap');
const Project = require('../models/Project');
const Node = require('../models/Node');
const Edge = require('../models/Edge');
const User = require('../models/User');
const { verifyToken } = require('../middleware/auth');

// Helper: Get all descendant node IDs for a given root node
async function getDescendantIds(projectId, rootNodeId) {
  const descendants = new Set();
  const queue = [rootNodeId.toString()];

  while (queue.length > 0) {
    const current = queue.shift();
    descendants.add(current);

    // Find children
    const children = await Node.find({
      projectId,
      parentNodeId: current
    }).select('_id');

    for (const child of children) {
      const childId = child._id.toString();
      if (!descendants.has(childId)) {
        queue.push(childId);
      }
    }
  }

  return descendants;
}

// Helper: Build snapshot excluding specified branches
async function buildSnapshot(projectId, excludedBranchRoots = []) {
  // Get excluded node IDs (roots + all descendants)
  const excludedIds = new Set();
  for (const rootId of excludedBranchRoots) {
    const descendants = await getDescendantIds(projectId, rootId);
    descendants.forEach(id => excludedIds.add(id));
  }

  // Get all nodes
  const allNodes = await Node.find({ projectId }).lean();

  // Filter out excluded nodes
  const includedNodes = allNodes.filter(n => !excludedIds.has(n._id.toString()));

  // Find the core node (depth 0, no parent)
  const coreNode = includedNodes.find(n => n.depth === 0 || !n.parentNodeId);
  const otherNodes = includedNodes.filter(n => n !== coreNode);

  // Get edges between included nodes
  const includedNodeIds = new Set(includedNodes.map(n => n._id.toString()));
  const allEdges = await Edge.find({ projectId }).lean();
  const includedEdges = allEdges.filter(e =>
    includedNodeIds.has(e.sourceId.toString()) &&
    includedNodeIds.has(e.targetId.toString())
  );

  // Calculate coverage (simplified: % of nodes with status !== 'unexplored')
  const explored = otherNodes.filter(n => n.status && n.status !== 'unexplored').length;
  const coverage = otherNodes.length > 0 ? Math.round((explored / otherNodes.length) * 100) : 0;

  return {
    snapshot: {
      core: coreNode ? {
        _id: coreNode._id,
        label: coreNode.label,
        statement: coreNode.statement,
        detail: coreNode.detail,
        x: coreNode.x,
        y: coreNode.y
      } : null,
      nodes: otherNodes.map(n => ({
        _id: n._id,
        parentNodeId: n.parentNodeId,
        label: n.label,
        statement: n.statement,
        detail: n.detail,
        constellation: n.constellation,
        stage: n.stage,
        scores: n.scores,
        confidence: n.confidence,
        cost: n.cost,
        dependencies: n.dependencies,
        status: n.status,
        sources: n.sources,
        depth: n.depth,
        x: n.x,
        y: n.y
      })),
      edges: includedEdges.map(e => ({
        _id: e._id,
        sourceId: e.sourceId,
        targetId: e.targetId
      }))
    },
    nodeCount: includedNodes.length,
    coverage
  };
}

// POST /share/publish/:projectId - Publish a project as a shared map
router.post('/publish/:projectId', verifyToken, async (req, res) => {
  try {
    const { title, description, category, visibility, excludedBranchRoots } = req.body;
    const projectId = req.params.projectId;

    // Verify ownership
    const project = await Project.findById(projectId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }
    if (project.ownerId?.toString() !== req.userId) {
      return res.status(403).json({ success: false, error: 'Not your project' });
    }

    // Get user info
    const user = await User.findById(req.userId);

    // Check for existing shared map
    let sharedMap = await SharedMap.findOne({ projectId });

    // Build snapshot with exclusions
    const { snapshot, nodeCount, coverage } = await buildSnapshot(
      projectId,
      excludedBranchRoots || []
    );

    if (sharedMap) {
      // Update existing
      sharedMap.title = title || project.name;
      sharedMap.description = description || project.premise;
      sharedMap.category = category || 'other';
      sharedMap.visibility = visibility || 'public';
      sharedMap.coverage = coverage;
      sharedMap.nodeCount = nodeCount;
      sharedMap.snapshot = snapshot;
      sharedMap.excludedBranchRoots = excludedBranchRoots || [];
      sharedMap.publishedAt = new Date();
      sharedMap.unpublishedAt = null;
      sharedMap.ownerName = user.firstName || user.email.split('@')[0];
      sharedMap.ownerHandle = user.email.split('@')[0];
      sharedMap.ownerAvatar = user.profilePhotoThumb;

      await sharedMap.save();
    } else {
      // Create new
      sharedMap = new SharedMap({
        projectId,
        ownerId: req.userId,
        title: title || project.name,
        description: description || project.premise,
        category: category || 'other',
        visibility: visibility || 'public',
        coverage,
        nodeCount,
        snapshot,
        excludedBranchRoots: excludedBranchRoots || [],
        publishedAt: new Date(),
        ownerName: user.firstName || user.email.split('@')[0],
        ownerHandle: user.email.split('@')[0],
        ownerAvatar: user.profilePhotoThumb
      });

      await sharedMap.save();
    }

    res.json({
      success: true,
      map: {
        _id: sharedMap._id,
        title: sharedMap.title,
        visibility: sharedMap.visibility,
        coverage: sharedMap.coverage,
        nodeCount: sharedMap.nodeCount,
        publishedAt: sharedMap.publishedAt
      }
    });
  } catch (err) {
    console.error('Publish error:', err);
    res.status(500).json({ success: false, error: 'Failed to publish' });
  }
});

// POST /share/unpublish/:mapId - Unpublish a shared map
router.post('/unpublish/:mapId', verifyToken, async (req, res) => {
  try {
    const map = await SharedMap.findById(req.params.mapId);

    if (!map) {
      return res.status(404).json({ success: false, error: 'Map not found' });
    }

    if (map.ownerId.toString() !== req.userId) {
      return res.status(403).json({ success: false, error: 'Not your map' });
    }

    map.unpublishedAt = new Date();
    map.visibility = 'private';
    await map.save();

    res.json({ success: true });
  } catch (err) {
    console.error('Unpublish error:', err);
    res.status(500).json({ success: false, error: 'Failed to unpublish' });
  }
});

// PUT /share/:mapId - Update shared map settings
router.put('/:mapId', verifyToken, async (req, res) => {
  try {
    const { title, description, category, visibility, excludedBranchRoots } = req.body;

    const map = await SharedMap.findById(req.params.mapId);

    if (!map) {
      return res.status(404).json({ success: false, error: 'Map not found' });
    }

    if (map.ownerId.toString() !== req.userId) {
      return res.status(403).json({ success: false, error: 'Not your map' });
    }

    // Update basic fields
    if (title) map.title = title;
    if (description !== undefined) map.description = description;
    if (category) map.category = category;
    if (visibility) map.visibility = visibility;

    // If branch exclusions changed, rebuild snapshot
    if (excludedBranchRoots !== undefined) {
      const { snapshot, nodeCount, coverage } = await buildSnapshot(
        map.projectId,
        excludedBranchRoots
      );
      map.snapshot = snapshot;
      map.nodeCount = nodeCount;
      map.coverage = coverage;
      map.excludedBranchRoots = excludedBranchRoots;
    }

    await map.save();

    res.json({
      success: true,
      map: {
        _id: map._id,
        title: map.title,
        description: map.description,
        category: map.category,
        visibility: map.visibility,
        coverage: map.coverage,
        nodeCount: map.nodeCount,
        excludedBranchRoots: map.excludedBranchRoots
      }
    });
  } catch (err) {
    console.error('Update share error:', err);
    res.status(500).json({ success: false, error: 'Failed to update' });
  }
});

// GET /share/my-maps - Get user's shared maps
router.get('/my-maps', verifyToken, async (req, res) => {
  try {
    const maps = await SharedMap.find({ ownerId: req.userId })
      .sort({ publishedAt: -1 })
      .select('-snapshot')
      .lean();

    res.json({ success: true, maps });
  } catch (err) {
    console.error('Get my maps error:', err);
    res.status(500).json({ success: false, error: 'Failed to get maps' });
  }
});

// GET /share/branches/:projectId - Get branches available for exclusion
router.get('/branches/:projectId', verifyToken, async (req, res) => {
  try {
    const project = await Project.findById(req.params.projectId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }
    if (project.ownerId?.toString() !== req.userId) {
      return res.status(403).json({ success: false, error: 'Not your project' });
    }

    // Get top-level nodes (direct children of core) as potential branch roots
    const coreNode = await Node.findOne({
      projectId: req.params.projectId,
      $or: [{ depth: 0 }, { parentNodeId: null }]
    });

    if (!coreNode) {
      return res.json({ success: true, branches: [] });
    }

    const branches = await Node.find({
      projectId: req.params.projectId,
      parentNodeId: coreNode._id
    }).select('_id label statement constellation').lean();

    // Count descendants for each branch
    const branchesWithCounts = await Promise.all(branches.map(async (branch) => {
      const descendants = await getDescendantIds(req.params.projectId, branch._id);
      return {
        ...branch,
        nodeCount: descendants.size
      };
    }));

    res.json({ success: true, branches: branchesWithCounts });
  } catch (err) {
    console.error('Get branches error:', err);
    res.status(500).json({ success: false, error: 'Failed to get branches' });
  }
});

module.exports = router;
