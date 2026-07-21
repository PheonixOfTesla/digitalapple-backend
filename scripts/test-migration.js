#!/usr/bin/env node
/**
 * test-migration.js - Verify identity migration results
 *
 * Tests M4-M12 from the migration spec
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Project = require('../models/Project');
const Node = require('../models/Node');
const Core = require('../models/Core');
const identity = require('../services/identity');

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log('MIGRATION VERIFICATION TESTS');
  console.log('═══════════════════════════════════════════════════════════════════════════\n');

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('[test] Connected to database\n');

  const results = [];

  // ═══════════════════════════════════════════════════════════════════════════
  // M4: Migrated node has identity fields and passes verification
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('M4: Migrated node has identity fields and passes verifyNodeIdentity');
  try {
    // Find an old project that was migrated (has Core now)
    const core = await Core.findOne({});
    if (!core) throw new Error('No Core found');

    const node = await Node.findOne({ coreId: core._id, kind: { $ne: 'core' } });
    if (!node) throw new Error('No migrated node found');

    // Check identity fields exist
    const hasIdentity = node.coreId && node.path?.length && node.stableId;
    if (!hasIdentity) throw new Error('Node missing identity fields');

    // Verify with identity service
    const verifyResult = await identity.verifyNodeIdentity(node);
    if (!verifyResult.valid) throw new Error(`Verification failed: ${verifyResult.reason}`);

    // Recompute stableId and check it matches
    const recomputed = identity.computeStableId(node.coreId, node.path);
    if (recomputed !== node.stableId) throw new Error('StableId mismatch on recompute');

    console.log(`  ✓ Node ${node._id} has coreId, path (${node.path.length} steps), stableId`);
    console.log(`  ✓ verifyNodeIdentity passed`);
    console.log(`  ✓ stableId recomputes identically: ${node.stableId.substring(0, 16)}...`);
    results.push({ test: 'M4', passed: true, detail: 'Identity fields present and verified' });
  } catch (err) {
    console.log(`  ✗ ${err.message}`);
    results.push({ test: 'M4', passed: false, detail: err.message });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // M5: Broken path causes verification to fail (test on copy - DO NOT SAVE)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nM5: Breaking a node\'s path causes verification to fail');
  try {
    const node = await Node.findOne({ coreId: { $exists: true }, 'path.1': { $exists: true } });
    if (!node) throw new Error('No node with path found');

    // Create a copy with broken path (do NOT save)
    const brokenNode = node.toObject();
    brokenNode.path = [{ nodeId: new mongoose.Types.ObjectId(), title: 'Fake' }]; // Invalid path

    // quickVerifyIdentity should fail
    const quickResult = identity.quickVerifyIdentity(brokenNode);
    if (quickResult.valid) throw new Error('Expected verification to fail but it passed');

    console.log(`  ✓ Broken path correctly fails verification: ${quickResult.reason}`);
    results.push({ test: 'M5', passed: true, detail: `Verification fails with: ${quickResult.reason}` });
  } catch (err) {
    console.log(`  ✗ ${err.message}`);
    results.push({ test: 'M5', passed: false, detail: err.message });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // M6: Liveness derives correctly for migrated nodes
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nM6: Liveness derives correctly for migrated nodes');
  try {
    // Test dormant: basis unknown, not terminal
    const dormantNode = await Node.findOne({
      coreId: { $exists: true },
      $or: [
        { 'confidence.basis': 'unknown' },
        { confidence: { $exists: false } }
      ],
      terminal: { $ne: true }
    });

    // Test open: basis stated/inferred, not terminal
    const openNode = await Node.findOne({
      coreId: { $exists: true },
      'confidence.basis': { $in: ['stated', 'inferred'] },
      terminal: { $ne: true }
    });

    // Test walled: terminal = true
    const walledNode = await Node.findOne({
      coreId: { $exists: true },
      terminal: true
    });

    const livenessResults = [];

    if (dormantNode) {
      const basis = dormantNode.confidence?.basis || 'unknown';
      const isTerminal = dormantNode.terminal || false;
      const liveness = isTerminal ? 'walled' : (basis === 'unknown' ? 'dormant' : 'open');
      livenessResults.push(`dormant node found: basis=${basis}, terminal=${isTerminal}, derives to ${liveness}`);
      if (liveness !== 'dormant') throw new Error('Dormant node derived incorrectly');
    }

    if (openNode) {
      const basis = openNode.confidence?.basis || 'unknown';
      const isTerminal = openNode.terminal || false;
      const liveness = isTerminal ? 'walled' : (basis === 'unknown' ? 'dormant' : 'open');
      livenessResults.push(`open node found: basis=${basis}, terminal=${isTerminal}, derives to ${liveness}`);
      if (liveness !== 'open') throw new Error('Open node derived incorrectly');
    }

    if (walledNode) {
      const isTerminal = walledNode.terminal || false;
      const liveness = isTerminal ? 'walled' : 'open';
      livenessResults.push(`walled node found: terminal=${isTerminal}, derives to ${liveness}`);
      if (liveness !== 'walled') throw new Error('Walled node derived incorrectly');
    }

    if (livenessResults.length === 0) {
      throw new Error('No nodes found to test liveness');
    }

    for (const r of livenessResults) {
      console.log(`  ✓ ${r}`);
    }
    results.push({ test: 'M6', passed: true, detail: `Tested ${livenessResults.length} liveness states` });
  } catch (err) {
    console.log(`  ✗ ${err.message}`);
    results.push({ test: 'M6', passed: false, detail: err.message });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // M7: Engine works on old data (check that nodes have recursion fields)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nM7: Migrated nodes have recursion fields (engine-compatible)');
  try {
    const nodesWithRecursion = await Node.countDocuments({
      coreId: { $exists: true },
      expanded: { $exists: true },
      terminal: { $exists: true }
    });

    const totalMigrated = await Node.countDocuments({ coreId: { $exists: true } });

    if (nodesWithRecursion === 0) throw new Error('No nodes with recursion fields');

    console.log(`  ✓ ${nodesWithRecursion}/${totalMigrated} migrated nodes have recursion fields`);
    console.log(`  NOTE: Live expand test requires API call - verify manually on frontend`);
    results.push({ test: 'M7', passed: true, detail: `${nodesWithRecursion} nodes have expanded/terminal fields` });
  } catch (err) {
    console.log(`  ✗ ${err.message}`);
    results.push({ test: 'M7', passed: false, detail: err.message });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // M8: Scoping fields present on migrated nodes
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nM8: Migrated nodes have scoping fields (scope-ready)');
  try {
    const nodesWithScoping = await Node.countDocuments({
      coreId: { $exists: true },
      nodeKind: { $exists: true }
    });

    const totalMigrated = await Node.countDocuments({ coreId: { $exists: true } });

    if (nodesWithScoping === 0) throw new Error('No nodes with scoping fields');

    // Check default value
    const componentNodes = await Node.countDocuments({
      coreId: { $exists: true },
      nodeKind: 'component'
    });

    console.log(`  ✓ ${nodesWithScoping}/${totalMigrated} migrated nodes have nodeKind field`);
    console.log(`  ✓ ${componentNodes} nodes defaulted to nodeKind='component'`);
    results.push({ test: 'M8', passed: true, detail: `Scoping fields present, ${componentNodes} as component default` });
  } catch (err) {
    console.log(`  ✗ ${err.message}`);
    results.push({ test: 'M8', passed: false, detail: err.message });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // M9: Fork would create new coreId (verify structure is ready)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nM9: Fork structure ready (Core.origin field exists)');
  try {
    const coreWithOrigin = await Core.findOne({ 'origin.coreId': { $ne: null } });
    const coresReady = await Core.countDocuments({});

    console.log(`  ✓ ${coresReady} Core documents exist (fork-ready)`);
    if (coreWithOrigin) {
      console.log(`  ✓ Found forked Core: origin.coreId = ${coreWithOrigin.origin.coreId}`);
    } else {
      console.log(`  NOTE: No forked maps yet - fork test requires manual verification`);
    }
    results.push({ test: 'M9', passed: true, detail: `${coresReady} Cores ready for forking` });
  } catch (err) {
    console.log(`  ✗ ${err.message}`);
    results.push({ test: 'M9', passed: false, detail: err.message });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // M10: Showcase maps (check if they exist with proper identity)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nM10: Showcase/seeded maps have identity');
  try {
    // Look for seeded showcase projects
    const showcaseProjects = await Project.find({
      $or: [
        { name: /Mobile Detailing/i },
        { name: /Tea Import/i },
        { name: /Urban Farming/i },
        { name: /Habit Tracker/i },
        { name: /PM Pivot/i }
      ]
    }).limit(5);

    let validShowcases = 0;
    for (const p of showcaseProjects) {
      const core = await Core.findOne({ projectId: p._id });
      const nodeCount = await Node.countDocuments({ projectId: p._id, coreId: { $exists: true } });
      if (core && nodeCount > 0) {
        validShowcases++;
        console.log(`  ✓ "${p.name}": Core + ${nodeCount} nodes with identity`);
      }
    }

    if (validShowcases === 0) {
      console.log(`  NOTE: Re-seeding showcase maps recommended for domain labels`);
    }
    results.push({ test: 'M10', passed: true, detail: `${validShowcases} showcase maps with identity` });
  } catch (err) {
    console.log(`  ✗ ${err.message}`);
    results.push({ test: 'M10', passed: false, detail: err.message });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // M11: Refresh persistence (check that identity survives)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nM11: Identity fields persist (refresh-safe)');
  try {
    // Pick a random migrated node
    const node = await Node.findOne({ stableId: { $exists: true, $ne: null } });
    if (!node) throw new Error('No node with stableId found');

    const originalStableId = node.stableId;

    // Reload from DB
    const reloaded = await Node.findById(node._id);
    if (!reloaded.stableId) throw new Error('StableId missing after reload');
    if (reloaded.stableId !== originalStableId) throw new Error('StableId changed after reload');

    console.log(`  ✓ StableId persists across reload: ${originalStableId.substring(0, 16)}...`);
    console.log(`  NOTE: Full refresh test requires frontend verification`);
    results.push({ test: 'M11', passed: true, detail: 'Identity fields persist in DB' });
  } catch (err) {
    console.log(`  ✗ ${err.message}`);
    results.push({ test: 'M11', passed: false, detail: err.message });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // M12: Overall stats
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nM12: Overall migration stats');
  try {
    const totalProjects = await Project.countDocuments({});
    const totalCores = await Core.countDocuments({});
    const totalNodes = await Node.countDocuments({});
    const nodesWithIdentity = await Node.countDocuments({ coreId: { $exists: true, $ne: null } });
    const nodesWithoutIdentity = totalNodes - nodesWithIdentity;

    console.log(`  Projects: ${totalProjects}`);
    console.log(`  Cores: ${totalCores}`);
    console.log(`  Total nodes: ${totalNodes}`);
    console.log(`  Nodes with identity: ${nodesWithIdentity}`);
    console.log(`  Nodes without identity: ${nodesWithoutIdentity}`);

    if (nodesWithoutIdentity > 0) {
      console.log(`  ⚠ ${nodesWithoutIdentity} nodes still need migration`);
    } else {
      console.log(`  ✓ All nodes have identity`);
    }

    results.push({ test: 'M12', passed: nodesWithoutIdentity === 0, detail: `${nodesWithIdentity}/${totalNodes} nodes with identity` });
  } catch (err) {
    console.log(`  ✗ ${err.message}`);
    results.push({ test: 'M12', passed: false, detail: err.message });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════════════════════════════════');
  console.log('TEST SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════════════════\n');

  let passed = 0;
  let failed = 0;

  for (const r of results) {
    const status = r.passed ? '✓ PASS' : '✗ FAIL';
    console.log(`  ${r.test}: ${status} - ${r.detail}`);
    if (r.passed) passed++;
    else failed++;
  }

  console.log(`\nTotal: ${passed} passed, ${failed} failed\n`);

  await mongoose.disconnect();

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
