/**
 * Study endpoints.
 *
 * One route so far: semantic grading of a typed recall answer, for the study app's
 * offline word-overlap scorer to fall back on when it fails an answer.
 *
 * THE KEY LIVES HERE AND ONLY HERE. student.html is a static page served from
 * Vercel; anything it holds is readable in devtools, so an OpenRouter or OpenAI key
 * cannot go near it. The browser calls this route, this route calls the provider,
 * and the key stays a Railway environment variable. That is also why the study page
 * needs no CSP change: it already talks to this backend.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { verifyToken } = require('../middleware/auth');
const { gradeAnswer } = require('../services/studyGrader');
const ai = require('../services/aiClient');

const router = express.Router();

/**
 * Per-user, not per-IP: this sits behind auth, and a shared campus NAT should not
 * let one student's revision session exhaust everyone else's grading.
 *
 * Sized under a free tier's typical ~20/min. A learner answering faster than this is
 * not being slowed down in any way they can feel — the offline grade is already on
 * screen and the AI only ever upgrades it in place.
 */
const gradeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.id ?? req.ip),
  message: { ok: false, reason: 'rate-limited' },
});

/**
 * Is semantic grading available at all?
 *
 * The study app asks once at boot so it can decide whether to offer the feature,
 * rather than discovering it is unconfigured one failed answer at a time. Reports
 * the provider and model but never the key, and never whether the key is VALID —
 * that is only knowable by spending a request.
 */
router.get('/grade/status', verifyToken, (req, res) => {
  res.json({ ok: true, available: !!ai.hasKey, provider: ai.provider, model: ai.model });
});

/**
 * Grade one typed answer.
 *
 * Deliberately stateless and deliberately not persisted. The app owns the learner's
 * scheduling history in IndexedDB on their own device; this route is a judgement
 * about one string, and storing a copy of every answer a student types would be
 * collecting a study diary nobody asked for.
 *
 * `ok: false` is the normal, expected outcome whenever the grade cannot be trusted —
 * no key, rate limit, timeout, a model that returned something unparseable. The
 * client keeps its own offline grade in every one of those cases, so this route
 * never needs to guess.
 */
router.post('/grade', verifyToken, gradeLimiter, async (req, res) => {
  const { question, expected, answer } = req.body ?? {};
  if (typeof expected !== 'string' || typeof answer !== 'string') {
    return res.status(400).json({ ok: false, reason: 'expected and answer must be strings' });
  }
  if (!ai.hasKey) return res.json({ ok: false, reason: 'not-configured' });

  try {
    const grade = await gradeAnswer({ question, expected, answer });
    if (!grade) return res.json({ ok: false, reason: 'unavailable' });
    return res.json({ ok: true, ...grade });
  } catch (err) {
    // A grader that 500s would show the learner an error over an answer they have
    // already been graded on locally. Report the failure as a non-grade instead.
    console.error('[study/grade]', err?.message || err);
    return res.json({ ok: false, reason: 'error' });
  }
});

module.exports = router;
