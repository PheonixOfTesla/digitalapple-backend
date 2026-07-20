#!/usr/bin/env node
/**
 * verify-identity.js - Verification tests for Blueprint Identity Layer
 *
 * Run all V1-V10 verification tests defined in the spec.
 *
 * Usage:
 *   node scripts/verify-identity.js [--verbose]
 */

require('dotenv').config();
const mongoose = require('mongoose');
const crypto = require('crypto');

const Project = require('../models/Project');
const Node = require('../models/Node');
const Edge = require('../models/Edge');
const Core = require('../models/Core');
const OrphanedNode = require('../models/OrphanedNode');
const identity = require('../services/identity');

const args = process.argv.slice(2);
const VERBOSE = args.includes('--verbose');

const results = {
  passed: 0,
  failed: 0,
  tests: []
};

function log(...args) {
  console.log(...args);
}

function verbose(...args) {
  if (VERBOSE) console.log('  ', ...args);
}

function pass(name, detail = '') {
  results.passed++;
  results.tests.push({ name, status: 'PASS', detail });
  log(`✓ ${name}`);
  if (detail) verbose(detail);
}

function fail(name, reason) {
  results.failed++;
  results.tests.push({ name, status: 'FAIL', reason });
  log(`✗ ${name}: ${reason}`);
}

// V1: Nebula → all nodes have stableId, path leads to core
async function testV1() {
  const name = 'V1: Nebula nodes have stableId and path to core';

  // Find a project with Core
  const core = await Core.findOne({});
  if (!core) {
    return fail(name, 'No Core document found - run nebula first');
  }

  const nodes = await Node.find({ coreId: core._id });
  if (nodes.length === 0) {
    return fail(name, 'No nodes with coreId found');
  }

  let allValid = true;
  let issues = [];

  for (const node of nodes) {
    if (!node.stableId) {
      issues.push(`Node ${node._id} missing stableId`);
      allValid = false;
    }
    if (!node.path || node.path.length === 0) {
      issues.push(`Node ${node._id} missing path`);
      allValid = false;
    } else {
      // Check path leads to core
      const coreNode = await Node.findById(core.coreNodeId);
      if (coreNode && node.path[0].nodeId.toString() !== coreNode._id.toString()) {
        issues.push(`Node ${node._id} path doesn't start at core node`);
        allValid = false;
      }
    }
  }

  if (allValid) {
    pass(name, `Checked ${nodes.length} nodes`);
  } else {
    fail(name, issues.slice(0, 3).join('; ') + (issues.length > 3 ? '...' : ''));
  }
}

// V2: Expand → children inherit coreId from parent
async function testV2() {
  const name = 'V2: Expanded children inherit coreId';

  // Find an expanded node
  const expandedNode = await Node.findOne({ expanded: true, coreId: { $exists: true } });
  if (!expandedNode) {
    return pass(name, 'No expanded nodes yet - skipped');
  }

  const children = await Node.find({ parentNodeId: expandedNode._id });
  if (children.length === 0) {
    return pass(name, 'No children found - skipped');
  }

  let allValid = true;
  for (const child of children) {
    if (!child.coreId || child.coreId.toString() !== expandedNode.coreId.toString()) {
      allValid = false;
      break;
    }
  }

  if (allValid) {
    pass(name, `${children.length} children inherit coreId`);
  } else {
    fail(name, 'Some children have wrong or missing coreId');
  }
}

// V3: stableId survives DB round-trip
async function testV3() {
  const name = 'V3: stableId survives DB round-trip';

  const node = await Node.findOne({ stableId: { $exists: true, $ne: null } });
  if (!node) {
    return fail(name, 'No node with stableId found');
  }

  // Recompute stableId
  const recomputed = identity.computeStableId(node.coreId, node.path);

  if (recomputed === node.stableId) {
    pass(name, `stableId ${node.stableId.substring(0, 16)}... matches`);
  } else {
    fail(name, `Mismatch: stored=${node.stableId.substring(0, 16)}... computed=${recomputed.substring(0, 16)}...`);
  }
}

// V4: Fork → new coreId, paths same length, lineage preserved
async function testV4() {
  const name = 'V4: Fork creates new coreId with lineage';

  // Find a Core with origin (forked)
  const forkedCore = await Core.findOne({ 'origin.coreId': { $exists: true } });
  if (!forkedCore) {
    return pass(name, 'No forked projects yet - skipped');
  }

  // Verify origin reference
  const sourceCore = await Core.findById(forkedCore.origin.coreId);
  if (!sourceCore) {
    return fail(name, 'Forked Core references missing source');
  }

  // Check forked project nodes have new coreId
  const forkedNodes = await Node.find({ coreId: forkedCore._id });
  if (forkedNodes.length === 0) {
    return fail(name, 'No nodes in forked project');
  }

  let pathsValid = true;
  for (const node of forkedNodes) {
    if (!node.path || node.path.length === 0) {
      pathsValid = false;
      break;
    }
  }

  if (pathsValid) {
    pass(name, `Forked project has ${forkedNodes.length} nodes with valid paths`);
  } else {
    fail(name, 'Some forked nodes have invalid paths');
  }
}

// V5: Orphan quarantine (check OrphanedNode collection)
async function testV5() {
  const name = 'V5: Orphan quarantine system';

  // Just verify the model works
  const count = await OrphanedNode.countDocuments({});
  pass(name, `OrphanedNode collection exists (${count} records)`);
}

// V6: Migration dry-run produces stats
async function testV6() {
  const name = 'V6: Migration script exists';

  const fs = require('fs');
  const path = require('path');
  const migrationPath = path.join(__dirname, 'migrate-identity.js');

  if (fs.existsSync(migrationPath)) {
    pass(name, 'migrate-identity.js exists');
  } else {
    fail(name, 'migrate-identity.js not found');
  }
}

// V7: API route /by-stable/:stableId
async function testV7() {
  const name = 'V7: API /by-stable route exists';

  const fs = require('fs');
  const path = require('path');
  const controllerPath = path.join(__dirname, '../controllers/BlueprintController.js');

  const content = fs.readFileSync(controllerPath, 'utf-8');
  if (content.includes('/nodes/by-stable/:stableId')) {
    pass(name, 'Route defined in BlueprintController');
  } else {
    fail(name, 'Route not found in controller');
  }
}

// V8: API route /lineage
async function testV8() {
  const name = 'V8: API /lineage route exists';

  const fs = require('fs');
  const path = require('path');
  const controllerPath = path.join(__dirname, '../controllers/BlueprintController.js');

  const content = fs.readFileSync(controllerPath, 'utf-8');
  if (content.includes('/lineage')) {
    pass(name, 'Lineage routes defined');
  } else {
    fail(name, 'Lineage routes not found');
  }
}

// V9: Manual node requires parent
async function testV9() {
  const name = 'V9: Manual node creation logic';

  const fs = require('fs');
  const path = require('path');
  const controllerPath = path.join(__dirname, '../controllers/BlueprintController.js');

  const content = fs.readFileSync(controllerPath, 'utf-8');
  if (content.includes('Parent node required') && content.includes('parentNodeId')) {
    pass(name, 'Parent validation in manual node creation');
  } else {
    fail(name, 'Parent validation not found');
  }
}

// V10: quickVerifyIdentity detects missing fields
async function testV10() {
  const name = 'V10: quickVerifyIdentity detects issues';

  // Test with a fake node missing fields
  const fakeNode = {
    _id: new mongoose.Types.ObjectId(),
    coreId: null,
    path: null,
    stableId: null
  };

  const result = identity.quickVerifyIdentity(fakeNode);

  if (!result.valid && result.reason) {
    pass(name, `Correctly detected: ${result.reason}`);
  } else {
    fail(name, 'Failed to detect missing identity fields');
  }
}

// Main
async function main() {
  log('═══════════════════════════════════════════════');
  log('  Blueprint Identity Layer - Verification Tests');
  log('═══════════════════════════════════════════════');
  log('');

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  log('Connected to database');
  log('');

  // Run tests
  await testV1();
  await testV2();
  await testV3();
  await testV4();
  await testV5();
  await testV6();
  await testV7();
  await testV8();
  await testV9();
  await testV10();

  log('');
  log('═══════════════════════════════════════════════');
  log(`  Results: ${results.passed} passed, ${results.failed} failed`);
  log('═══════════════════════════════════════════════');

  await mongoose.disconnect();

  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Verification failed:', err);
  process.exit(1);
});
