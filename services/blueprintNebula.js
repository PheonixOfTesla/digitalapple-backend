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
      "statement": "1 concrete sentence — AN ACTION, not a category description",
      "detail": "2-3 sentences with EXECUTION-LEVEL specifics: named tools/offices/services, real numbers (costs, quantities, times), sequence/preconditions",
      "territory": "8 words max",
      "scores": {"economy": 0-10, "orchestration": 0-10, "demand": 0-10},
      "confidence": {"value": 0.3-0.7, "basis": "inferred"}
    }
  ]
}

The input carries a "determination" field. Match it:

── If determination = "actionable" ──
Stars must resolve to DOABLE ACTIONS, not category restating. Include:
- Named entities: real offices, tools, services, websites (e.g. "Florida Division of Corporations", "Sarasota County Clerk", "FDACS", "@sarasotaroasters on Instagram")
- Real numbers: costs ($125), times (3-5 business days), quantities (40 questions)
- Sequence cues: "before opening a bank account", "after the written test", "needed first"

Examples of the target grade:
- "Register the LLC with Florida Division of Corporations — $125, same-week approval, needed before the commissary lease."
- "Book the road test at Sarasota DMV; bring proof of insurance + permit held ≥12 months, $48."
- "Reserve @sarasotaroasters on Instagram + TikTok; post 3x/week, lead with roast-day videos."

── If determination = "overview" ──
The premise asks what's TRUE, not what to do. Stars must resolve to EVIDENCED FINDINGS —
specific claims about mechanisms and structure. Do NOT write action steps.

SOURCING RULES (critical — this is factual content about real subjects):
- The input may include "sourceText" (a real reference excerpt) and "sourceName".
- If sourceText IS present: state figures, dates, names, and specific events ONLY if they
  appear in sourceText. You may paraphrase and explain mechanisms, but do NOT introduce any
  specific number, dollar amount, date, or named deal that is not in sourceText. When you use
  a fact from it, that fact is attributable to sourceName.
- If sourceText is NOT present (null): do NOT assert specific figures, dollar amounts, exact
  dates, or named deals as fact — you have no source for them and must not invent them. Instead
  describe the mechanism qualitatively and, where a number would go, either omit it or clearly
  qualify it as illustrative ("typically", "a large share", "reportedly"). Never fabricate a
  precise statistic or a fake citation.

Include (grounded in sourceText when present):
- Mechanism: WHY/HOW it worked (the structural explanation — safe to reason about)
- Named entities & dates ONLY from the source
- Figures ONLY from the source

Examples of the target grade (overview), when the source supports them:
- "Pay-per-view was the engine: the source notes the Pacquiao bout drove record PPV buys."
- "He captured the promoter's cut by self-promoting under his own promotion company (per source)."
- "Structurally, controlling his own promotion let him keep splits a contracted fighter wouldn't."
Without a source, keep it qualitative: "The bulk of the earnings came from pay-per-view economics
and self-promotion, rather than a fighter's standard purse."

FORBIDDEN (both modes):
- "Handle the operations dimension" — that's a category, not content
- "This area covers X" — that's filler
- "Consider the logistics" — vague guidance, not a resolved node
- "Specifics depend on your context" — either infer or ask a specific question

If you genuinely cannot infer execution-level detail without user input, return:
{
  "title": "the title",
  "needsInput": true,
  "question": "A SPECIFIC question (e.g. 'What roasting capacity do you need — sample roaster or production scale?')",
  "whyItMatters": "One sentence on why this affects the plan"
}
`;

const CONTENT_SYSTEM = BLUEPRINT_SYSTEM_PREFIX + CONTENT_INSTRUCTION;

// ============== TERMINAL DETECTION ==============

// Specificity / execution markers — shared by both determinations
const SPECIFICITY_PATTERNS = [
  /\$[\d,]+/,                        // Dollar amount: $125, $1,200
  /\d+\s*(day|week|hour|minute|month|year)/i,  // Duration
  /\d+\s*%/,                         // Percentage
  /@\w+/,                            // Social handle
  /\.(com|org|gov|io|co)\b/i,        // Website
  /\b(LLC|DBA|EIN|SSN|DMV|IRS|FDACS|FDA|SEC|IRS)\b/,  // Official acronyms
  /\b(before|after|first|then|needed for|precondition)\b/i,  // Sequence cues
  /\b(county|state|federal|division|department|office|clerk|bureau|commission)\b/i,  // Gov entities
];

// Evidence markers for OVERVIEW findings — figures, named things, mechanisms
const EVIDENCE_PATTERNS = [
  /\$[\d,]+(\.\d+)?\s*(million|billion|thousand|k|m|b)?/i,  // Money figures
  /\b\d+(\.\d+)?\s*(million|billion|thousand|percent|%)/i,   // Quantified magnitudes
  /\b(19|20)\d{2}\b/,                // Years: 1996, 2015
  /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/, // Proper-noun sequence (Named entities)
  /\b(because|due to|driven by|resulted in|caused by|thanks to|as a result)\b/i, // Mechanism/causation
  /\b(pay-per-view|PPV|contract|revenue|earnings|purse|deal|share|stake|margin)\b/i, // Domain evidence nouns
];

// Action verbs that signal a doable step (ACTIONABLE determination)
const ACTION_PATTERNS = [
  /^\s*(register|file|apply|submit|book|schedule|call|email|contact|buy|order|sign|create|write|upload|download|reserve|open|set up|establish|obtain|renew|pass|take|complete|pay|hire|lease|form|draft|install|configure|visit|bring|request)/i,
  /\b(register|file|apply|submit|book|schedule|obtain|renew)\b.*\b(at|with|to|on|from)\b/i,
];

// Category-restatement / filler — never terminal, signals a non-resolved node
const CATEGORY_PATTERNS = [
  /^(the\s+\w+\s+dimension|handle the|consider the|this area covers|this section covers)/i,
  /specifics depend on your context/i,
];

/**
 * Determine if a node has reached a resolved / terminal state.
 *
 * Terminal criterion depends on the map's determination (PART 3):
 *   - actionable: a DOABLE step — action verb + concrete specifics.
 *   - overview:   an evidenced FINDING — figures / names / mechanisms.
 *
 * @param {object} node - The node to evaluate
 * @param {number} depth - Depth level (0=core, 1=root, 2=star, 3+ deeper)
 * @param {'actionable'|'overview'} determination
 * @returns {object} { terminal, reason, action }
 */
function judgeNodeTerminal(node, depth = 0, determination = 'actionable') {
  // Core nodes are never terminal
  if (depth === 0) {
    return { terminal: false, reason: 'Core node', action: null };
  }

  // Nodes that need input are not terminal
  if (node.needsInput) {
    return { terminal: false, reason: 'Needs user input', action: null };
  }

  const statement = node.statement || node.title || '';
  const detail = node.detail || '';
  const combined = statement + ' ' + detail;
  const wordCount = statement.trim().split(/\s+/).length;

  // Category restatement is never terminal regardless of determination
  if (CATEGORY_PATTERNS.some(p => p.test(statement.trim()))) {
    return { terminal: false, reason: 'Category restatement, not resolved', action: null };
  }

  // Extract the resolved text: statement + first sentence of detail
  const extractAction = () => {
    let action = statement;
    if (detail && detail.length < 240) {
      action += ' — ' + detail.split('.')[0] + '.';
    }
    return action.length > 400 ? action.substring(0, 397) + '...' : action;
  };

  if (determination === 'overview') {
    // OVERVIEW: terminal when the node states an evidenced finding.
    const evidenceScore = EVIDENCE_PATTERNS.filter(p => p.test(combined)).length;

    // A finding needs concrete evidence (figures/names/mechanism).
    if (depth >= 2 && evidenceScore >= 2) {
      return { terminal: true, reason: 'Evidenced finding', action: extractAction() };
    }
    // A concise, evidenced claim at leaf depth also resolves.
    if (depth >= 2 && evidenceScore >= 1 && wordCount <= 30 && /\b(19|20)\d{2}\b|\$|\d/.test(combined)) {
      return { terminal: true, reason: 'Concise evidenced finding', action: extractAction() };
    }
    // Deep node with any evidence.
    if (depth >= 3 && evidenceScore >= 1) {
      return { terminal: true, reason: 'Deep evidenced finding', action: extractAction() };
    }
    return { terminal: false, reason: 'Not yet an evidenced finding', action: null };
  }

  // ACTIONABLE (default): terminal when the node states a doable step.
  const hasActionVerb = ACTION_PATTERNS.some(p => p.test(statement));
  const specificityScore = SPECIFICITY_PATTERNS.filter(p => p.test(combined)).length;

  // 1. Action verb + at least one concrete specific
  if (hasActionVerb && specificityScore >= 1) {
    return { terminal: true, reason: 'Action with specifics', action: extractAction() };
  }
  // 2. Leaf with multiple specifics even without an explicit verb
  if (depth >= 2 && specificityScore >= 2) {
    return { terminal: true, reason: 'Leaf with multiple specifics', action: extractAction() };
  }
  // 3. Concise, concrete leaf
  if (depth >= 2 && wordCount <= 14 && specificityScore >= 1) {
    return { terminal: true, reason: 'Concise actionable leaf', action: extractAction() };
  }
  // 4. Deep + action verb (short doable step)
  if (depth >= 3 && hasActionVerb) {
    return { terminal: true, reason: 'Deep actionable step', action: extractAction() };
  }

  return { terminal: false, reason: 'Can be expanded further', action: null };
}

/**
 * Mark all terminal nodes in a nebula and set action/question fields.
 * Runs at generation time so fresh maps have real terminals (PART 2).
 *
 * @param {object} nebula - The nebula to process
 * @param {'actionable'|'overview'} determination
 * @returns {object} The nebula with terminal flags + action/question fields set
 */
function markTerminalNodes(nebula, determination = 'actionable') {
  // Core is never terminal
  if (nebula.core) {
    nebula.core.terminal = false;
    nebula.core.action = null;
    nebula.core.determination = determination;
  }

  // Process roots and their stars
  for (const root of (nebula.roots || [])) {
    root.determination = determination;
    const rootResult = judgeNodeTerminal(root, 1, determination);
    root.terminal = rootResult.terminal;
    root.action = rootResult.action;

    // If root needs input, ensure question field is set
    if (root.needsInput && !root.question) {
      root.question = root.statement || `What should we know about ${root.label || 'this area'}?`;
    }

    for (const star of (root.stars || [])) {
      star.determination = determination;
      const starResult = judgeNodeTerminal(star, 2, determination);
      star.terminal = starResult.terminal;
      star.action = starResult.action;

      // If star needs input, ensure question field is set
      if (star.needsInput && !star.question) {
        star.question = star.statement || `What should we know about ${star.title || 'this'}?`;
      }
    }
  }

  return nebula;
}

/**
 * Count terminal nodes in a nebula.
 *
 * @param {object} nebula - The nebula to count
 * @returns {number} Count of terminal nodes
 */
function countTerminalNodes(nebula) {
  let count = 0;

  for (const root of (nebula.roots || [])) {
    if (root.terminal) count++;
    for (const star of (root.stars || [])) {
      if (star.terminal) count++;
    }
  }

  return count;
}

// ============== MAIN GENERATION ==============

/**
 * Generate a nebula from a frame input using parallel generation.
 */
async function generateFramedNebula(frameInput, retries = 1) {
  const startTime = Date.now();
  const determination = frameInput.determination === 'overview' ? 'overview' : 'actionable';

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
  const guarded = enforceGuards(nebula, frameInput);

  // Step 5: Mark terminal nodes at generation time (determination-aware)
  console.log(`[Nebula] Step 4: Detecting terminal nodes (determination=${determination})...`);
  const result = markTerminalNodes(guarded, determination);
  result.determination = determination;
  const terminalCount = countTerminalNodes(result);
  console.log(`[Nebula] Terminal nodes: ${terminalCount}/${determination}`);

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
 * Generate content for all roots with rate-limit aware batching.
 * Starts with full parallel, falls back to batches of 2 on 429.
 */
async function generateContentParallel(frameInput, skeleton, retries) {
  const { premise, roots: frameRoots } = frameInput;
  const { byFrameId } = buildFrameLookups(frameRoots);

  // Build content input for each root
  const contentInputs = skeleton.roots.map(skeletonRoot => {
    const frameRoot = byFrameId.get(skeletonRoot.frameId);
    if (!frameRoot) {
      console.warn(`[Nebula:Content] No frame for ${skeletonRoot.frameId}, skipping`);
      return null;
    }
    return {
      skeletonRoot,
      frameRoot,
      contentInput: {
        premise,
        determination: frameInput.determination === 'overview' ? 'overview' : 'actionable',
        // Real source text to ground factual claims on (null when ungrounded).
        sourceText: frameInput.grounding ? frameInput.grounding.text : null,
        sourceName: frameInput.grounding ? frameInput.grounding.source.name : null,
        root: {
          frameId: skeletonRoot.frameId,
          label: frameRoot.label || skeletonRoot.label,
          covers: frameRoot.covers
        },
        starTitles: skeletonRoot.starTitles || []
      }
    };
  }).filter(Boolean);

  // Try to generate content with rate-limit aware batching
  const results = new Array(skeleton.roots.length).fill(null);
  let batchSize = contentInputs.length; // Start full parallel
  let rateLimitHit = false;

  for (let i = 0; i < contentInputs.length; i += batchSize) {
    const batch = contentInputs.slice(i, Math.min(i + batchSize, contentInputs.length));

    const batchPromises = batch.map(async ({ skeletonRoot, frameRoot, contentInput }) => {
      try {
        return { frameId: skeletonRoot.frameId, result: await generateRootContent(contentInput, retries) };
      } catch (err) {
        // Detect rate limit
        if (err.message?.includes('429') || err.message?.includes('rate')) {
          rateLimitHit = true;
        }
        console.error(`[Nebula:Content] Failed for ${skeletonRoot.frameId}:`, err.message);
        return { frameId: skeletonRoot.frameId, result: createQuestionRoot(skeletonRoot, frameRoot, premise) };
      }
    });

    // Run batch with timeout
    const batchResults = await Promise.all(
      batchPromises.map(p =>
        Promise.race([
          p,
          new Promise((_, reject) => setTimeout(() => reject(new Error('Content timeout')), 20000))
        ]).catch(err => {
          console.error('[Nebula:Content] Timeout or error:', err.message);
          return null;
        })
      )
    );

    // Map results back
    for (const br of batchResults) {
      if (br && br.frameId) {
        const idx = skeleton.roots.findIndex(r => r.frameId === br.frameId);
        if (idx !== -1) results[idx] = br.result;
      }
    }

    // If rate limited, switch to smaller batches and wait
    if (rateLimitHit && batchSize > 2) {
      console.log('[Nebula:Content] Rate limited, switching to batches of 2...');
      batchSize = 2;
      await new Promise(r => setTimeout(r, 2000)); // Wait 2s before next batch
      rateLimitHit = false;
    } else if (rateLimitHit) {
      await new Promise(r => setTimeout(r, 1500)); // Wait between small batches
      rateLimitHit = false;
    }
  }

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
 * Confidence weight for a node's contribution to completeness (PART 5).
 * confirmed/terminal = full (1.0), stated = 0.8, inferred = partial (0.5),
 * unknown = gap (0.0). NOT node-count.
 */
function completenessWeight(node) {
  if (node.terminal) return 1.0;
  const basis = node.confidence?.basis || 'unknown';
  if (node.needsInput || basis === 'unknown') return 0.0;
  if (basis === 'confirmed') return 1.0;
  if (basis === 'stated') return 0.8;
  if (basis === 'inferred') return 0.5;
  return 0.0;
}

/**
 * Synthesize the core detail as an INTEGRATION of all developed nodes —
 * re-synthesized in Clockwork's advisory voice as leaves resolve (PART 5).
 * Not the premise repeated. Completeness is confidence-weighted, not node-count.
 *
 * @param {Array} roots
 * @param {string} premise
 * @param {'actionable'|'overview'} determination
 */
function synthesizeCoreDetail(roots, premise, determination = 'actionable') {
  const noun = determination === 'overview' ? 'account' : 'plan';
  if (!roots || roots.length === 0) {
    return `This ${noun} maps ${premise}. Each section below opens a dimension to develop.`;
  }

  // Collect key points from resolved roots, weighted by grounding
  const highlights = [];
  let resolvedCount = 0;     // terminal endpoints reached
  let weightSum = 0;         // confidence-weighted completeness numerator
  let weightMax = 0;         // denominator (every developable node)
  const openGaps = [];       // labels of dimensions still needing input

  for (const root of roots) {
    const label = root.label || root.title;

    weightMax += 1;
    weightSum += completenessWeight(root);
    if (root.terminal) resolvedCount++;

    if (root.needsInput) {
      openGaps.push(label);
    } else if (root.statement && !root.statement.startsWith('What ')) {
      highlights.push(`${label}: ${root.statement.split('.')[0]}.`);
    }

    for (const star of (root.stars || [])) {
      weightMax += 1;
      weightSum += completenessWeight(star);
      if (star.terminal) resolvedCount++;
    }
  }

  const completeness = weightMax > 0 ? Math.round((weightSum / weightMax) * 100) : 0;

  if (highlights.length === 0) {
    const gapNote = openGaps.length ? ` Start with ${openGaps.slice(0, 2).join(' and ')}.` : '';
    return `This ${noun} maps ${premise}, but the key dimensions still need your input.${gapNote}`;
  }

  const resolvedNote = determination === 'overview'
    ? (resolvedCount > 0 ? ` ${resolvedCount} evidenced findings so far` : ' No findings resolved yet — keep developing the branches')
    : (resolvedCount > 0 ? ` ${resolvedCount} concrete steps identified` : ' No steps resolved yet — keep developing the branches');

  const gapNote = openGaps.length ? `; ${openGaps.length} dimension(s) still open` : '';

  return `${highlights.slice(0, 4).join(' ')}${resolvedNote} (${completeness}% grounded)${gapNote}.`;
}

/**
 * Assemble the full nebula from skeleton + content results.
 */
function assembleNebula(skeleton, contentResults, frameInput) {
  const nebula = {
    core: {
      title: skeleton.core.title,
      statement: `Mapping: ${frameInput.premise}`,
      detail: '', // Will be synthesized after roots are assembled
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
        // Star is a question — set question field
        const questionText = star.question || star.statement || `What should we know about ${star.title}?`;
        assembledRoot.stars.push({
          title: star.title,
          statement: questionText,
          detail: star.whyItMatters || star.detail || 'Your input is needed here.',
          territory: `${star.title} — needs input`,
          scores: { economy: 5, orchestration: 5, demand: 5 },
          confidence: { value: 0, basis: 'unknown' },
          needsInput: true,
          question: questionText,
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

  // Synthesize core detail from assembled roots
  nebula.core.detail = synthesizeCoreDetail(
    nebula.roots,
    frameInput.premise,
    frameInput.determination === 'overview' ? 'overview' : 'actionable'
  );

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

module.exports = {
  generateFramedNebula,
  judgeNodeTerminal,
  markTerminalNodes,
  countTerminalNodes
};
