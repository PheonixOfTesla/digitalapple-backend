/**
 * Scoping Service Tests
 *
 * Tests for decision node classification and path generation.
 *
 * Unit tests (T1-T5): Pure functions, no DB
 * Integration tests (T6-T15): Require MongoDB and API
 */

const assert = require('assert');

// Import pure functions from scoping service
const {
  classifyNodeKind,
  rankPaths,
  blendScore,
  generateRecommendation,
  validatePaths
} = require('../services/scoping');

// ═══════════════════════════════════════════════════════════════════════════
// UNIT TESTS - PURE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n═══════════════════════════════════════════════════════════════════════════');
console.log('UNIT TESTS - Pure Functions');
console.log('═══════════════════════════════════════════════════════════════════════════\n');

// T1: Classification tests
console.log('T1: classifyNodeKind - decision vs component classification');

const t1Tests = [
  // Should be DECISION
  { title: 'How you reach customers', expected: 'decision', reason: 'starts with "how"' },
  { title: 'Revenue model', expected: 'decision', reason: 'ends with "model"' },
  { title: 'Direct vs wholesale', expected: 'decision', reason: 'contains "vs"' },
  { title: 'Which channel to use', expected: 'decision', reason: 'starts with "which"' },
  { title: 'Pricing strategy', expected: 'decision', reason: 'ends with "strategy"' },

  // Should be COMPONENT
  { title: 'Customer segments', expected: 'component', reason: 'ends with "segments"' },
  { title: 'The Product', expected: 'component', reason: 'starts with "the"' },
  { title: 'Team', expected: 'component', reason: 'ends with "team"' },
  { title: 'Infrastructure', expected: 'component', reason: 'ends with "infrastructure"' },
  { title: 'Customers', expected: 'component', reason: 'is "customers"' },

  // Ambiguous should default to COMPONENT
  { title: 'Something ambiguous', expected: 'component', reason: 'ambiguous defaults to component' },
  { title: '', expected: 'component', reason: 'empty defaults to component' }
];

let t1Pass = 0;
let t1Fail = 0;

for (const test of t1Tests) {
  const result = classifyNodeKind({ title: test.title, statement: '' });
  const pass = result.kind === test.expected;

  if (pass) {
    t1Pass++;
    console.log(`  ✓ "${test.title}" → ${result.kind} (${test.reason})`);
  } else {
    t1Fail++;
    console.log(`  ✗ "${test.title}" → expected ${test.expected}, got ${result.kind}`);
  }
}

console.log(`\nT1 Result: ${t1Pass} passed, ${t1Fail} failed`);

// T2: Path ranking tests
console.log('\n─────────────────────────────────────────────────────────────────────────────');
console.log('T2: rankPaths - ranking by blended score');

const t2Paths = [
  {
    label: 'Low scorer',
    scores: {
      economy: { value: 3, reason: 'Low margin' },
      orchestration: { value: 4, reason: 'Complex' },
      demand: { value: 2, reason: 'Niche market' }
    }
  },
  {
    label: 'High scorer',
    scores: {
      economy: { value: 8, reason: 'High margin' },
      orchestration: { value: 7, reason: 'Simple' },
      demand: { value: 9, reason: 'Strong pull' }
    }
  },
  {
    label: 'Medium scorer',
    scores: {
      economy: { value: 5, reason: 'Average margin' },
      orchestration: { value: 6, reason: 'Moderate' },
      demand: { value: 5, reason: 'Okay demand' }
    }
  }
];

const ranked = rankPaths(t2Paths);
const t2Pass = ranked[0].label === 'High scorer' &&
               ranked[1].label === 'Medium scorer' &&
               ranked[2].label === 'Low scorer';

if (t2Pass) {
  console.log('  ✓ Paths ranked correctly: High > Medium > Low');
} else {
  console.log('  ✗ Paths not ranked correctly');
  console.log('    Order:', ranked.map(p => p.label).join(' > '));
}

// Test recommendation cites scores
const recommendation = generateRecommendation(ranked);
const t2RecPass = recommendation.pathLabel === 'High scorer' &&
                  recommendation.reasoning.includes('demand') &&
                  recommendation.reasoning.includes('9/10');

if (t2RecPass) {
  console.log('  ✓ Recommendation picks highest scorer and cites scores');
  console.log(`    Reasoning: ${recommendation.reasoning}`);
} else {
  console.log('  ✗ Recommendation issue');
  console.log(`    Label: ${recommendation.pathLabel}`);
  console.log(`    Reasoning: ${recommendation.reasoning}`);
}

console.log(`\nT2 Result: ${t2Pass && t2RecPass ? 'PASS' : 'FAIL'}`);

// T3: Honesty test (can't test LLM behavior directly, but test single-path handling)
console.log('\n─────────────────────────────────────────────────────────────────────────────');
console.log('T3: Single path handling (honesty)');

const singlePathRecommendation = generateRecommendation([{
  label: 'Only option',
  scores: {
    economy: { value: 7, reason: 'Good' },
    orchestration: { value: 6, reason: 'Okay' },
    demand: { value: 5, reason: 'Market exists' }
  }
}]);

const t3Pass = singlePathRecommendation.pathLabel === 'Only option';
if (t3Pass) {
  console.log('  ✓ Single path correctly identified as recommendation');
} else {
  console.log('  ✗ Single path handling failed');
}

console.log(`\nT3 Result: ${t3Pass ? 'PASS' : 'FAIL'}`);

// T4: Validation - score missing reason
console.log('\n─────────────────────────────────────────────────────────────────────────────');
console.log('T4: validatePaths - reject scores missing reasons');

const t4PathsInvalid = [{
  label: 'Missing reason',
  summary: 'Has a summary',
  scores: {
    economy: { value: 5, reason: '' }, // Empty reason
    orchestration: { value: 5, reason: 'Has reason' },
    demand: { value: 5, reason: 'Has reason' }
  }
}];

const t4Result = validatePaths(t4PathsInvalid);
const t4Pass = !t4Result.valid && t4Result.errors.some(e => e.includes('economy') && e.includes('reason'));

if (t4Pass) {
  console.log('  ✓ Path with missing score reason correctly rejected');
  console.log(`    Errors: ${t4Result.errors.join(', ')}`);
} else {
  console.log('  ✗ Validation did not catch missing reason');
  console.log(`    Valid: ${t4Result.valid}, Errors: ${t4Result.errors.join(', ')}`);
}

// Test valid paths pass
const t4PathsValid = [{
  label: 'Valid path',
  summary: 'Has summary',
  scores: {
    economy: { value: 5, reason: 'Good margin' },
    orchestration: { value: 5, reason: 'Manageable' },
    demand: { value: 5, reason: 'Market exists' }
  }
}];

const t4ValidResult = validatePaths(t4PathsValid);
const t4ValidPass = t4ValidResult.valid;

if (t4ValidPass) {
  console.log('  ✓ Valid paths pass validation');
} else {
  console.log('  ✗ Valid paths incorrectly rejected');
}

console.log(`\nT4 Result: ${t4Pass && t4ValidPass ? 'PASS' : 'FAIL'}`);

// T5: Truncation to top 4 by confidence (simulated - actual truncation happens in scopeDecisionNode)
console.log('\n─────────────────────────────────────────────────────────────────────────────');
console.log('T5: Path truncation simulation');

// This tests the ranking logic used for truncation
const t5Paths = [
  { label: 'Path 1', confidence: { value: 0.9 }, scores: { economy: { value: 5 }, orchestration: { value: 5 }, demand: { value: 5 } } },
  { label: 'Path 2', confidence: { value: 0.7 }, scores: { economy: { value: 5 }, orchestration: { value: 5 }, demand: { value: 5 } } },
  { label: 'Path 3', confidence: { value: 0.5 }, scores: { economy: { value: 5 }, orchestration: { value: 5 }, demand: { value: 5 } } },
  { label: 'Path 4', confidence: { value: 0.8 }, scores: { economy: { value: 5 }, orchestration: { value: 5 }, demand: { value: 5 } } },
  { label: 'Path 5', confidence: { value: 0.6 }, scores: { economy: { value: 5 }, orchestration: { value: 5 }, demand: { value: 5 } } }
];

// Sort by confidence and take top 4
const sortedByConf = [...t5Paths].sort((a, b) => (b.confidence?.value || 0) - (a.confidence?.value || 0));
const truncated = sortedByConf.slice(0, 4);

const t5Pass = truncated.length === 4 &&
               truncated[0].label === 'Path 1' &&
               truncated[1].label === 'Path 4' &&
               truncated[2].label === 'Path 2' &&
               truncated[3].label === 'Path 5';

if (t5Pass) {
  console.log('  ✓ Paths correctly sorted by confidence and truncated to 4');
  console.log(`    Top 4: ${truncated.map(p => `${p.label}(${p.confidence.value})`).join(', ')}`);
} else {
  console.log('  ✗ Truncation order incorrect');
  console.log(`    Got: ${truncated.map(p => `${p.label}(${p.confidence.value})`).join(', ')}`);
}

console.log(`\nT5 Result: ${t5Pass ? 'PASS' : 'FAIL'}`);

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n═══════════════════════════════════════════════════════════════════════════');
console.log('UNIT TEST SUMMARY');
console.log('═══════════════════════════════════════════════════════════════════════════');

const allUnitTests = [
  { id: 'T1', name: 'Classification', passed: t1Fail === 0 },
  { id: 'T2', name: 'Ranking + Recommendation', passed: t2Pass && t2RecPass },
  { id: 'T3', name: 'Single path handling', passed: t3Pass },
  { id: 'T4', name: 'Validation (missing reasons)', passed: t4Pass && t4ValidPass },
  { id: 'T5', name: 'Truncation to 4', passed: t5Pass }
];

let passCount = 0;
let failCount = 0;

for (const test of allUnitTests) {
  if (test.passed) {
    passCount++;
    console.log(`  ${test.id}: ${test.name} - PASS`);
  } else {
    failCount++;
    console.log(`  ${test.id}: ${test.name} - FAIL`);
  }
}

console.log(`\nTotal: ${passCount} passed, ${failCount} failed`);

if (failCount === 0) {
  console.log('\n✓ All unit tests passed!\n');
  process.exit(0);
} else {
  console.log('\n✗ Some tests failed.\n');
  process.exit(1);
}
