/**
 * Test script to verify nebula generation produces real content, not filler.
 * Run with: node test-generation.js
 */

require('dotenv').config();

const { generateFramedNebula } = require('./services/blueprintNebula');
const { classifyPremise } = require('./services/blueprintClassify');
const { loadFrame, buildNebulaFrameInput } = require('./services/frameLoader');

// Filler strings that should NEVER appear in generated content
const FILLER_PATTERNS = [
  /depend on your context/i,
  /to be refined based/i,
  /need to be developed/i,
  /this area covers the/i,
  /specifics to be refined/i,
  /aspects of this plan/i,
  /key aspects of/i,
  /awaiting development/i,
  /needs development/i
];

function checkForFiller(text) {
  if (!text) return null;
  for (const pattern of FILLER_PATTERNS) {
    if (pattern.test(text)) {
      return pattern.toString();
    }
  }
  return null;
}

async function testGeneration(premise) {
  console.log('\n' + '='.repeat(60));
  console.log(`TESTING: "${premise}"`);
  console.log('='.repeat(60));

  try {
    // Classify
    console.log('\n[1] Classifying premise...');
    const classification = await classifyPremise(premise);
    console.log(`    Type: ${classification.type} (${classification.confidence})`);

    // Load frame
    const { frame, meta } = loadFrame(classification);
    console.log(`    Frame: ${frame.label}, fallback: ${meta.usedFallback}`);

    // Build input
    const frameInput = buildNebulaFrameInput(frame, premise);

    // Generate
    console.log('\n[2] Generating nebula...');
    const startTime = Date.now();
    const nebula = await generateFramedNebula(frameInput);
    const elapsed = Date.now() - startTime;
    console.log(`    Generated in ${elapsed}ms`);

    // Analyze results
    console.log('\n[3] Analyzing results...');
    let nodeCount = 0;
    let fillerCount = 0;
    let questionCount = 0;
    const fillerNodes = [];

    // Check core
    nodeCount++;
    console.log(`\n--- CORE ---`);
    console.log(`Title: ${nebula.core.title}`);
    console.log(`Statement: ${nebula.core.statement}`);
    console.log(`Detail: ${nebula.core.detail}`);

    // Check roots and stars
    for (const root of nebula.roots) {
      nodeCount++;
      console.log(`\n--- ROOT: ${root.label} ---`);
      console.log(`Title: ${root.title}`);
      console.log(`Statement: ${root.statement}`);
      console.log(`Detail: ${root.detail}`);
      if (root.needsInput) {
        console.log(`[QUESTION STATE]`);
        questionCount++;
      }

      // Check for filler
      let filler = checkForFiller(root.statement) || checkForFiller(root.detail);
      if (filler) {
        fillerCount++;
        fillerNodes.push({ label: root.label, type: 'root', pattern: filler });
        console.log(`[FILLER DETECTED: ${filler}]`);
      }

      // Check stars
      for (const star of (root.stars || [])) {
        nodeCount++;
        console.log(`\n  STAR: ${star.title}`);
        console.log(`  Statement: ${star.statement}`);
        console.log(`  Detail: ${star.detail}`);
        if (star.needsInput) {
          console.log(`  [QUESTION STATE]`);
          questionCount++;
        }

        filler = checkForFiller(star.statement) || checkForFiller(star.detail);
        if (filler) {
          fillerCount++;
          fillerNodes.push({ label: star.title, type: 'star', pattern: filler });
          console.log(`  [FILLER DETECTED: ${filler}]`);
        }
      }
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total nodes: ${nodeCount}`);
    console.log(`Nodes with filler: ${fillerCount}`);
    console.log(`Nodes as questions: ${questionCount}`);
    console.log(`Generation time: ${elapsed}ms`);

    if (fillerCount > 0) {
      console.log('\n[FAIL] Filler detected in:');
      for (const fn of fillerNodes) {
        console.log(`  - ${fn.type}: "${fn.label}" (${fn.pattern})`);
      }
      return false;
    } else {
      console.log('\n[PASS] No filler strings detected!');
      return true;
    }

  } catch (err) {
    console.error('Generation failed:', err.message);
    return false;
  }
}

async function main() {
  const premises = [
    'a flaky test linked to a Redis use-after-free',
    'uh coffee thing in sarasota maybe'
  ];

  let allPassed = true;
  for (const premise of premises) {
    const passed = await testGeneration(premise);
    allPassed = allPassed && passed;
  }

  console.log('\n' + '='.repeat(60));
  console.log(allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED');
  console.log('='.repeat(60));

  process.exit(allPassed ? 0 : 1);
}

main();
