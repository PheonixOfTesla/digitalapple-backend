/**
 * Card generation for the study engine (DPT and GRE tracks).
 *
 * Runs server-side because the LLM key cannot live in a browser — the study app
 * is a static page. It goes through `services/aiClient.js`, the app's single
 * LLM client (Moonshot Kimi k2.6 by default, OpenAI-compatible), rather than
 * standing up a second provider and a second key to manage.
 *
 * Two guarantees this module makes, and the client re-asserts independently:
 *   1. Every card returned carries `verified: false`. Nothing generated is ever
 *      study-eligible without a human approving it. For DPT that is a safety
 *      matter — an incorrect nerve root or contraindication drilled forty times
 *      is actively harmful. For GRE a wrong answer key is just as corrosive:
 *      you would be rehearsing the wrong reasoning.
 *   2. Every card carries a domain tag, because coverage is a lie without one.
 *      The model is asked for it and the response is validated; cards that omit
 *      it are dropped, not defaulted.
 */

const { client, model, provider } = require('./aiClient');

// ─── Track definitions (mirrors student/lib/tracks.js on the client) ────────

const DPT_DOMAINS = [
  'musculoskeletal',
  'neuromuscular',
  'cardiovascular-pulmonary-lymphatic',
  'integumentary',
  'metabolic-endocrine-gi-gu',
  'system-interactions',
  'non-system',
];

const GRE_DOMAINS = [
  'reading-comprehension',
  'text-completion',
  'sentence-equivalence',
  'arithmetic',
  'algebra',
  'geometry',
  'data-analysis',
  'analytical-writing',
];

const TRACKS = {
  dpt: {
    domains: DPT_DOMAINS,
    kinds: ['recall', 'vignette'],
    optionCount: { vignette: 4 },
  },
  gre: {
    domains: GRE_DOMAINS,
    kinds: ['recall', 'mcq', 'multi', 'quant-comparison', 'numeric'],
    optionCount: { mcq: 5, 'quant-comparison': 4 },
  },
};

// ─── Prompts ───────────────────────────────────────────────────────────────

const DPT_SYSTEM = `You write flashcards for a Doctor of Physical Therapy student preparing for the NPTE.

Two card types, and they do different jobs:

RECALL — one fact, one card. Front is a question, back is the answer. Do not
bundle three facts onto one card; split them. These build the substrate.

VIGNETTE — a clinical scenario with exactly four options, one correct.
EVERY option needs a rationale, including the wrong ones. The distractor
rationales are the actual learning: say specifically why that option is wrong,
not "this is incorrect". A good distractor is something a competent student
would plausibly choose. The NPTE is a clinical-application exam, so vignettes
should require reasoning across findings rather than recognition of a term.

Be precise about laterality, nerve roots, numeric cutoffs and units. These are
what the exam tests and what a wrong card damages most.`;

const GRE_SYSTEM = `You write practice items for a student preparing for the GRE General Test.

Card types:

RECALL — one fact per card. Vocabulary (word on the front, definition plus a
usage sentence on the back) or a single mathematical rule or formula.

MCQ — a question with exactly five options, one correct. Standard for Reading
Comprehension, Text Completion (single blank) and most Quantitative items.
Every option needs a rationale. For verbal items the wrong-answer rationales
must name the specific trap: wrong connotation, right meaning but wrong
register, a word that fits the sentence but not the logical signpost, an
inference the passage does not support.

MULTI — select-one-or-more. Used for three-blank Text Completion, Sentence
Equivalence (pick 2 of 6), and "select all that apply" Quantitative items.

QUANT-COMPARISON — the four options are FIXED and must be exactly, in order:
"Quantity A is greater", "Quantity B is greater", "The two quantities are
equal", "The relationship cannot be determined from the information given".
Put Quantity A and Quantity B in the stem, clearly labelled. The single most
common real mistake is choosing a definite answer when a variable's sign or
range is unconstrained — build items that punish that, and say so in the
rationale for the "cannot be determined" option.

NUMERIC — the student types an exact answer. Give the answer in the "answer"
field as a plain number or a fraction like "3/8". No options.

Rules for every type:
- Difficulty should sit at the level that actually discriminates: roughly the
  medium-to-hard band. Trivially easy items waste a review slot.
- Never write an item whose correct answer depends on knowledge outside the
  GRE's scope (no calculus, no trigonometry beyond basic right triangles, no
  outside-world facts for Reading Comprehension).
- Quantitative items must be solvable without a calculator in about 1.5
  minutes, or state that the on-screen calculator is expected.
- Show the working in the correct option's rationale, not just the answer.`;

/**
 * Only use content supported by the source text; the shared instruction that
 * keeps generation honest for both tracks.
 */
const COMMON_RULES = `
Rules:
- Only use content supported by the source text. Do not add facts from general
  knowledge to fill a quota — returning fewer cards is correct and expected.
- Mark "confidence" as low if the source is ambiguous on that point. A human
  reviews every card and needs to know where to look hardest.
- Assign the content domain to each card individually rather than blanket-tagging
  the batch. One passage often spans domains.
- Respond with a single JSON object and nothing else. No preamble, no markdown
  fences, no commentary.`;

/** The JSON shape, described in prose because not every provider enforces schemas. */
function shapeFor(track) {
  const t = TRACKS[track];
  return `Respond with JSON of exactly this shape:
{
  "cards": [
    {
      "kind": one of ${t.kinds.map((k) => `"${k}"`).join(' | ')},
      "domain": one of ${t.domains.map((d) => `"${d}"`).join(' | ')},
      "confidence": "high" | "medium" | "low",
      "front": string,   // recall only
      "back": string,    // recall only
      "stem": string,    // every non-recall kind
      "options": [ { "text": string, "correct": boolean, "rationale": string } ],
      "answer": string   // numeric only
    }
  ],
  "notes": string
}`;
}

/**
 * @param {{ text: string, course?: string, domain: string, topic?: string,
 *           count?: number, source?: string, track?: string }} req
 * @returns {Promise<{ cards: any[], warnings: string[], model: string, provider: string, usage: any }>}
 */
async function generateCards(req) {
  const track = req.track === 'gre' ? 'gre' : 'dpt';
  const spec = TRACKS[track];

  const text = String(req.text || '').trim();
  if (text.length < 40) {
    const err = new Error('source text is too short to generate from');
    err.status = 400;
    throw err;
  }
  if (!spec.domains.includes(req.domain)) {
    const err = new Error(`unknown ${track} domain '${req.domain}'`);
    err.status = 400;
    throw err;
  }

  const count = Math.min(Math.max(Number(req.count) || 10, 1), 30);

  const user = [
    `Generate up to ${count} cards from the source text below.`,
    track === 'gre'
      ? `Primary content domain: "${req.domain}".` +
        (req.topic ? ` Topic: "${req.topic}".` : '')
      : `The student tagged this passage as course "${req.course}" and primary domain "${req.domain}"` +
        (req.topic ? `, topic "${req.topic}"` : '') + '.',
    `Use "${req.domain}" as the domain unless a specific card clearly belongs elsewhere — then tag it accurately.`,
    '',
    shapeFor(track),
    COMMON_RULES,
    '',
    '--- SOURCE TEXT ---',
    text.slice(0, 40000),
    '--- END SOURCE TEXT ---',
  ].join('\n');

  let resp;
  try {
    resp = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: track === 'gre' ? GRE_SYSTEM : DPT_SYSTEM },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.4,
      max_tokens: 8000,
    });
  } catch (e) {
    const err = new Error(`LLM request failed (${provider}): ${e.message}`);
    err.status = e.status && e.status < 500 ? 400 : 502;
    throw err;
  }

  const raw = resp?.choices?.[0]?.message?.content;
  if (!raw) {
    const err = new Error('model returned no content');
    err.status = 502;
    throw err;
  }

  let parsed;
  try {
    // Some providers still wrap JSON in a fence despite response_format.
    const cleaned = String(raw).trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    parsed = JSON.parse(cleaned);
  } catch (e) {
    const err = new Error('model returned unparseable JSON');
    err.status = 502;
    throw err;
  }

  const warnings = [];
  const cards = [];

  for (const [i, rawCard] of (parsed.cards || []).entries()) {
    const problems = validateGenerated(rawCard, i, spec);
    if (problems.length) { warnings.push(...problems); continue; }

    const card = {
      kind: rawCard.kind,
      track,
      domain: rawCard.domain,
      ...(req.course ? { course: req.course } : {}),
      ...(req.topic ? { topic: req.topic } : {}),
      ...(req.source ? { source: { text: req.source } } : {}),
      provenance: 'generated',
      // Never true. The review queue is the only path into the deck.
      verified: false,
      tags: rawCard.confidence === 'low' ? ['needs-check'] : [],
    };

    if (rawCard.kind === 'recall') {
      card.front = rawCard.front;
      card.back = rawCard.back;
    } else if (rawCard.kind === 'numeric') {
      card.stem = rawCard.stem;
      card.answer = String(rawCard.answer);
      if (rawCard.options?.[0]?.rationale) card.explanation = rawCard.options[0].rationale;
      else if (rawCard.explanation) card.explanation = rawCard.explanation;
    } else {
      card.stem = rawCard.stem;
      card.options = rawCard.options;
    }

    cards.push(card);
  }

  if (parsed.notes) warnings.push(`model notes: ${parsed.notes}`);

  return { cards, warnings, model, provider, usage: resp.usage };
}

/** The four fixed Quantitative Comparison options, in ETS order. */
const QC_OPTIONS = [
  'quantity a is greater',
  'quantity b is greater',
  'the two quantities are equal',
  'the relationship cannot be determined from the information given',
];

/**
 * Server-side validation. Mirrors the client's rules so a malformed card is
 * dropped here with a reason rather than travelling to the browser to fail.
 */
function validateGenerated(raw, i, spec) {
  const p = [];
  const at = `card ${i + 1}`;

  if (!raw || typeof raw !== 'object') return [`${at}: not an object`];
  if (!spec.domains.includes(raw.domain)) p.push(`${at}: missing or unknown domain`);
  if (!spec.kinds.includes(raw.kind)) {
    p.push(`${at}: unknown kind '${raw.kind}'`);
    return p;
  }

  if (raw.kind === 'recall') {
    if (!raw.front?.trim()) p.push(`${at}: recall card has no front`);
    if (!raw.back?.trim()) p.push(`${at}: recall card has no back`);
    return p;
  }

  if (!raw.stem?.trim()) p.push(`${at}: ${raw.kind} has no stem`);

  if (raw.kind === 'numeric') {
    if (raw.answer === undefined || String(raw.answer).trim() === '') {
      p.push(`${at}: numeric item has no answer`);
    }
    return p;
  }

  if (!Array.isArray(raw.options)) {
    p.push(`${at}: ${raw.kind} needs an options array`);
    return p;
  }

  const wanted = spec.optionCount[raw.kind];
  if (wanted && raw.options.length !== wanted) {
    p.push(`${at}: ${raw.kind} needs exactly ${wanted} options (got ${raw.options.length})`);
  }
  if (raw.kind === 'multi' && (raw.options.length < 3 || raw.options.length > 8)) {
    p.push(`${at}: multi needs 3-8 options (got ${raw.options.length})`);
  }

  const correct = raw.options.filter((o) => o && o.correct === true).length;
  if (raw.kind === 'multi') {
    if (correct < 1) p.push(`${at}: multi needs at least one correct option`);
  } else if (correct !== 1) {
    p.push(`${at}: ${raw.kind} needs exactly 1 correct option (got ${correct})`);
  }

  // Quantitative Comparison options are fixed text in a fixed order. A model
  // that paraphrases them produces an item that looks right and trains the
  // wrong recognition, so the wording is checked rather than trusted.
  if (raw.kind === 'quant-comparison') {
    const got = raw.options.map((o) => String(o?.text ?? '').trim().toLowerCase().replace(/\.$/, ''));
    for (let k = 0; k < QC_OPTIONS.length; k++) {
      if (got[k] !== QC_OPTIONS[k]) {
        p.push(`${at}: quant-comparison option ${k + 1} must read "${QC_OPTIONS[k]}" (got "${got[k] ?? ''}")`);
      }
    }
  }

  raw.options.forEach((o, k) => {
    if (!o?.text?.toString().trim()) p.push(`${at}: option ${k + 1} has no text`);
    // The distractor rationales are the learning. An item without them teaches
    // nothing, so it is dropped rather than imported.
    if (!o?.rationale?.toString().trim()) p.push(`${at}: option ${k + 1} has no rationale`);
  });

  return p;
}

module.exports = { generateCards, TRACKS, DPT_DOMAINS, GRE_DOMAINS, QC_OPTIONS, model, provider };
