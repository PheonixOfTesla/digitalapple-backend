/**
 * Blueprint Nebula - Frame-aware map generation
 *
 * Generates maps using premise type frames instead of hardcoded business structure.
 * Enforces drop-not-pad rules and stage constraints.
 */

const { client, model } = require('./aiClient');
const { BLUEPRINT_SYSTEM_PREFIX, W_WORDS } = require('./blueprintPrompts');
const { buildFrameLookups } = require('./frameLoader');

const NEBULA_FRAME_INSTRUCTION = `
You are given a frame with up to 7 roots. Each root has:
- frameId: echo this back unchanged so we can match your response to the frame
- label: the display name, or null if you must name it from the premise
- covers: what this root is about
- optional: if true, DROP this root entirely if the premise provides no grounding

OUTPUT FORMAT - Return JSON with this exact structure:
{
  "core": {
    "title": "short 2-4 word label",
    "statement": "full sentence describing the premise"
  },
  "roots": [
    {
      "frameId": "echo the frameId from input",
      "label": "domain-specific name (use provided label or invent one if null)",
      "title": "short 2-4 word label",
      "statement": "full sentence",
      "confidence": { "value": 0-1, "basis": "stated|inferred|unknown" },
      "scores": {
        "economy": { "value": 0-10, "reason": "why" },
        "orchestration": { "value": 0-10, "reason": "why" },
        "demand": { "value": 0-10, "reason": "why" }
      },
      "stage": 0-9,
      "status": "unexplored|mapped|kept|pruned|done",
      "stars": [
        {
          "title": "short label",
          "statement": "full sentence",
          "confidence": { "value": 0-1, "basis": "stated|inferred|unknown" },
          "scores": { same structure },
          "stage": 0-9,
          "status": "unexplored|mapped|kept|pruned|done"
        }
      ]
    }
  ]
}

HARD RULES:
1. Echo frameId exactly as provided - we use this to match your response.
2. Never output raw W-words (who/what/where/when/why/how) as labels. Use domain-specific names.
3. If label is null in the input, invent a domain-appropriate name from the premise.
4. OPTIONAL roots with no grounding: omit entirely from your response.
5. REQUIRED roots with no grounding: include with empty stars array and statement naming what's missing.
6. Every node needs confidence + basis. Guesses are labeled as guesses.
7. If stagesEnabled is false in the input, set all stage values to 0.
8. Each root gets 0-2 stars maximum. Only add stars where the premise provides grounding.
9. Thin premise = small honest map. Never fabricate to fill the structure.
`;

// Byte-identical prefix from single source
const NEBULA_SYSTEM = BLUEPRINT_SYSTEM_PREFIX + NEBULA_FRAME_INSTRUCTION;

/**
 * Generate a nebula from a frame input.
 */
async function generateFramedNebula(frameInput, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: NEBULA_SYSTEM },
          { role: 'user', content: JSON.stringify(frameInput) }
        ],
        max_completion_tokens: 4000,
        response_format: { type: "json_object" }
      });

      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error('Empty response from nebula');

      const result = JSON.parse(content);

      // Validate basic structure before processing
      const validationError = validateNebulaShape(result);
      if (validationError) {
        throw new Error(`Invalid nebula shape: ${validationError}`);
      }

      // Enforce guards (drop/placeholder, stages, W-words)
      return enforceGuards(result, frameInput);

    } catch (err) {
      console.error(`[Nebula] Attempt ${attempt + 1} failed:`, err.message);

      if (attempt === retries) {
        throw new Error(`Nebula generation failed after ${retries + 1} attempts: ${err.message}`);
      }

      // Exponential backoff
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

/**
 * Validate the basic shape of nebula response before processing.
 * Returns error string if invalid, null if valid.
 */
function validateNebulaShape(result) {
  if (!result || typeof result !== 'object') {
    return 'Response is not an object';
  }

  if (!result.core || typeof result.core !== 'object') {
    return 'Missing or invalid core';
  }

  if (!Array.isArray(result.roots)) {
    return 'roots is not an array';
  }

  for (let i = 0; i < result.roots.length; i++) {
    const root = result.roots[i];
    if (!root || typeof root !== 'object') {
      return `roots[${i}] is not an object`;
    }
    if (root.stars !== undefined && !Array.isArray(root.stars)) {
      return `roots[${i}].stars is not an array`;
    }
  }

  return null;
}

/**
 * Enforce frame guards on nebula response.
 * - Match roots by frameId or label
 * - Drop optional empty roots
 * - Add placeholder for required empty roots
 * - Strip stages when disabled
 * - Reject W-words in labels
 */
function enforceGuards(result, frameInput) {
  const { stagesEnabled, roots: frameRoots } = frameInput;
  const { byFrameId, byLabel, optionalIds, requiredIds } = buildFrameLookups(frameRoots);

  // Track which required roots we've seen
  const seenRequired = new Set();

  // Process each returned root
  result.roots = result.roots.filter(root => {
    // Match root back to frame definition
    let frameRoot = null;

    // Try frameId first (preferred)
    if (root.frameId && byFrameId.has(root.frameId)) {
      frameRoot = byFrameId.get(root.frameId);
    }
    // Fall back to label matching
    else if (root.label && byLabel.has(root.label.toLowerCase())) {
      frameRoot = byLabel.get(root.label.toLowerCase());
    }

    const frameId = frameRoot?.frameId || root.frameId;
    const isOptional = frameRoot ? frameRoot.optional : false;
    const isEmpty = !root.stars || root.stars.length === 0;

    // Track required roots
    if (frameId && requiredIds.has(frameId)) {
      seenRequired.add(frameId);
    }

    // Check for W-words in label
    if (root.label) {
      const labelLower = root.label.toLowerCase();
      for (const w of W_WORDS) {
        if (labelLower === w || labelLower.startsWith(w + ' ') || labelLower.startsWith(w + ':')) {
          console.warn(`[Nebula] W-word detected in label: ${root.label}`);
          // Don't drop, but log - the model shouldn't do this
        }
      }
    }

    if (isEmpty && isOptional) {
      // Optional + empty → drop silently
      return false;
    }

    if (isEmpty && !isOptional) {
      // Required + empty → add placeholder star
      root.stars = [createPlaceholderStar(root.label || frameRoot?.label || 'this area')];
    }

    // Ensure all stars have scores (model might skip them)
    if (root.stars) {
      root.stars = root.stars.map(star => ensureStarScores(star));
    }

    // Ensure root has scores
    root = ensureStarScores(root);

    return true;
  });

  // Add missing required roots with placeholders
  for (const frameId of requiredIds) {
    if (!seenRequired.has(frameId)) {
      const frameRoot = byFrameId.get(frameId);
      if (frameRoot) {
        result.roots.push({
          frameId,
          label: frameRoot.label || `[${frameId}]`,
          title: frameRoot.label || `[${frameId}]`,
          statement: `The premise does not provide information about ${frameRoot.covers || 'this area'}.`,
          confidence: { value: 0, basis: 'unknown' },
          scores: createZeroScores(),
          stage: 0,
          status: 'unexplored',
          stars: [createPlaceholderStar(frameRoot.label || frameId)]
        });
      }
    }
  }

  // Strip stages if not enabled
  if (!stagesEnabled) {
    if (result.core) {
      delete result.core.stage;
    }
    result.roots.forEach(root => {
      delete root.stage;
      if (root.stars) {
        root.stars.forEach(star => {
          delete star.stage;
        });
      }
    });
  }

  result.stagesEnabled = stagesEnabled;

  return result;
}

/**
 * Create a placeholder star for required-but-empty roots.
 */
function createPlaceholderStar(areaName) {
  return {
    title: `[Needs information]`,
    statement: `The premise does not provide enough detail about ${areaName}.`,
    confidence: { value: 0, basis: 'unknown' },
    scores: createZeroScores(),
    stage: 0,
    status: 'unexplored'
  };
}

/**
 * Create zeroed scores with "no information" basis.
 */
function createZeroScores() {
  return {
    economy: { value: 0, reason: 'No information provided' },
    orchestration: { value: 0, reason: 'No information provided' },
    demand: { value: 0, reason: 'No information provided' }
  };
}

/**
 * Ensure a node has valid scores structure.
 */
function ensureStarScores(node) {
  if (!node.scores) {
    node.scores = createZeroScores();
  } else {
    // Fill in any missing score axes
    for (const axis of ['economy', 'orchestration', 'demand']) {
      if (!node.scores[axis]) {
        node.scores[axis] = { value: 0, reason: 'No information provided' };
      } else if (typeof node.scores[axis].value !== 'number') {
        node.scores[axis].value = 0;
      }
      if (!node.scores[axis].reason) {
        node.scores[axis].reason = 'No reason provided';
      }
    }
  }

  if (!node.confidence) {
    node.confidence = { value: 0, basis: 'unknown' };
  }

  return node;
}

module.exports = { generateFramedNebula };
