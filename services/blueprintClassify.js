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

Rules:
1. Pick the single best fit. If the premise spans two, pick the one that governs the structure.
2. Return confidence 0.0-1.0. Be honest — "throw a party" is 0.95 event; "start some kind of business maybe" is 0.5 venture.
3. Always include the top alternate if confidence < 0.85.
4. If nothing fits well, return type "unknown" with low confidence.
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
                 "life-transition", "career", "research", "campaign", "unknown"]
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
      required: ["type", "confidence", "alternates", "reasoning"],
      additionalProperties: false
    }
  }
};

// Byte-identical prefix from single source
const CLASSIFY_SYSTEM = BLUEPRINT_SYSTEM_PREFIX + CLASSIFY_INSTRUCTION;

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

      return result;

    } catch (err) {
      console.error(`[Classify] Attempt ${attempt + 1} failed:`, err.message);

      if (attempt === retries) {
        // Final failure: return safe fallback, don't crash generation
        console.error('[Classify] All retries exhausted, using fallback');
        return {
          type: 'unknown',
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

module.exports = { classifyPremise };
