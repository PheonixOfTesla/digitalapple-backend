/**
 * Blueprint Classify - Premise type classification
 *
 * Classifies a premise into one of 8 types to select the appropriate frame.
 * Uses strict JSON schema for reliable output shape.
 */

const { client, model } = require('./aiClient');
const { BLUEPRINT_SYSTEM_PREFIX } = require('./blueprintPrompts');

const CLASSIFY_INSTRUCTION = `
Classify this premise into exactly one type. Return JSON only.

Types:
- venture: a business, product, or service being built to sell
- event: a gathering, party, wedding, reunion, conference
- personal-goal: learning a skill, fitness, habit, self-improvement
- creative-work: a novel, film, album, game, art project
- life-transition: moving, divorce, retirement, new baby, major life change
- career: job search, promotion, switching fields
- research: a study, investigation, thesis, deep question
- campaign: a launch, fundraiser, movement, marketing push
- procedure: a how-to, bureaucratic process, step-by-step task (e.g. "how to get my drivers license", "how to file a patent", "how to renew a passport")

Also decide what this map resolves TOWARD — its "determination":
- "actionable": the premise asks what to DO. It resolves at concrete doable steps.
  Examples: "how to get my drivers license", "a coffee roaster in Sarasota", "throw a wedding".
- "overview": the premise asks what's TRUE — an explanation, a diagnosis, a study.
  It resolves at evidenced findings (figures, names, mechanisms), not action steps.
  Examples: "how did Mayweather amass so much money", "why did my startup fail",
  "what caused the 2008 crash".
Rule of thumb: if the honest answer is a plan someone executes → actionable.
If the honest answer is an account of what happened or what is → overview.
Most ventures, events, goals, procedures, campaigns, careers are actionable.
Most research and post-mortem "why/how did X" premises are overview.

Rules:
1. Pick the single best fit. If the premise spans two, pick the one that governs the structure.
2. "How to..." premises that are bureaucratic/administrative tasks → procedure (NOT career or personal-goal).
3. Return confidence 0.0-1.0. Be honest — "throw a party" is 0.95 event; "start some kind of business maybe" is 0.5 venture.
4. Always include the top alternate if confidence < 0.85.
5. If nothing fits well, return type "unknown" with low confidence.
6. Always set determination to "actionable" or "overview".
`;

// Strict JSON schema for classification output
const CLASSIFY_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "premise_classification",
    strict: true,
    schema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["venture", "event", "personal-goal", "creative-work",
                 "life-transition", "career", "research", "campaign", "procedure", "unknown"]
        },
        determination: {
          type: "string",
          enum: ["actionable", "overview"]
        },
        confidence: { type: "number" },
        alternates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string" },
              confidence: { type: "number" }
            },
            required: ["type", "confidence"],
            additionalProperties: false
          }
        },
        reasoning: { type: "string" }
      },
      required: ["type", "determination", "confidence", "alternates", "reasoning"],
      additionalProperties: false
    }
  }
};

// Byte-identical prefix from single source
const CLASSIFY_SYSTEM = BLUEPRINT_SYSTEM_PREFIX + CLASSIFY_INSTRUCTION;

// Frame types whose maps almost always resolve at doable steps
const ACTIONABLE_TYPES = new Set([
  'venture', 'event', 'personal-goal', 'creative-work',
  'life-transition', 'career', 'campaign', 'procedure'
]);

/**
 * Deterministic determination fallback — used when the model omits the field
 * or classification fails. Reads the premise's grammar plus the frame type.
 *
 * Past-tense "why/how did X" and diagnostic premises resolve toward findings
 * (overview); everything else defaults to doable steps (actionable).
 *
 * @param {string} premise
 * @param {string} type - classification type
 * @returns {'actionable'|'overview'}
 */
function deriveDetermination(premise, type) {
  const p = (premise || '').toLowerCase().trim();

  // Explanatory / post-mortem grammar → overview
  // "how did ...", "why did ...", "why is ...", "what caused ...", "how does X work"
  const overviewGrammar = [
    /\b(how|why)\s+(did|do|does|is|are|was|were|has|have)\b/,
    /\bwhat\s+(caused|causes|led to|made|explains)\b/,
    /\b(reason|reasons|cause|causes|explanation)\s+(for|behind|why)\b/,
    /\b(amass|amassed|accumulate|accumulated|became|become)\b.*\b(rich|wealthy|money|wealth|fortune|successful|famous)\b/,
    /\bwhy\s+.*\b(fail|failed|succeed|succeeded|collapsed|works?|worked)\b/
  ];
  if (overviewGrammar.some(rx => rx.test(p))) return 'overview';

  // research premises lean overview unless clearly a plan ("how to run a study")
  if (type === 'research') {
    if (/\bhow to\b|\bplan\b|\bconduct\b|\bdesign a\b/.test(p)) return 'actionable';
    return 'overview';
  }

  if (ACTIONABLE_TYPES.has(type)) return 'actionable';

  // Unknown / fallback: default to actionable (a plan is the more useful default)
  return 'actionable';
}

/**
 * Classify a premise into a type with confidence.
 * Returns { type, confidence, alternates, reasoning }
 */
async function classifyPremise(premise, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: CLASSIFY_SYSTEM },
          { role: 'user', content: premise }
        ],
        max_completion_tokens: 200,
        response_format: CLASSIFY_SCHEMA
      });

      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error('Empty response from classify');

      const result = JSON.parse(content);

      // Validate required fields
      if (!result.type || typeof result.confidence !== 'number') {
        throw new Error('Invalid classification shape');
      }

      // Ensure alternates is array
      if (!Array.isArray(result.alternates)) {
        result.alternates = [];
      }

      // Ensure determination is present and valid (derive if the model omitted it)
      if (result.determination !== 'actionable' && result.determination !== 'overview') {
        result.determination = deriveDetermination(premise, result.type);
      }

      return result;

    } catch (err) {
      console.error(`[Classify] Attempt ${attempt + 1} failed:`, err.message);

      if (attempt === retries) {
        // Final failure: return safe fallback, don't crash generation
        console.error('[Classify] All retries exhausted, using fallback');
        return {
          type: 'unknown',
          determination: deriveDetermination(premise, 'unknown'),
          confidence: 0,
          alternates: [],
          reasoning: 'Classification failed, using fallback'
        };
      }

      // Exponential backoff
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

module.exports = { classifyPremise, deriveDetermination };
