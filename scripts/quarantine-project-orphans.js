#!/usr/bin/env node
/**
 * quarantine-project-orphans.js - Quarantine nodes whose projects are deleted
 *
 * These are true orphans: their parent Project document no longer exists.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Node = require('../models/Node');
const Project = require('../models/Project');
const OrphanedNode = require('../models/OrphanedNode');

async function main() {
  console.log('[quarantine] Starting orphan cleanup...');

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('[quarantine] Connected to database');

  // Find all unique projectIds from nodes
  const allProjectIds = await Node.distinct('projectId');
  console.log(`[quarantine] Found ${allProjectIds.length} unique projectIds in nodes`);

  // Find which projects actually exist
  const existingProjects = await Project.find({
    _id: { $in: allProjectIds }
  }).select('_id').lean();

  const existingIds = new Set(existingProjects.map(p => p._id.toString()));
  console.log(`[quarantine] ${existingIds.size} projects still exist`);

  // Find orphan projectIds
  const orphanProjectIds = allProjectIds.filter(pid => !existingIds.has(pid.toString()));
  console.log(`[quarantine] ${orphanProjectIds.length} projectIds are orphaned (project deleted)`);

  if (orphanProjectIds.length === 0) {
    console.log('[quarantine] No orphans to quarantine');
    await mongoose.disconnect();
    return;
  }

  // Quarantine nodes from deleted projects
  let quarantined = 0;
  for (const pid of orphanProjectIds) {
    const nodes = await Node.find({ projectId: pid });

    for (const node of nodes) {
      // Move to quarantine
      await OrphanedNode.findOneAndUpdate(
        { originalNodeId: node._id },
        {
          originalNodeId: node._id,
          projectId: pid,
          reason: 'project_deleted',
          details: 'Parent project no longer exists',
          nodeData: node.toObject(),
          quarantinedAt: new Date()
        },
        { upsert: true }
      );

      // Delete from Node collection
      await Node.deleteOne({ _id: node._id });
      quarantined++;
    }

    console.log(`[quarantine] Quarantined ${nodes.length} nodes from deleted project ${pid}`);
  }

  console.log('\n═══════════════════════════════════════════════');
  console.log('QUARANTINE COMPLETE');
  console.log('═══════════════════════════════════════════════');
  console.log(`Total orphan projectIds: ${orphanProjectIds.length}`);
  console.log(`Total nodes quarantined: ${quarantined}`);

  await mongoose.disconnect();
  console.log('[quarantine] Done.');
}

main().catch(err => {
  console.error('Quarantine failed:', err);
  process.exit(1);
});
