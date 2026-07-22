/**
 * Blueprint Nebula - Frame-aware map generation
 *
 * ARCHITECTURE: Split generation for reliability
 * 1. Skeleton call: premise + frame → core + root labels + star TITLES only
 * 2. Parallel content calls: one per root → full content for that root's nodes
 * 3. Assemble + enforce guards
 *
 * This prevents truncation and ensures every node gets real content.
 * When content genuinely can't be inferred, surfaces a specific question.
 */

const { client, model } = require('./aiClient');
const { BLUEPRINT_SYSTEM_PREFIX, W_WORDS } = require('./blueprintPrompts');
const { buildFrameLookups } = require('./frameLoader');

// ============== SKELETON GENERATION ==============

const SKELETON_INSTRUCTION = `
Return JSON with the STRUCTURE of the map. This is step 1 of 2 — titles only, content comes next.

Return:
{
  "core": {
    "title": "2-5 words summarizing the premise"
  },
  "roots": [
    {
      "frameId": "echo the frameId exactly",
      "label": "use the frame's label",
      "starTitles": ["2-5 word title", "2-5 word title", "2-5 word title"]
    }
  ]
}

RULES:
1. Echo frameId exactly from input.
2. Use the frame's label for each root (never who/what/why/how).
3. Each root gets 1-3 starTitles — short, specific to this premise.
4. Optional roots with nothing relevant: omit entirely.
5. Required roots: always include with at least 1 star title.
6. Titles must be SPECIFIC to this premise, not generic.
`;

const SKELETON_SYSTEM = BLUEPRINT_SYSTEM_PREFIX + SKELETON_INSTRUCTION;

// ============== CONTENT GENERATION (per root) ==============

const CONTENT_INSTRUCTION = `
You are filling in the CONTENT for one section of a map. You receive:
- The premise
- One root's label and what it covers
- The star titles for this root

Return JSON with full content for this root and its stars. Be SPECIFIC to this exact premise.

{
  "root": {
    "title": "2-5 words",
    "statement": "1 concrete sentence about this dimension FOR THIS PREMISE",
    "detail": "2-3 sentences with specifics — WHO, WHAT, HOW for THIS exact situation",
    "territory": "8 words max summarizing coverage",
    "scores": {"economy": 0-10, "orchestration": 0-10, "demand": 0-10},
    "confidence": {"value": 0.3-0.7, "basis": "inferred"}
  },
  "stars": [
    {
      "title": "echo the star title",
      "statement": "1 concrete sentence specific to this premise",
      "detail": "2-3 sentences with real specifics — not template text",
      "territory": "8 words max",
      "scores": {"economy": 0-10, "orchestration": 0-10, "demand": 0-10},
      "confidence": {"value": 0.3-0.7, "basis": "inferred"}
    }
  ]
}

CRITICAL — every statement and detail must be REAL INFERENCE about THIS premise:
- "a flaky test linked to Redis use-after-free" → talk about race conditions, client lifecycle, memory handling
- "coffee roaster in Sarasota" → talk about Sarasota's market, Florida regulations, local suppliers
- NEVER write "This area covers X" or "specifics depend on your context" — that's filler, not content

If you genuinely cannot infer something without more information, return for that star:
{
  "title": "the title",
  "needsInput": true,
  "question": "A SPECIFIC question to ask the user (e.g. 'What Redis client library are you using?')",
  "whyItMatters": "One sentence on why this affects the plan"
}
`;

const CONTENT_SYSTEM = BLUEPRINT_SYSTEM_PREFIX + CONTENT_INSTRUCTION;

// ============== MAIN GENERATION ==============

/**
 * Generate a nebula from a frame input using parallel generation.
 */
async function generateFramedNebula(frameInput, retries = 1) {
  const startTime = Date.now();

  // Step 1: Generate skeleton (structure only)
  console.log('[Nebula] Step 1: Generating skeleton...');
  let skeleton;
  try {
    skeleton = await generateSkeleton(frameInput, retries);
    console.log(`[Nebula] Skeleton complete: ${skeleton.roots.length} roots`);
  } catch (err) {
    console.error('[Nebula] Skeleton generation failed, using fallback structure:', err.message);
    // Fallback: create skeleton from frame roots directly
    skeleton = createFallbackSkeleton(frameInput);
  }

  // Step 2: Generate content for each root in parallel
  console.log('[Nebula] Step 2: Generating content for each root in parallel...');
  const contentResults = await generateContentParallel(frameInput, skeleton, retries);

  // Step 3: Assemble the full nebula
  console.log('[Nebula] Step 3: Assembling nebula...');
  const nebula = assembleNebula(skeleton, contentResults, frameInput);

  // Step 4: Enforce guards (label mapping, optional-root dropping)
  const result = enforceGuards(nebula, frameInput);

  const elapsed = Date.now() - startTime;
  console.log(`[Nebula] Complete in ${elapsed}ms`);

  return result;
}

/**
 * Generate the skeleton structure.
 */
async function generateSkeleton(frameInput, retries) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: SKELETON_SYSTEM },
          { role: 'user', content: JSON.stringify(frameInput) }
        ],
        max_completion_tokens: 1500
      });

      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error('Empty skeleton response');

      const result = JSON.parse(extractJSON(content));

      // Validate skeleton shape
      if (!result.core || !Array.isArray(result.roots)) {
        throw new Error('Invalid skeleton shape');
      }

      return result;

    } catch (err) {
      console.error(`[Nebula:Skeleton] Attempt ${attempt + 1} failed:`, err.message);
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

/**
 * Generate content for all roots in parallel.
 */
async function generateContentParallel(frameInput, skeleton, retries) {
  const { premise, roots: frameRoots } = frameInput;
  const { byFrameId } = buildFrameLookups(frameRoots);

  const contentPromises = skeleton.roots.map(async (skeletonRoot) => {
    const frameRoot = byFrameId.get(skeletonRoot.frameId);
    if (!frameRoot) {
      console.warn(`[Nebula:Content] No frame for ${skeletonRoot.frameId}, skipping`);
      return null;
    }

    try {
      const contentInput = {
        premise,
        root: {
          frameId: skeletonRoot.frameId,
          label: frameRoot.label || skeletonRoot.label,
          covers: frameRoot.covers
        },
        starTitles: skeletonRoot.starTitles || []
      };

      return await generateRootContent(contentInput, retries);

    } catch (err) {
      console.error(`[Nebula:Content] Failed for ${skeletonRoot.frameId}:`, err.message);
      // Return question state for failed root
      return createQuestionRoot(skeletonRoot, frameRoot, premise);
    }
  });

  // Run all content calls in parallel with timeout
  const results = await Promise.all(
    contentPromises.map(p =>
      Promise.race([
        p,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Content timeout')), 15000))
      ]).catch(err => {
        console.error('[Nebula:Content] Timeout or error:', err.message);
        return null;
      })
    )
  );

  return results;
}

/**
 * Generate content for a single root.
 */
async function generateRootContent(contentInput, retries) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: CONTENT_SYSTEM },
          { role: 'user', content: JSON.stringify(contentInput) }
        ],
        max_completion_tokens: 2000
      });

      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error('Empty content response');

      const result = JSON.parse(extractJSON(content));

      // Validate content shape
      if (!result.root || !Array.isArray(result.stars)) {
        throw new Error('Invalid content shape');
      }

      // Attach frameId for assembly
      result.frameId = contentInput.root.frameId;
      result.label = contentInput.root.label;

      return result;

    } catch (err) {
      console.error(`[Nebula:Content:${contentInput.root.frameId}] Attempt ${attempt + 1} failed:`, err.message);
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
    }
  }
}

/**
 * Create a question-state root when content generation fails.
 */
function createQuestionRoot(skeletonRoot, frameRoot, premise) {
  const label = frameRoot?.label || skeletonRoot.label || 'This section';
  const covers = frameRoot?.covers || 'this dimension';

  // Generate a SPECIFIC question based on premise + dimension
  const question = generateSpecificQuestion(premise, label, covers);

  return {
    frameId: skeletonRoot.frameId,
    label,
    root: {
      title: label,
      statement: question,
      detail: `Understanding ${covers} will help complete this part of the plan.`,
      territory: `${label} — needs your input`,
      scores: { economy: 5, orchestration: 5, demand: 5 },
      confidence: { value: 0, basis: 'unknown' },
      needsInput: true
    },
    stars: (skeletonRoot.starTitles || []).map(title => ({
      title,
      statement: `What specific details can you provide about "${title}"?`,
      detail: `This will help scope ${title.toLowerCase()} for your situation.`,
      territory: `${title} — awaiting input`,
      scores: { economy: 5, orchestration: 5, demand: 5 },
      confidence: { value: 0, basis: 'unknown' },
      needsInput: true,
      question: `What do you know about ${title.toLowerCase()} for this ${premise.substring(0, 30)}...?`,
      whyItMatters: `Needed to scope this element of the plan.`
    }))
  };
}

/**
 * Generate a specific question based on premise and dimension.
 */
function generateSpecificQuestion(premise, label, covers) {
  const premiseShort = premise.length > 50 ? premise.substring(0, 50) + '...' : premise;

  // Map common dimensions to question templates
  const questionTemplates = {
    'Method': `What approach or tools are you using for "${premiseShort}"?`,
    'Sources': `Who or what can you consult about "${premiseShort}"?`,
    'The Question': `What specifically are you trying to answer about "${premiseShort}"?`,
    'Sequence': `What's your timeline or order of operations for "${premiseShort}"?`,
    'Unknowns': `What are the biggest uncertainties in "${premiseShort}"?`,
    'Customers': `Who is the target audience for "${premiseShort}"?`,
    'The Offer': `What exactly will you deliver for "${premiseShort}"?`,
    'Channel': `How will you reach people for "${premiseShort}"?`,
    'Operations': `How will you execute "${premiseShort}"?`,
    'The Wedge': `What makes "${premiseShort}" different or defensible?`,
  };

  return questionTemplates[label] ||
    `What can you tell me about the ${covers} for "${premiseShort}"?`;
}

/**
 * Assemble the full nebula from skeleton + content results.
 */
function assembleNebula(skeleton, contentResults, frameInput) {
  const nebula = {
    core: {
      title: skeleton.core.title,
      statement: `Mapping: ${frameInput.premise}`,
      detail: `This plan explores ${frameInput.premise}. Each section below covers a key dimension.`,
      territory: skeleton.core.title,
      scores: { economy: 5, orchestration: 5, demand: 5 },
      confidence: { value: 0.5, basis: 'inferred' },
      stage: 0,
      status: 'mapped'
    },
    roots: []
  };

  // Match content results to skeleton roots
  for (let i = 0; i < skeleton.roots.length; i++) {
    const skeletonRoot = skeleton.roots[i];
    const content = contentResults[i];

    if (!content) {
      // Content generation failed completely — create question root
      const { byFrameId } = buildFrameLookups(frameInput.roots);
      const frameRoot = byFrameId.get(skeletonRoot.frameId);
      const questionRoot = createQuestionRoot(skeletonRoot, frameRoot, frameInput.premise);
      nebula.roots.push({
        frameId: questionRoot.frameId,
        label: questionRoot.label,
        ...questionRoot.root,
        stars: questionRoot.stars
      });
      continue;
    }

    // Assemble root with content
    const assembledRoot = {
      frameId: content.frameId,
      label: content.label,
      title: content.root.title,
      statement: content.root.statement,
      detail: content.root.detail,
      territory: content.root.territory,
      scores: content.root.scores || { economy: 5, orchestration: 5, demand: 5 },
      confidence: content.root.confidence || { value: 0.5, basis: 'inferred' },
      stage: 0,
      status: 'mapped',
      stars: []
    };

    // Add stars
    for (const star of content.stars) {
      if (star.needsInput) {
        // Star is a question
        assembledRoot.stars.push({
          title: star.title,
          statement: star.question || star.statement,
          detail: star.whyItMatters || star.detail,
          territory: `${star.title} — needs input`,
          scores: { economy: 5, orchestration: 5, demand: 5 },
          confidence: { value: 0, basis: 'unknown' },
          needsInput: true,
          stage: 0,
          status: 'mapped'
        });
      } else {
        // Star has real content
        assembledRoot.stars.push({
          title: star.title,
          statement: star.statement,
          detail: star.detail,
          territory: star.territory || star.title,
          scores: star.scores || { economy: 5, orchestration: 5, demand: 5 },
          confidence: star.confidence || { value: 0.5, basis: 'inferred' },
          stage: 0,
          status: 'mapped'
        });
      }
    }

    nebula.roots.push(assembledRoot);
  }

  return nebula;
}

// ============== FALLBACKS ==============

/**
 * Create a fallback skeleton when AI fails completely.
 * Uses frame roots directly as structure.
 */
function createFallbackSkeleton(frameInput) {
  const premiseShort = frameInput.premise.length > 40
    ? frameInput.premise.substring(0, 40) + '...'
    : frameInput.premise;

  return {
    core: {
      title: premiseShort
    },
    roots: frameInput.roots.map(root => ({
      frameId: root.frameId,
      label: root.label || root.frameId,
      starTitles: [`Key aspect of ${root.label || root.covers}`]
    }))
  };
}

// ============== GUARDS & UTILITIES ==============

/**
 * Extract JSON from LLM response (handles markdown code blocks).
 */
function extractJSON(content) {
  const trimmed = content.trim();
  if (trimmed.startsWith('{')) return trimmed;

  const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) return match[1].trim();

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    return trimmed.substring(start, end + 1);
  }
  return trimmed;
}

/**
 * Enforce frame guards on nebula response.
 */
function enforceGuards(result, frameInput) {
  const { stagesEnabled, roots: frameRoots } = frameInput;
  const { byFrameId, byLabel, optionalIds, requiredIds } = buildFrameLookups(frameRoots);

  const seenRequired = new Set();

  // Process each returned root
  result.roots = result.roots.filter(root => {
    let frameRoot = null;

    if (root.frameId && byFrameId.has(root.frameId)) {
      frameRoot = byFrameId.get(root.frameId);
    } else if (root.label && byLabel.has(root.label.toLowerCase())) {
      frameRoot = byLabel.get(root.label.toLowerCase());
    }

    const frameId = frameRoot?.frameId || root.frameId;
    const isOptional = frameRoot ? frameRoot.optional : false;
    const isEmpty = !root.stars || root.stars.length === 0;

    if (frameId && requiredIds.has(frameId)) {
      seenRequired.add(frameId);
    }

    // Fix W-words in labels
    if (root.label) {
      const labelLower = root.label.toLowerCase().trim();
      const isWWord = W_WORDS.some(w =>
        labelLower === w ||
        labelLower === `[${w}]` ||
        labelLower.startsWith(w + ' ') ||
        labelLower.startsWith(w + ':') ||
        labelLower.startsWith('[' + w)
      );

      if (isWWord && frameRoot?.label) {
        root.label = frameRoot.label;
        if (root.title && W_WORDS.some(w => root.title.toLowerCase().includes(`[${w}]`) || root.title.toLowerCase() === w)) {
          root.title = frameRoot.label;
        }
      }
    }

    if (!root.label && frameRoot?.label) {
      root.label = frameRoot.label;
    }

    // Optional + empty → drop
    if (isEmpty && isOptional) {
      return false;
    }

    // Required + empty → question state (not filler)
    if (isEmpty && !isOptional) {
      const label = root.label || frameRoot?.label || 'This section';
      const covers = frameRoot?.covers || 'this area';
      root.stars = [{
        title: `${label} details`,
        statement: generateSpecificQuestion(frameInput.premise, label, covers),
        detail: `Understanding ${covers} will help complete this section.`,
        territory: `${label} — needs input`,
        scores: { economy: 5, orchestration: 5, demand: 5 },
        confidence: { value: 0, basis: 'unknown' },
        needsInput: true,
        stage: 0,
        status: 'mapped'
      }];
    }

    return true;
  });

  // Add missing required roots as questions
  for (const frameId of requiredIds) {
    if (!seenRequired.has(frameId)) {
      const frameRoot = byFrameId.get(frameId);
      if (frameRoot) {
        const label = frameRoot.label || capitalizeFirst(frameRoot.covers?.split(',')[0] || 'This area');
        const covers = frameRoot.covers || 'this area';
        result.roots.push({
          frameId,
          label,
          title: label,
          statement: generateSpecificQuestion(frameInput.premise, label, covers),
          detail: `This section covers ${covers}. Your input is needed to scope it.`,
          territory: `${label} — needs input`,
          scores: { economy: 5, orchestration: 5, demand: 5 },
          confidence: { value: 0, basis: 'unknown' },
          needsInput: true,
          stage: 0,
          status: 'mapped',
          stars: [{
            title: `${label} details`,
            statement: `What can you tell me about ${covers} for this plan?`,
            detail: `Needed to fully scope this dimension.`,
            territory: `${label} — awaiting input`,
            scores: { economy: 5, orchestration: 5, demand: 5 },
            confidence: { value: 0, basis: 'unknown' },
            needsInput: true,
            stage: 0,
            status: 'mapped'
          }]
        });
      }
    }
  }

  // Strip stages if not enabled
  if (!stagesEnabled) {
    if (result.core) delete result.core.stage;
    result.roots.forEach(root => {
      delete root.stage;
      if (root.stars) {
        root.stars.forEach(star => delete star.stage);
      }
    });
  }

  result.stagesEnabled = stagesEnabled;
  return result;
}

function capitalizeFirst(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

module.exports = { generateFramedNebula };
