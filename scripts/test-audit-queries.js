#!/usr/bin/env node
/**
 * Audit Test Script
 *
 * Runs the 4 tests from the engine audit:
 * 1. Generate "a specialty coffee roaster in Sarasota" - full node output
 * 2. Generate "how to get my drivers license" - full node output
 * 3. Count filler strings in production nodes
 * 4. Count terminal nodes and maps with zero terminals
 */

require('dotenv').config();
const mongoose = require('mongoose');

// Force sequential generation with longer timeouts
process.env.NEBULA_PARALLEL_LIMIT = '1';  // One content call at a time
process.env.NEBULA_CONTENT_TIMEOUT = '120000';  // 2 minute timeout

const { generateFramedNebula } = require('../services/blueprintNebula');
const { classifyPremise } = require('../services/blueprintClassify');
const { loadFrame, buildNebulaFrameInput } = require('../services/frameLoader');

// Models for DB queries
const SharedMap = require('../models/SharedMap');
const Node = require('../models/Node');

// Filler patterns to search
const FILLER_PATTERNS = [
  'key aspects of',
  'this area covers the',
  'depend on your context',
  'to be refined based on',
  'aspects need to be developed',
  'specifics depend on',
  'needs development',
  'awaiting development'
];

// Sleep helper
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Generate with retry and backoff
async function generateWithRetry(premise, maxRetries = 5) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`GENERATING: "${premise}"`);
  console.log(`${'='.repeat(70)}\n`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Attempt ${attempt}/${maxRetries}]`);

      // Classify
      console.log('[1] Classifying premise...');
      const classification = await classifyPremise(premise);
      console.log(`    Type: ${classification.type} (confidence: ${classification.confidence})`);

      // Load frame
      const { frame, meta } = loadFrame(classification);
      console.log(`    Frame: ${frame.label}, fallback: ${meta.usedFallback}`);

      // Build input
      const frameInput = buildNebulaFrameInput(frame, premise);

      // Generate with extended timeout
      console.log('[2] Generating nebula (this may take a while with rate limits)...');
      const startTime = Date.now();
      const nebula = await generateFramedNebula(frameInput, 3);  // 3 retries per step
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`    Generated in ${elapsed}s`);

      // Check if we got real content or fallback
      const hasRealContent = nebula.roots?.some(r =>
        r.statement && !r.statement.includes('What can you tell me about')
      );

      if (!hasRealContent && attempt < maxRetries) {
        console.log(`    Got fallback content, retrying after backoff...`);
        await sleep(10000 * attempt);  // 10s, 20s, 30s...
        continue;
      }

      return { nebula, classification, frame };

    } catch (err) {
      console.log(`    Error: ${err.message}`);
      if (err.message.includes('429') && attempt < maxRetries) {
        const backoff = 15000 * attempt;
        console.log(`    Rate limited, waiting ${backoff/1000}s before retry...`);
        await sleep(backoff);
      } else if (attempt >= maxRetries) {
        throw err;
      }
    }
  }
}

// Print all nodes verbatim
function printNodesVerbatim(nebula) {
  console.log('\n--- VERBATIM NODE OUTPUT ---\n');

  // Core
  console.log('╔════════════════════════════════════════════════════════════════════╗');
  console.log('║ CORE                                                               ║');
  console.log('╚════════════════════════════════════════════════════════════════════╝');
  console.log(`Title: ${nebula.core.title}`);
  console.log(`Statement: ${nebula.core.statement}`);
  console.log(`Detail: ${nebula.core.detail}`);
  console.log('');

  // Roots and stars
  for (const root of (nebula.roots || [])) {
    console.log('┌────────────────────────────────────────────────────────────────────┐');
    console.log(`│ ROOT: ${root.label || root.frameId}`.padEnd(69) + '│');
    console.log('└────────────────────────────────────────────────────────────────────┘');
    console.log(`Title: ${root.title}`);
    console.log(`Statement: ${root.statement}`);
    console.log(`Detail: ${root.detail}`);
    if (root.needsInput) {
      console.log(`[QUESTION STATE - needsInput: true]`);
    }
    console.log('');

    for (const star of (root.stars || [])) {
      console.log(`  ┌── STAR: ${star.title} ──┐`);
      console.log(`  Statement: ${star.statement}`);
      console.log(`  Detail: ${star.detail}`);
      if (star.needsInput) {
        console.log(`  [QUESTION STATE - needsInput: true]`);
      }
      console.log('');
    }
  }
}

// Test 3: Count filler in production
async function countFillerNodes() {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 3: FILLER STRING COUNT IN PRODUCTION');
  console.log('='.repeat(70) + '\n');

  // Build regex for all filler patterns
  const fillerRegex = new RegExp(FILLER_PATTERNS.join('|'), 'i');

  // Query nodes with filler in statement or detail
  const fillerNodes = await Node.find({
    $or: [
      { statement: fillerRegex },
      { detail: fillerRegex }
    ]
  }).limit(100).lean();

  console.log(`Total nodes with filler strings: ${fillerNodes.length}`);

  // Get 3 examples with their project info
  if (fillerNodes.length > 0) {
    console.log('\nExamples:');
    const examples = fillerNodes.slice(0, 3);
    for (const node of examples) {
      // Try to find the map this belongs to
      const map = await SharedMap.findOne({ projectId: node.projectId }).select('title').lean();
      const mapName = map?.title || 'Unknown map';
      console.log(`\n  Map: "${mapName}"`);
      console.log(`  Node title: "${node.title || node.label}"`);
      console.log(`  Statement: "${(node.statement || '').substring(0, 100)}..."`);
      console.log(`  Detail: "${(node.detail || '').substring(0, 100)}..."`);
    }
  }

  // Also check SharedMap snapshots
  console.log('\n--- Checking SharedMap snapshots ---');
  const allMaps = await SharedMap.find({ visibility: 'public' }).lean();
  let snapshotFillerCount = 0;
  const snapshotExamples = [];

  for (const map of allMaps) {
    const nodes = map.snapshot?.nodes || [];
    for (const node of nodes) {
      const hasFillerStatement = node.statement && fillerRegex.test(node.statement);
      const hasFillerDetail = node.detail && fillerRegex.test(node.detail);
      if (hasFillerStatement || hasFillerDetail) {
        snapshotFillerCount++;
        if (snapshotExamples.length < 3) {
          snapshotExamples.push({ map: map.title, node });
        }
      }
    }
  }

  console.log(`Filler nodes in SharedMap snapshots: ${snapshotFillerCount}`);
  for (const ex of snapshotExamples) {
    console.log(`\n  Map: "${ex.map}"`);
    console.log(`  Node: "${ex.node.title || ex.node.label}"`);
    console.log(`  Statement: "${(ex.node.statement || '').substring(0, 100)}..."`);
  }

  return fillerNodes.length + snapshotFillerCount;
}

// Test 4: Count terminal nodes
async function countTerminalNodes() {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 4: TERMINAL NODE COUNT');
  console.log('='.repeat(70) + '\n');

  // Count in Node collection
  const terminalCount = await Node.countDocuments({ terminal: true });
  console.log(`Total terminal nodes in Node collection: ${terminalCount}`);

  // Count in SharedMap snapshots
  const allMaps = await SharedMap.find({ visibility: 'public' }).lean();
  let totalSnapshotTerminals = 0;
  let mapsWithZeroTerminals = 0;

  console.log(`\nAnalyzing ${allMaps.length} public maps:`);

  for (const map of allMaps) {
    const nodes = map.snapshot?.nodes || [];
    const coreNode = map.snapshot?.core;
    const allNodes = coreNode ? [coreNode, ...nodes] : nodes;

    const terminalInMap = allNodes.filter(n => n.terminal === true).length;
    totalSnapshotTerminals += terminalInMap;

    if (terminalInMap === 0) {
      mapsWithZeroTerminals++;
    }

    console.log(`  "${map.title.substring(0, 50)}..." - ${terminalInMap} terminal nodes`);
  }

  console.log(`\n--- SUMMARY ---`);
  console.log(`Total terminal nodes in snapshots: ${totalSnapshotTerminals}`);
  console.log(`Maps with ZERO terminal nodes: ${mapsWithZeroTerminals}/${allMaps.length}`);

  return { terminalCount, totalSnapshotTerminals, mapsWithZeroTerminals, totalMaps: allMaps.length };
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║           ENGINE AUDIT - EXECUTION TESTS                             ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

  // Connect to MongoDB
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB\n');

  // Test 1: Coffee roaster
  try {
    const result1 = await generateWithRetry('a specialty coffee roaster in Sarasota');
    printNodesVerbatim(result1.nebula);
  } catch (err) {
    console.error('TEST 1 FAILED:', err.message);
  }

  // Wait between tests
  console.log('\n[Waiting 30s between tests to avoid rate limits...]\n');
  await sleep(30000);

  // Test 2: Drivers license
  try {
    const result2 = await generateWithRetry('how to get my drivers license');
    printNodesVerbatim(result2.nebula);
  } catch (err) {
    console.error('TEST 2 FAILED:', err.message);
  }

  // Test 3: Filler count
  try {
    await countFillerNodes();
  } catch (err) {
    console.error('TEST 3 FAILED:', err.message);
  }

  // Test 4: Terminal count
  try {
    await countTerminalNodes();
  } catch (err) {
    console.error('TEST 4 FAILED:', err.message);
  }

  await mongoose.disconnect();
  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
