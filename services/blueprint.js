/**
 * Blueprint - Main entry point for frame-aware map generation
 *
 * Flow:
 * 1. classifyPremise() - determine premise type
 * 2. loadFrame() - get appropriate frame template
 * 3. generateFramedNebula() - generate map with frame context
 * 4. Log orphans/straddles for template improvement
 */

const { classifyPremise } = require('./blueprintClassify');
const { loadFrame, buildNebulaFrameInput } = require('./frameLoader');
const { generateFramedNebula } = require('./blueprintNebula');
const Project = require('../models/Project');
const OrphanLog = require('../models/OrphanLog');

/**
 * Generate a map from a premise using frame-aware classification.
 *
 * @param {string} premise - The user's premise text
 * @param {string} projectId - Project ID to store classification on
 * @returns {object} Generated nebula map
 */
async function generateMap(premise, projectId) {
  // 1. Classify the premise
  const classification = await classifyPremise(premise);
  console.log(`[Blueprint] Classified "${premise.substring(0, 50)}..." as ${classification.type} (${classification.confidence})`);

  // 2. Load the appropriate frame
  const { frame, meta } = loadFrame(classification);
  console.log(`[Blueprint] Using frame: ${frame.label}, fallback: ${meta.usedFallback}, straddle: ${meta.isStraddle}`);

  // 3. Store classification on project
  if (projectId) {
    await Project.findByIdAndUpdate(projectId, {
      'blueprint.classification': classification,
      'blueprint.frameMeta': meta,
      'blueprint.stagesEnabled': frame.stagesEnabled
    });
  }

  // 4. Build nebula input with frame context
  const frameInput = buildNebulaFrameInput(frame, premise);

  // 5. Generate the map
  const map = await generateFramedNebula(frameInput);

  // 6. Log orphans, straddles, and low-confidence for review
  if (meta.usedFallback || meta.isStraddle || classification.confidence < 0.7) {
    await logForReview(premise, classification, meta);
  }

  return map;
}

/**
 * Log premises that need review for template improvement.
 */
async function logForReview(premise, classification, meta) {
  try {
    let reason = 'low-confidence';
    if (meta.usedFallback) reason = 'fallback';
    else if (meta.isStraddle) reason = 'straddle';

    await OrphanLog.create({
      premise,
      classification,
      meta,
      reason,
      timestamp: new Date()
    });

    console.log(`[Blueprint] Logged ${reason} premise for review`);
  } catch (err) {
    // Don't fail generation if logging fails
    console.error('[Blueprint] Failed to log orphan:', err.message);
  }
}

/**
 * Get classification without generating a map.
 * Useful for previewing what type a premise would be classified as.
 */
async function previewClassification(premise) {
  const classification = await classifyPremise(premise);
  const { frame, meta } = loadFrame(classification);

  return {
    classification,
    frame: {
      label: frame.label,
      description: frame.description,
      stagesEnabled: frame.stagesEnabled,
      rootLabels: frame.roots.map(r => r.label).filter(Boolean)
    },
    meta
  };
}

module.exports = {
  generateMap,
  previewClassification
};
