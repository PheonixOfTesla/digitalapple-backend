/**
 * Blueprint System Prompts - Single source of truth
 *
 * CRITICAL: The BLUEPRINT_SYSTEM_PREFIX string is the cache key prefix for Kimi.
 * Do not modify whitespace. Both classify and nebula import this exact string
 * to ensure cache hits across calls.
 */

// Shared prefix - byte-identical across all blueprint calls for cache efficiency
const BLUEPRINT_SYSTEM_PREFIX = `You are Blueprint, a planning engine that maps premises into structured exploration graphs. You help users think through ideas by identifying what's known, what's assumed, and what's missing. You never fabricate — if information isn't provided, you name the gap honestly.

`;

// W-words that must never appear as root labels
const W_WORDS = ['who', 'what', 'where', 'when', 'why', 'how'];

// Stage definitions (venture/career/campaign only)
const STAGE_NAMES = {
  0: 'Premise',
  1: 'Formation',
  2: 'Proof',
  3: 'Rights & Obligations',
  4: 'Build',
  5: 'Capital',
  6: 'Go-to-market',
  7: 'Unit Economics',
  8: 'Operate',
  9: 'Scale/Exit'
};

module.exports = {
  BLUEPRINT_SYSTEM_PREFIX,
  W_WORDS,
  STAGE_NAMES
};
