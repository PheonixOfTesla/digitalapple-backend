/**
 * Semantic grading for typed study answers.
 *
 * WHY THIS EXISTS. The study app grades typed recall by counting words in common
 * with the card. That is fast, works offline, and is wrong in one specific way: a
 * correct answer phrased in the learner's own words shares little vocabulary with
 * the card and scores as a miss. A real student hit this on an algebra card, wrote
 * a textbook-correct statement, and was told they were half right.
 *
 * WHAT IT IS ALLOWED TO DO. It is consulted ONLY for answers the offline scorer has
 * already failed, and it may then re-rank that answer — including upward past the
 * pass bar. It never sees an answer that already passed, so it cannot take a pass
 * away. That asymmetry is deliberate: the offline path stays the floor, so a session
 * on a train and a session on wifi can never contradict each other about work
 * already banked.
 *
 * WHAT IT MUST NOT DO. It must not be trusted to fail soft-open. Every failure —
 * no key, rate limit, timeout, malformed JSON, a verdict outside the enum — returns
 * `null`, and the caller keeps the offline grade. A grader that guesses when the
 * model is unreachable would put noise into a retention history that is supposed to
 * mean something.
 */

const ai = require('./aiClient');

/** Hard ceiling on a call. The UI shows the offline grade immediately and upgrades
 *  in place, so a slow model costs nothing but a late correction — but an unbounded
 *  request would hold a socket open for as long as the provider feels like it. */
const TIMEOUT_MS = 12000;

/** Answers longer than this are truncated. A study answer is a sentence or three;
 *  anything past this is paste, and paste is not what is being measured. */
const MAX_CHARS = 1200;

const VERDICTS = new Set(['exact', 'close', 'partial', 'miss', 'backwards']);

const SYSTEM = [
  'You grade a student\'s typed recall of a single flashcard, for a physical-therapy',
  'prerequisite course. You are given the QUESTION, the card\'s EXPECTED answer, and',
  'the STUDENT answer.',
  '',
  'Grade the MEANING, not the wording. A student who states the same fact in their own',
  'words is correct. Spelling, grammar and typos are irrelevant. Do not require the',
  'card\'s vocabulary.',
  '',
  'Grade against what the QUESTION asked. A card may ask for a definition, for what the',
  'concept is confused with, or for an example. An answer that is true and well-stated',
  'but answers a different one of those is NOT close — say so in `why`.',
  '',
  'Verdicts:',
  '  exact     - the fact, complete and correct',
  '  close     - correct, with a minor part missing or imprecise',
  '  partial   - some of the fact, with a substantive part missing',
  '  miss      - does not answer the question, or is wrong',
  '  backwards - states the opposite of the fact, or reverses a direction/order',
  '',
  'Reply with ONLY a JSON object, no prose and no code fence:',
  '{"verdict":"...","confidence":0.0-1.0,"why":"one short sentence, max 20 words"}',
].join('\n');

/**
 * @param {{question?: string, expected: string, answer: string}} input
 * @returns {Promise<{verdict: string, confidence: number, why: string, model: string}|null>}
 *   null whenever the grade cannot be trusted — the caller keeps its own.
 */
async function gradeAnswer({ question, expected, answer }) {
  const student = String(answer ?? '').trim().slice(0, MAX_CHARS);
  const card = String(expected ?? '').trim().slice(0, MAX_CHARS);
  // Nothing to grade is not a grading failure, but it is not a grade either.
  if (!student || !card) return null;
  if (!ai.hasKey) return null;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const resp = await ai.client.chat.completions.create({
      model: ai.model,
      // Deterministic: the same answer must not grade differently on a retry, or the
      // retention history records the weather rather than the student.
      temperature: 0,
      max_tokens: 160,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: `QUESTION: ${String(question ?? '(not given)').slice(0, 400)}\n\n`
            + `EXPECTED: ${card}\n\nSTUDENT: ${student}`,
        },
      ],
    }, { signal: ac.signal });

    const raw = resp?.choices?.[0]?.message?.content;
    if (!raw) return null;

    // Some free models fence the JSON however firmly they are told not to.
    const text = String(raw).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    let parsed;
    try { parsed = JSON.parse(text); } catch { return null; }

    const verdict = String(parsed?.verdict ?? '').toLowerCase().trim();
    if (!VERDICTS.has(verdict)) return null;

    const rawConf = Number(parsed?.confidence);
    const confidence = Number.isFinite(rawConf) ? Math.min(1, Math.max(0, rawConf)) : 0.5;

    return {
      verdict,
      confidence,
      why: String(parsed?.why ?? '').trim().slice(0, 200),
      model: ai.model,
    };
  } catch {
    // Abort, rate limit, network, provider outage. All the same to the caller.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { gradeAnswer, TIMEOUT_MS, VERDICTS };
