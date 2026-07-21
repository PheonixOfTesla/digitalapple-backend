#!/usr/bin/env node
require('dotenv').config();
const mongoose = require('mongoose');
const Node = require('../models/Node');
const Project = require('../models/Project');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const nodesWithoutIdentity = await Node.find({
    $or: [
      { coreId: { $exists: false } },
      { coreId: null }
    ]
  }).select('projectId kind title parentNodeId').lean();

  console.log('Nodes without identity:', nodesWithoutIdentity.length);

  // Group by project
  const byProject = {};
  for (const n of nodesWithoutIdentity) {
    const pid = n.projectId?.toString() || 'no-project';
    if (!byProject[pid]) byProject[pid] = [];
    byProject[pid].push(n);
  }

  for (const [pid, nodes] of Object.entries(byProject)) {
    const project = await Project.findById(pid).select('name').lean();
    console.log('\n' + (project?.name || pid) + ': ' + nodes.length + ' nodes without identity');
    for (const n of nodes.slice(0, 5)) {
      console.log('  - ' + n.kind + ': ' + (n.title || 'no title').substring(0, 50));
    }
    if (nodes.length > 5) console.log('  ... and ' + (nodes.length - 5) + ' more');
  }

  await mongoose.disconnect();
})();
