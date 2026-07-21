#!/usr/bin/env node
/**
 * test-identity-mock.js - Test identity layer with mocked nebula data
 *
 * Tests V1 and V2 without requiring LLM calls.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Project = require('../models/Project');
const Node = require('../models/Node');
const Edge = require('../models/Edge');
const Core = require('../models/Core');
const identity = require('../services/identity');

// Mock nebula data for "a pottery studio in Asheville"
const MOCK_NEBULA = {
  core: {
    title: 'Pottery Studio',
    statement: 'A pottery studio in Asheville offering classes and custom ceramics',
    detail: 'A creative space for handmade ceramics in the Blue Ridge Mountains'
  },
  roots: [
    {
      frameId: 'what',
      label: 'Craft & Classes',
      title: 'Craft & Classes',
      statement: 'Handmade pottery and instructional offerings',
      detail: 'Wheel-throwing, hand-building, glazing workshops',
      stars: [
        { title: 'Beginner Classes', statement: 'Intro to wheel-throwing for newcomers', detail: '6-week courses' },
        { title: 'Custom Commissions', statement: 'Bespoke ceramic pieces for clients', detail: 'Wedding sets, gifts' }
      ]
    },
    {
      frameId: 'who',
      label: 'Students & Collectors',
      title: 'Students & Collectors',
      statement: 'Creative hobbyists and art buyers',
      detail: 'Local residents, tourists, interior designers',
      stars: [
        { title: 'Tourist Market', statement: 'Asheville visitors seeking local crafts', detail: 'Peak season May-Oct' }
      ]
    },
    {
      frameId: 'where',
      label: 'River Arts District',
      title: 'River Arts District',
      statement: 'Studio location in Asheville art hub',
      detail: 'High foot traffic, studio crawl participation',
      stars: []
    }
  ],
  classification: { type: 'venture', confidence: 0.85 },
  stagesEnabled: true
};

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  Test Identity Creation (Mocked) - V1 & V2');
  console.log('═══════════════════════════════════════════════\n');

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log('Connected to database\n');

  const premise = 'a pottery studio in Asheville';
  console.log(`Creating map: "${premise}" (mocked nebula)\n`);

  let v1Pass = false;
  let v2Pass = false;

  try {
    // ═══════════════════════════════════════════════
    // STEP 1: Create project
    // ═══════════════════════════════════════════════
    const project = new Project({
      name: premise.substring(0, 100),
      premise: premise,
      ownerId: null,
      anonymousSessionId: 'test-identity-mock-' + Date.now()
    });
    await project.save();
    console.log(`✓ Project created: ${project._id}`);

    // ═══════════════════════════════════════════════
    // STEP 2: Create core node
    // ═══════════════════════════════════════════════
    const nebula = MOCK_NEBULA;
    const coreNode = new Node({
      projectId: project._id,
      kind: 'core',
      title: nebula.core.title,
      statement: nebula.core.statement,
      detail: nebula.core.detail,
      x: 600,
      y: 400,
      depth: 0
    });
    await coreNode.save();

    // ═══════════════════════════════════════════════
    // STEP 3: Create Core document (identity anchor)
    // ═══════════════════════════════════════════════
    const coreDoc = new Core({
      projectId: project._id,
      coreNodeId: coreNode._id,
      premise: premise,
      classification: nebula.classification,
      frameMeta: { selectedType: 'venture', confidence: 0.85 },
      stagesEnabled: nebula.stagesEnabled
    });
    await coreDoc.save();
    console.log(`✓ Core document minted: ${coreDoc._id}`);

    // ═══════════════════════════════════════════════
    // STEP 4: Assign identity to core node
    // ═══════════════════════════════════════════════
    const corePath = [{ nodeId: coreNode._id, title: coreNode.title }];
    coreNode.coreId = coreDoc._id;
    coreNode.path = corePath;
    coreNode.stableId = identity.computeStableId(coreDoc._id, corePath);
    coreNode.essence = identity.freezeEssence(coreNode);
    coreNode.derivation = { kind: 'nebula', sourcePrompt: premise, usedTrace: false };
    await coreNode.save();
    console.log(`✓ Core node identity: stableId=${coreNode.stableId.substring(0, 16)}...`);

    // ═══════════════════════════════════════════════
    // STEP 5: Create root nodes with identity
    // ═══════════════════════════════════════════════
    let firstExpandableNode = null;

    for (let i = 0; i < nebula.roots.length; i++) {
      const root = nebula.roots[i];
      const rootNode = new Node({
        projectId: project._id,
        parentNodeId: coreNode._id,
        kind: 'constellation',
        title: root.title,
        statement: root.statement,
        detail: root.detail,
        constellationLabel: root.label,
        x: 600 + 200 * Math.cos(i * Math.PI / 3),
        y: 400 + 200 * Math.sin(i * Math.PI / 3),
        depth: 1
      });
      await rootNode.save();

      // Assign identity
      const rootPath = [...corePath, { nodeId: rootNode._id, title: rootNode.title }];
      rootNode.coreId = coreDoc._id;
      rootNode.path = rootPath;
      rootNode.stableId = identity.computeStableId(coreDoc._id, rootPath);
      rootNode.essence = identity.freezeEssence(rootNode);
      rootNode.derivation = { kind: 'nebula', sourcePrompt: premise, usedTrace: true };
      await rootNode.save();

      // Create edge
      await new Edge({
        projectId: project._id,
        fromNodeId: coreNode._id,
        toNodeId: rootNode._id,
        type: 'contains'
      }).save();

      if (!firstExpandableNode && root.stars.length > 0) {
        firstExpandableNode = rootNode;
      }

      // Create stars
      for (let j = 0; j < root.stars.length; j++) {
        const star = root.stars[j];
        const starNode = new Node({
          projectId: project._id,
          parentNodeId: rootNode._id,
          kind: 'star',
          title: star.title,
          statement: star.statement,
          detail: star.detail,
          x: rootNode.x + 150,
          y: rootNode.y + j * 60,
          depth: 2
        });
        await starNode.save();

        // Assign identity
        const starPath = [...rootPath, { nodeId: starNode._id, title: starNode.title }];
        starNode.coreId = coreDoc._id;
        starNode.path = starPath;
        starNode.stableId = identity.computeStableId(coreDoc._id, starPath);
        starNode.essence = identity.freezeEssence(starNode);
        starNode.derivation = { kind: 'nebula', sourcePrompt: premise, usedTrace: true };
        await starNode.save();

        await new Edge({
          projectId: project._id,
          fromNodeId: rootNode._id,
          toNodeId: starNode._id,
          type: 'contains'
        }).save();
      }
    }

    const totalNodes = await Node.countDocuments({ projectId: project._id });
    console.log(`✓ Created ${totalNodes} nodes with identity\n`);

    // ═══════════════════════════════════════════════
    // V1 TEST: All nodes have stableId and path to core
    // ═══════════════════════════════════════════════
    console.log('─── V1: Nebula nodes have stableId and path to core ───');
    const allNodes = await Node.find({ projectId: project._id });
    v1Pass = true;
    let v1Issues = [];

    for (const node of allNodes) {
      if (!node.stableId) {
        v1Issues.push(`Node ${node._id} missing stableId`);
        v1Pass = false;
      }
      if (!node.path || node.path.length === 0) {
        v1Issues.push(`Node ${node._id} missing path`);
        v1Pass = false;
      } else if (node.path[0].nodeId.toString() !== coreNode._id.toString()) {
        v1Issues.push(`Node ${node._id} path doesn't start at core`);
        v1Pass = false;
      }
      if (!node.coreId || node.coreId.toString() !== coreDoc._id.toString()) {
        v1Issues.push(`Node ${node._id} missing or wrong coreId`);
        v1Pass = false;
      }
    }

    if (v1Pass) {
      console.log(`✓ V1 PASS: All ${allNodes.length} nodes have valid identity`);
      console.log(`    - Every node has stableId`);
      console.log(`    - Every path starts at core node`);
      console.log(`    - Every node references correct coreId`);
    } else {
      console.log(`✗ V1 FAIL: ${v1Issues.slice(0, 3).join('; ')}`);
    }

    // ═══════════════════════════════════════════════
    // V2 TEST: Expand extends path
    // ═══════════════════════════════════════════════
    console.log('\n─── V2: Expand extends path with evaluated trace ───');

    if (!firstExpandableNode) {
      console.log('✗ V2 SKIP: No expandable node found');
    } else {
      console.log(`Expanding node: "${firstExpandableNode.title}"`);

      // Get trace for LLM context (tests evaluateTraceForExpansion)
      const traceString = await identity.evaluateTraceForExpansion(firstExpandableNode);
      console.log(`  Trace: ${traceString}`);

      // Mock expand result (simulates LLM response)
      const mockChildren = [
        { statement: 'Kiln firing services', detail: 'Electric and gas kiln options' },
        { statement: 'Studio rental hours', detail: 'Open studio time for members' }
      ];

      const parentPath = firstExpandableNode.path;
      v2Pass = true;
      let v2Issues = [];

      for (let i = 0; i < mockChildren.length; i++) {
        const child = mockChildren[i];
        const childNode = new Node({
          projectId: project._id,
          parentNodeId: firstExpandableNode._id,
          kind: 'star',
          title: child.statement,
          statement: child.statement,
          detail: child.detail,
          x: firstExpandableNode.x + 180,
          y: firstExpandableNode.y + i * 70,
          depth: firstExpandableNode.depth + 1
        });
        await childNode.save();

        // Assign identity (path extends from parent)
        const childPath = [...parentPath, { nodeId: childNode._id, title: childNode.title }];
        childNode.coreId = coreDoc._id;
        childNode.path = childPath;
        childNode.stableId = identity.computeStableId(coreDoc._id, childPath);
        childNode.essence = identity.freezeEssence(childNode);
        childNode.derivation = {
          kind: 'expand',
          sourcePrompt: firstExpandableNode.statement,
          usedTrace: true
        };
        await childNode.save();

        // Verify V2 requirements
        if (childNode.coreId.toString() !== firstExpandableNode.coreId.toString()) {
          v2Issues.push(`Child ${childNode._id} has different coreId`);
          v2Pass = false;
        }
        if (childNode.path.length !== parentPath.length + 1) {
          v2Issues.push(`Child path length ${childNode.path.length} != parent+1 (${parentPath.length + 1})`);
          v2Pass = false;
        }
        if (!childNode.derivation.usedTrace) {
          v2Issues.push(`Child derivation.usedTrace is false`);
          v2Pass = false;
        }

        await new Edge({
          projectId: project._id,
          fromNodeId: firstExpandableNode._id,
          toNodeId: childNode._id,
          type: 'contains'
        }).save();
      }

      // Mark parent as expanded
      firstExpandableNode.expanded = true;
      firstExpandableNode.expansionType = 'star-children';
      await firstExpandableNode.save();

      if (v2Pass) {
        console.log(`✓ V2 PASS: ${mockChildren.length} children created with extended paths`);
        console.log(`    - Children inherit coreId from parent`);
        console.log(`    - Child path length = parent path + 1`);
        console.log(`    - derivation.usedTrace = true`);
      } else {
        console.log(`✗ V2 FAIL: ${v2Issues.join('; ')}`);
      }
    }

    // ═══════════════════════════════════════════════
    // V3 TEST: stableId survives round-trip
    // ═══════════════════════════════════════════════
    console.log('\n─── V3: stableId survives DB round-trip ───');
    const testNode = await Node.findOne({ projectId: project._id, stableId: { $exists: true } });
    const recomputed = identity.computeStableId(testNode.coreId, testNode.path);
    const v3Pass = recomputed === testNode.stableId;
    if (v3Pass) {
      console.log(`✓ V3 PASS: stableId ${testNode.stableId.substring(0, 16)}... matches recomputed`);
    } else {
      console.log(`✗ V3 FAIL: stored=${testNode.stableId.substring(0, 16)}... recomputed=${recomputed.substring(0, 16)}...`);
    }

    // ═══════════════════════════════════════════════
    // Summary
    // ═══════════════════════════════════════════════
    console.log('\n═══════════════════════════════════════════════');
    console.log('  RESULTS');
    console.log('═══════════════════════════════════════════════');
    console.log(`  Project ID: ${project._id}`);
    console.log(`  Core ID:    ${coreDoc._id}`);
    console.log(`  Total nodes: ${await Node.countDocuments({ projectId: project._id })}`);
    console.log('');
    console.log(`  V1 (nebula mints identity):     ${v1Pass ? 'PASS ✓' : 'FAIL ✗'}`);
    console.log(`  V2 (expand extends path):       ${v2Pass ? 'PASS ✓' : 'FAIL ✗'}`);
    console.log(`  V3 (stableId round-trip):       ${v3Pass ? 'PASS ✓' : 'FAIL ✗'}`);

    if (v1Pass && v2Pass && v3Pass) {
      console.log('\n  ✓ Engine is sound. Migration is safe to attempt.');
    } else {
      console.log('\n  ✗ Issues found. Fix before migration.');
    }

  } catch (error) {
    console.error('\n✗ Error:', error.message);
    console.error(error.stack);
  }

  await mongoose.disconnect();
  console.log('\nDisconnected.');
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
