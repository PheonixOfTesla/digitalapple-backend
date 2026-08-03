/**
 * Card generation for the DPT study engine.
 *
 * Runs server-side for one non-negotiable reason: the Anthropic API key cannot
 * live in a browser. The frontend is a static site, so generation is an API
 * call, not a client feature.
 *
 * Two guarantees this module makes, and the client re-asserts independently:
 *   1. Every card returned carries `verified: false`. Nothing generated is ever
 *      study-eligible without a human approving it. This is clinical content —
 *      an incorrect nerve root or contraindication drilled forty times is
 *      actively harmful, not merely useless.
 *   2. Every card carries a domain tag, because the coverage view is a lie
 *      without one. The model is asked for it and the response is validated;
 *      cards that omit it are dropped, not defaulted.
 */

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.STUDY_MODEL || 'claude-opus-5';

const NPTE_DOMAINS = [
  'musculoskeletal',
  'neuromuscular',
  'cardiovascular-pulmonary-lymphatic',
  'integumentary',
  'metabolic-endocrine-gi-gu',
  'system-interactions',
  'non-system',
];

let _client = null;
function client() {
  if (_client) return _client;
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error('ANTHROPIC_API_KEY is not configured on the server');
    err.status = 503;
    throw err;
  }
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

/**
 * The JSON schema the model must fill. Structured outputs rather than
 * free-text-then-parse: a malformed card here becomes a validation failure the
 * user has to triage, so it is worth constraining the shape at the API level.
 */
const CARD_SCHEMA = {
  type: 'object',
  properties: {
    cards: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['recall', 'vignette'] },
          front: { type: 'string' },
          back: { type: 'string' },
          stem: { type: 'string' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                correct: { type: 'boolean' },
                rationale: { type: 'string' },
              },
              required: ['text', 'correct', 'rationale'],
              additionalProperties: false,
            },
          },
          domain: { type: 'string', enum: NPTE_DOMAINS },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['kind', 'domain', 'confidence'],
        additionalProperties: false,
      },
    },
    notes: { type: 'string' },
  },
  required: ['cards'],
  additionalProperties: false,
};

const SYSTEM = `You write flashcards for a Doctor of Physical Therapy student preparing for the NPTE.

Two card types, and they do different jobs:

RECALL — one fact, one card. Front is a question, back is the answer. Do not
bundle three facts onto one card; split them. These build the substrate.

VIGNETTE — a clinical scenario with exactly four options, one correct.
EVERY option needs a rationale, including the wrong ones. The distractor
rationales are the actual learning: say specifically why that option is wrong,
not "this is incorrect". A good distractor is something a competent student
would plausibly choose. The NPTE is a clinical-application exam, so vignettes
should require reasoning across findings rather than recognition of a term.

Rules:
- Only use content supported by the source text. Do not add facts from general
  knowledge to fill a quota — returning fewer cards is correct and expected.
- Mark "confidence" as low if the source is ambiguous on that point. A human
  reviews every card and needs to know where to look hardest.
- Assign the NPTE body-system domain to each card individually. Cards from one
  passage often span domains; a passage on diabetic foot ulcers produces both
  metabolic-endocrine-gi-gu and integumentary cards. Do not blanket-tag.
- Be precise about laterality, nerve roots, numeric cutoffs and units. These are
  what the exam tests and what a wrong card damages most.
- No preamble, no commentary outside the JSON.`;

/**
 * @param {{ text: string, course: string, domain: string, topic?: string, count?: number, source?: string }} req
 * @returns {Promise<{ cards: any[], warnings: string[], usage: any, model: string }>}
 */
async function generateCards(req) {
  const text = String(req.text || '').trim();
  if (text.length < 40) {
    const err = new Error('source text is too short to generate from');
    err.status = 400;
    throw err;
  }
  if (!NPTE_DOMAINS.includes(req.domain)) {
    const err = new Error(`unknown domain '${req.domain}'`);
    err.status = 400;
    throw err;
  }

  const count = Math.min(Math.max(Number(req.count) || 10, 1), 30);

  const user = [
    `Generate up to ${count} cards from the source text below.`,
    `The student tagged this passage as course "${req.course}" and primary domain "${req.domain}"` +
      (req.topic ? `, topic "${req.topic}"` : '') + '.',
    `Use "${req.domain}" as the domain unless a specific card clearly belongs to a different body system — in that case tag it accurately.`,
    '',
    'Aim for a mix: recall cards for discrete facts, vignettes where the material',
    'supports clinical reasoning. If the passage is purely definitional, recall',
    'cards only is the right answer — do not invent a scenario to pad the mix.',
    '',
    '--- SOURCE TEXT ---',
    text.slice(0, 60000),
    '--- END SOURCE TEXT ---',
  ].join('\n');

  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'high',
      format: { type: 'json_schema', schema: CARD_SCHEMA },
    },
    messages: [{ role: 'user', content: user }],
  });

  // A refusal returns HTTP 200 with an empty or partial content array, so
  // stop_reason must be checked before reading content.
  if (response.stop_reason === 'refusal') {
    const err = new Error('the model declined to generate from this text');
    err.status = 422;
    throw err;
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) {
    const err = new Error('model returned no text content');
    err.status = 502;
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (e) {
    const err = new Error('model returned unparseable JSON');
    err.status = 502;
    throw err;
  }

  const warnings = [];
  const cards = [];

  for (const [i, raw] of (parsed.cards || []).entries()) {
    const problems = validateGenerated(raw, i);
    if (problems.length) { warnings.push(...problems); continue; }

    cards.push({
      kind: raw.kind,
      ...(raw.kind === 'recall'
        ? { front: raw.front, back: raw.back }
        : { stem: raw.stem, options: raw.options }),
      course: req.course,
      domain: raw.domain,
      ...(req.topic ? { topic: req.topic } : {}),
      ...(req.source ? { source: { text: req.source } } : {}),
      provenance: 'generated',
      // Never true. The review queue is the only path into the deck.
      verified: false,
      tags: raw.confidence === 'low' ? ['needs-check'] : [],
    });
  }

  if (parsed.notes) warnings.push(`model notes: ${parsed.notes}`);

  return {
    cards,
    warnings,
    model: response.model,
    usage: response.usage,
  };
}

/**
 * Server-side validation of a generated card. Mirrors the client's schema rules
 * so a malformed card is dropped here with a reason rather than travelling to
 * the browser to fail there.
 */
function validateGenerated(raw, i) {
  const p = [];
  const at = `card ${i + 1}`;

  if (!raw || typeof raw !== 'object') return [`${at}: not an object`];
  if (!NPTE_DOMAINS.includes(raw.domain)) p.push(`${at}: missing or unknown domain`);

  if (raw.kind === 'recall') {
    if (!raw.front || !String(raw.front).trim()) p.push(`${at}: recall card has no front`);
    if (!raw.back || !String(raw.back).trim()) p.push(`${at}: recall card has no back`);
  } else if (raw.kind === 'vignette') {
    if (!raw.stem || !String(raw.stem).trim()) p.push(`${at}: vignette has no stem`);
    if (!Array.isArray(raw.options) || raw.options.length !== 4) {
      p.push(`${at}: vignette needs exactly 4 options`);
    } else {
      if (raw.options.filter((o) => o && o.correct).length !== 1) {
        p.push(`${at}: vignette needs exactly 1 correct option`);
      }
      raw.options.forEach((o, k) => {
        if (!o?.text?.trim()) p.push(`${at}: option ${k + 1} has no text`);
        // The whole point of the card type — a vignette without distractor
        // rationales teaches nothing, so it is dropped rather than imported.
        if (!o?.rationale?.trim()) p.push(`${at}: option ${k + 1} has no rationale`);
      });
    }
  } else {
    p.push(`${at}: unknown kind '${raw.kind}'`);
  }

  return p;
}

module.exports = { generateCards, NPTE_DOMAINS, MODEL };
