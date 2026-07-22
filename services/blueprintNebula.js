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
Return JSON with core + roots array. FULLY SCOPE every node — no placeholders or gaps.

Each node (core, root, star) MUST have:
- title: 2-5 words, specific to this premise
- statement: 1 sentence, concrete and actionable
- detail: 2-3 sentences explaining the specifics (WHO, WHAT, HOW for this exact premise)
- territory: 8 words max (short phrase summarizing coverage)
- scores: {economy:0-10, orchestration:0-10, demand:0-10} — realistic estimates
- confidence: {value:0.3-0.7, basis:"inferred"} — never "unknown", always "inferred"
- stage: 0
- status: "mapped"

For DECISION nodes (where user has real choices to make), add:
- scopedPaths: [{label:"Option A", summary:"1 sentence", tradeoff:"short", econ:1-10, orch:1-10, dem:1-10, recommended:bool}, ...] (2-3 options max)
- isDecisionPoint: true

CRITICAL RULES:
1. Echo frameId exactly.
2. Domain labels only (never who/what/why/how).
3. Optional empty roots: omit entirely.
4. Required empty roots: STILL fully scope them with inferred content.
5. Every star array must have 1-3 REAL stars with full content — no "[Needs information]".
6. Mark EVERYTHING as basis:"inferred" — user sees this is the engine's draft, not fact.
7. Be SPECIFIC to the premise — "coffee roaster in Sarasota" gets Sarasota-specific content, not generic.
`;

// Byte-identical prefix from single source
const NEBULA_SYSTEM = BLUEPRINT_SYSTEM_PREFIX + NEBULA_FRAME_INSTRUCTION;

/**
 * Extract JSON from LLM response (handles markdown code blocks).
 */
function extractJSON(content) {
  // Try direct parse first
  const trimmed = content.trim();
  if (trimmed.startsWith('{')) {
    return trimmed;
  }
  // Extract from markdown code block
  const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) {
    return match[1].trim();
  }
  // Last resort: find first { to last }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    return trimmed.substring(start, end + 1);
  }
  return trimmed;
}

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
        max_completion_tokens: 8192 // Generous limit to avoid truncation
        // Note: response_format: json_object causes issues with some providers
      });

      const content = response.choices[0]?.message?.content;
      const finishReason = response.choices[0]?.finish_reason;
      console.log(`[Nebula] finish_reason: ${finishReason}, content_length: ${content?.length || 0}`);

      if (finishReason === 'length') {
        console.error(`[Nebula] TRUNCATED! Raw content (last 200 chars): ${content?.slice(-200)}`);
        throw new Error('Response truncated (finish_reason: length)');
      }

      if (!content) throw new Error('Empty response from nebula');

      // Extract JSON from markdown code blocks if present
      const jsonContent = extractJSON(content);
      const result = JSON.parse(jsonContent);

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

    // Ensure all stars have minimal fields
    if (root.stars) {
      root.stars = root.stars.map(star => ensureNodeFields(star));
    }

    // Ensure root has minimal fields
    root = ensureNodeFields(root);

    return true;
  });

  // Add missing required roots with fully-scoped inferred content (not gaps)
  for (const frameId of requiredIds) {
    if (!seenRequired.has(frameId)) {
      const frameRoot = byFrameId.get(frameId);
      if (frameRoot) {
        const label = frameRoot.label || `[${frameId}]`;
        const covers = frameRoot.covers || 'this area';
        result.roots.push({
          frameId,
          label,
          title: label,
          statement: `The ${covers.toLowerCase()} aspects of this plan.`,
          detail: `This covers the ${covers.toLowerCase()} dimension. The engine has inferred a baseline — refine based on your specific context and knowledge.`,
          territory: `${label} — inferred baseline`,
          scores: { economy: 5, orchestration: 5, demand: 5 },
          confidence: { value: 0.35, basis: 'inferred' },
          stage: 0,
          status: 'mapped',
          stars: [createPlaceholderStar(label)]
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
 * Create a fully-scoped placeholder for required-but-empty roots.
 * Even placeholders are inferred content, not gaps.
 */
function createPlaceholderStar(areaName) {
  return {
    title: `${areaName} details`,
    statement: `Key aspects of ${areaName} that will shape the plan.`,
    detail: `This area covers the ${areaName.toLowerCase()} dimension. The specifics depend on your context — refine this to match your situation.`,
    territory: `${areaName} — inferred baseline`,
    scores: { economy: 5, orchestration: 5, demand: 5 },
    confidence: { value: 0.3, basis: 'inferred' },
    stage: 0,
    status: 'mapped'
  };
}

/**
 * Ensure a node has all required fields for full scoping.
 * Missing fields get sensible inferred defaults.
 */
function ensureNodeFields(node) {
  // Confidence MUST be inferred, never unknown (that creates gaps)
  if (!node.confidence || node.confidence.basis === 'unknown') {
    node.confidence = { value: 0.4, basis: 'inferred' };
  }

  // Ensure confidence basis is never 'unknown' — force to 'inferred'
  if (node.confidence.basis === 'unknown') {
    node.confidence.basis = 'inferred';
    node.confidence.value = Math.max(node.confidence.value || 0, 0.3);
  }

  // Territory is a short phrase - use statement as fallback
  if (!node.territory && node.statement) {
    node.territory = node.statement.length > 60
      ? node.statement.substring(0, 57) + '...'
      : node.statement;
  }

  // Detail must exist - generate from statement if missing
  if (!node.detail && node.statement) {
    node.detail = `This covers: ${node.statement}. Specifics to be refined based on your context.`;
  }

  // Scores must exist - default to middle values
  if (!node.scores) {
    node.scores = { economy: 5, orchestration: 5, demand: 5 };
  }

  // Status should be 'mapped' not 'unexplored'
  if (node.status === 'unexplored') {
    node.status = 'mapped';
  }

  return node;
}

module.exports = { generateFramedNebula };
