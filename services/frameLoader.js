/**
 * Frame Loader - Loads and resolves premise frames
 *
 * Handles frame selection based on classification, fallback logic,
 * and straddle detection.
 */

const frames = require('../config/premise-frames.json');

const CONFIDENCE_THRESHOLD = 0.6;
const STRADDLE_DELTA = 0.1;

/**
 * Resolves the frame for a given classification result.
 * Returns { frame, meta } where meta includes fallback/straddle flags.
 */
function loadFrame(classification) {
  const { type, confidence, alternates = [] } = classification;

  const meta = {
    selectedType: type,
    confidence,
    usedFallback: false,
    isStraddle: false,
    straddleWith: null
  };

  // Guard 1: Low confidence → fallback to raw W-spine
  if (confidence < CONFIDENCE_THRESHOLD || type === 'unknown') {
    meta.usedFallback = true;
    meta.selectedType = 'fallback';
    return { frame: frames.fallback, meta };
  }

  // Guard 2: Detect straddle (top two within delta)
  if (alternates.length > 0) {
    const topAlt = alternates[0];
    if (confidence - topAlt.confidence <= STRADDLE_DELTA) {
      meta.isStraddle = true;
      meta.straddleWith = topAlt.type;
      // v1: proceed with top pick, but flag it
    }
  }

  // Load the frame
  const frame = frames.frames[type];
  if (!frame) {
    // Unknown type somehow — fallback
    meta.usedFallback = true;
    meta.selectedType = 'fallback';
    return { frame: frames.fallback, meta };
  }

  return { frame, meta };
}

/**
 * Builds the frame input for nebula.
 * Includes frameId for each root so we can match responses back.
 *
 * @param {object} frame - resolved frame
 * @param {string} premise - the premise text
 * @param {'actionable'|'overview'} determination - what the map resolves toward
 */
function buildNebulaFrameInput(frame, premise, determination = 'actionable') {
  return {
    premise,
    frameType: frame.label,
    determination,
    stagesEnabled: frame.stagesEnabled,
    roots: frame.roots.map(r => ({
      frameId: r.key,           // Internal ID for matching - model echoes this back
      label: r.label,           // null means "name from premise"
      covers: r.covers,
      optional: r.optional || false
    }))
  };
}

/**
 * Build lookup maps for frame roots by both key and label.
 * Used by enforceGuards to match nebula response back to frame definition.
 */
function buildFrameLookups(frameRoots) {
  const byFrameId = new Map();
  const byLabel = new Map();
  const optionalIds = new Set();
  const requiredIds = new Set();

  for (const root of frameRoots) {
    byFrameId.set(root.frameId, root);
    if (root.label) {
      byLabel.set(root.label.toLowerCase(), root);
    }
    if (root.optional) {
      optionalIds.add(root.frameId);
    } else {
      requiredIds.add(root.frameId);
    }
  }

  return { byFrameId, byLabel, optionalIds, requiredIds };
}

module.exports = {
  loadFrame,
  buildNebulaFrameInput,
  buildFrameLookups,
  CONFIDENCE_THRESHOLD,
  STRADDLE_DELTA
};
