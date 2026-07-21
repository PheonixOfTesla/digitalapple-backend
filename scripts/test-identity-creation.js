#!/usr/bin/env node
/**
 * test-identity-creation.js - Create a test map and expand a node
 *
 * Tests V1 and V2 by exercising the live creation paths.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Project = require('../models/Project');
const Node = require('../models/Node');
const Edge = require('../models/Edge');
const Core = require('../models/Core');
const identity = require('../services/identity');

// Lazy load services
let BlueprintService = null;
let BlueprintLLM = null;

function getBlueprint() {
  if (!BlueprintService) {
    BlueprintService = require('../services/blueprint');
  }
  return BlueprintService;
}

function getLLM() {
  if (!BlueprintLLM) {
    BlueprintLLM = require('../services/BlueprintLLM');
  }
  return BlueprintLLM;
}

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  Test Identity Creation - V1 & V2');
  console.log('═══════════════════════════════════════════════\n');

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log('Connected to database\n');

  const premise = 'a pottery studio in Asheville';
  console.log(`Creating map: "${premise}"\n`);

  try {
    // ═══════════════════════════════════════════════
    // STEP 1: Create project
    // ═══════════════════════════════════════════════
    const project = new Project({
      name: premise.substring(0, 100),
      premise: premise,
      ownerId: null,
      anonymousSessionId: 'test-identity-' + Date.now()
    });
    await project.save();
    console.log(`✓ Project created: ${project._id}`);

    // ═══════════════════════════════════════════════
    // STEP 2: Generate nebula via blueprint service
    // ═══════════════════════════════════════════════
    const blueprint = getBlueprint();
    const nebula = await blueprint.generateMap(premise, project._id);
    console.log(`✓ Nebula generated: ${nebula.roots?.length || 0} roots`);

    // ═══════════════════════════════════════════════
    // STEP 3: Create core node
    // ═══════════════════════════════════════════════
    const coreNodeData = {
      projectId: project._id,
      kind: 'core',
      title: nebula.core?.title || premise.substring(0, 40),
      statement: nebula.core?.statement || premise,
      detail: nebula.core?.detail,
      x: 600,
      y: 400,
      depth: 0
    };
    const coreNode = new Node(coreNodeData);
    await coreNode.save();

    // ═══════════════════════════════════════════════
    // STEP 4: Create Core document (identity anchor)
    // ═══════════════════════════════════════════════
    const coreDoc = new Core({
      projectId: project._id,
      coreNodeId: coreNode._id,
      premise: premise,
      classification: nebula.classification || {
        type: 'venture',
        confidence: 0.8,
        alternates: [],
        reasoning: 'Test map'
      },
      frameMeta: nebula.frameMeta || {},
      stagesEnabled: nebula.stagesEnabled
    });
    await coreDoc.save();
    console.log(`✓ Core document minted: ${coreDoc._id}`);

    // ═══════════════════════════════════════════════
    // STEP 5: Assign identity to core node
    // ═══════════════════════════════════════════════
    const corePath = [{ nodeId: coreNode._id, title: coreNode.title }];
    coreNode.coreId = coreDoc._id;
    coreNode.path = corePath;
    coreNode.stableId = identity.computeStableId(coreDoc._id, corePath);
    coreNode.essence = identity.freezeEssence(coreNode);
    coreNode.derivation = {
      kind: 'nebula',
      sourcePrompt: premise,
      usedTrace: false
    };
    await coreNode.save();
    console.log(`✓ Core node identity assigned: stableId=${coreNode.stableId.substring(0, 16)}...`);

    // ═══════════════════════════════════════════════
    // STEP 6: Create root nodes with identity
    // ═══════════════════════════════════════════════
    const roots = nebula.roots || [];
    let firstExpandableNode = null;

    for (let i = 0; i < roots.length; i++) {
      const root = roots[i];
      const rootNode = new Node({
        projectId: project._id,
        parentNodeId: coreNode._id,
        kind: 'constellation',
        title: root.title || root.label,
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
      const edge = new Edge({
        projectId: project._id,
        fromNodeId: coreNode._id,
        toNodeId: rootNode._id,
        type: 'contains'
      });
      await edge.save();

      if (!firstExpandableNode) {
        firstExpandableNode = rootNode;
      }

      // Create stars under this root
      const stars = root.stars || [];
      for (let j = 0; j < stars.length; j++) {
        const star = stars[j];
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

        // Create edge
        const starEdge = new Edge({
          projectId: project._id,
          fromNodeId: rootNode._id,
          toNodeId: starNode._id,
          type: 'contains'
        });
        await starEdge.save();
      }
    }

    const totalNodes = await Node.countDocuments({ projectId: project._id });
    console.log(`✓ Created ${totalNodes} nodes with identity\n`);

    // ═══════════════════════════════════════════════
    // V1 TEST: All nodes have stableId and path to core
    // ═══════════════════════════════════════════════
    console.log('─── V1: Nebula nodes have stableId and path to core ───');
    const allNodes = await Node.find({ projectId: project._id });
    let v1Pass = true;
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
    } else {
      console.log(`✗ V1 FAIL: ${v1Issues.slice(0, 3).join('; ')}`);
    }

    // ═══════════════════════════════════════════════
    // STEP 7: Expand a node (V2 test)
    // ═══════════════════════════════════════════════
    console.log('\n─── V2: Expand extends path with evaluated trace ───');

    if (!firstExpandableNode) {
      console.log('✗ V2 SKIP: No expandable node found');
    } else {
      console.log(`Expanding node: "${firstExpandableNode.title}"`);

      // Get trace for LLM context
      const traceString = await identity.evaluateTraceForExpansion(firstExpandableNode);
      console.log(`  Trace: ${traceString.substring(0, 60)}...`);

      // Expand using LLM
      const llm = getLLM();
      const contextNodes = await Node.find({ projectId: project._id }).limit(10).lean();

      const expandResult = await llm.expandStar(
        {
          id: firstExpandableNode._id.toString(),
          statement: firstExpandableNode.statement || firstExpandableNode.title,
          stage: firstExpandableNode.stage
        },
        contextNodes.map(n => ({
          id: n._id.toString(),
          statement: n.statement || n.title,
          stage: n.stage,
          parentNodeId: n.parentNodeId?.toString()
        })),
        1,
        null,
        traceString
      );

      const children = expandResult.children || [];
      console.log(`  LLM returned ${children.length} children`);

      // Create child nodes with identity
      const parentPath = firstExpandableNode.path;
      let v2Pass = true;
      let v2Issues = [];

      for (let i = 0; i < children.length; i++) {
        const child = children[i];
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
          sourcePrompt: firstExpandableNode.statement || firstExpandableNode.title,
          usedTrace: true
        };
        await childNode.save();

        // Verify V2 requirements
        if (childNode.coreId.toString() !== firstExpandableNode.coreId.toString()) {
          v2Issues.push(`Child ${childNode._id} has different coreId`);
          v2Pass = false;
        }
        if (childNode.path.length !== parentPath.length + 1) {
          v2Issues.push(`Child ${childNode._id} path length wrong`);
          v2Pass = false;
        }
        if (!childNode.derivation.usedTrace) {
          v2Issues.push(`Child ${childNode._id} derivation.usedTrace is false`);
          v2Pass = false;
        }

        // Create edge
        const edge = new Edge({
          projectId: project._id,
          fromNodeId: firstExpandableNode._id,
          toNodeId: childNode._id,
          type: 'contains'
        });
        await edge.save();
      }

      // Mark parent as expanded
      firstExpandableNode.expanded = true;
      firstExpandableNode.expansionType = 'star-children';
      await firstExpandableNode.save();

      if (v2Pass && children.length > 0) {
        console.log(`✓ V2 PASS: ${children.length} children inherit coreId, paths extended, usedTrace=true`);
      } else if (children.length === 0) {
        console.log(`✗ V2 FAIL: LLM returned no children`);
      } else {
        console.log(`✗ V2 FAIL: ${v2Issues.slice(0, 3).join('; ')}`);
      }
    }

    // ═══════════════════════════════════════════════
    // Summary
    // ═══════════════════════════════════════════════
    console.log('\n═══════════════════════════════════════════════');
    console.log('  SUMMARY');
    console.log('═══════════════════════════════════════════════');
    console.log(`  Project ID: ${project._id}`);
    console.log(`  Core ID:    ${coreDoc._id}`);
    console.log(`  Total nodes: ${await Node.countDocuments({ projectId: project._id })}`);
    console.log(`  V1: ${v1Pass ? 'PASS ✓' : 'FAIL ✗'}`);
    console.log(`  V2: ${firstExpandableNode ? 'PASS ✓' : 'SKIP'}`);

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
