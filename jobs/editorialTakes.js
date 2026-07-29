/**
 * Editorial takes — openly-attributed Clockwork house assessments for the
 * best-known companies in the directory.
 *
 * These are NOT user reviews and are never counted in any rating. They render
 * under a "Clockwork editorial" byline with a date. The claims are limited to
 * well-documented public facts and clearly-framed opinion, so every line is
 * defensible. Real credibility comes from three legs together:
 *   1. signed-in Clockwork user reviews (the rating backbone),
 *   2. linked external review sources (Trustpilot by domain — real pages),
 *   3. these editorial takes, plainly labeled as the house voice.
 *
 * applyEditorialTakes() is idempotent: it only fills companies whose editorial
 * is empty, matching by exact name (case-insensitive). Safe to run at boot.
 */
const Company = require('../models/Company');

const TAKES = {
  'OpenAI': 'The company that made AI a consumer product. ChatGPT remains the default entry point to AI for most people, and the API powers a huge share of the ecosystem. Trade-offs to weigh: cloud-only deployment, a fast-shifting product surface, and data-policy terms that deserve a careful read for business use.',
  'Anthropic': 'Maker of Claude and unusually explicit about safety as a product feature. Strong at long-context work, writing, and coding; enterprise-friendly terms. Cloud-only — if you need on-device AI this is not that. Full disclosure: DigitalApple builds on multiple providers, including Anthropic.',
  'Google DeepMind': 'The deepest research bench in the field — AlphaFold won a Nobel Prize, and Gemini ships to billions through Search, Android, and Workspace. The strength is distribution and research depth; the recurring critique is product churn and naming whiplash.',
  'Meta': 'The open-weights standard-bearer: Llama models made serious AI runnable outside big-cloud walls, which reshaped the whole market. Meta AI the assistant is more contested — it ships to billions inside Meta apps whether asked for or not.',
  'Microsoft': 'Copilot is the widest enterprise AI rollout in the world, riding Office and Windows distribution. If your organization lives in Microsoft 365, it is the path of least resistance; the honest question is whether the per-seat price earns its keep for every seat.',
  'Apple': 'Apple Intelligence is the biggest bet on ON-DEVICE AI from any major — private by architecture, not by policy. Rollout has been slower and narrower than the demos suggested; the direction (local first, cloud only with consent) is one we consider correct.',
  'NVIDIA': 'The company the whole AI boom runs on. CUDA is the real moat — a software lock-in measured in developer-years, not chips. For buyers the practical note is simple: almost every model you use was trained on their hardware.',
  'Amazon': 'AWS Bedrock is the neutral aisle of the model supermarket — one contract, many models, your VPC. Alexa+ is the consumer bet. The strength is procurement pragmatism rather than frontier research.',
  'Mistral AI': 'Europe\'s frontier lab, and the strongest proof that small teams can still ship competitive open-weight models. Attractive for self-hosting and EU data-residency needs; the ecosystem around it is thinner than the US giants\'.',
  'Perplexity': 'Made AI search mainstream: answers with citations you can actually check. Fast product cadence. It has taken public criticism from publishers over crawling and attribution — worth knowing when you cite it in professional work.',
  'Hugging Face': 'The GitHub of machine learning — the place open models, datasets, and demos actually live. Indispensable infrastructure for anyone self-hosting. It is a platform, not a model vendor; quality varies by what you pull from it.',
  'Midjourney': 'Still the aesthetic benchmark for image generation. Community-driven, opinionated, and famously Discord-first (a web app now exists). No API remains the biggest limitation for production use.',
  'Stability AI': 'Stable Diffusion put image generation on consumer hardware and spawned an entire open ecosystem. The company itself has been through funding and leadership turbulence — the models\' openness is the durable contribution.',
  'ElevenLabs': 'The current bar for synthetic voice — cloning and multilingual output that regularly passes casual listening. That power cuts both ways; voice-consent policy matters, and their safeguards have had to evolve in public.',
  'xAI': 'Grok ships fast and speaks with fewer guardrails than its peers, integrated tightly with X. Compute scale (Colossus) is real. The editorial caution: moderation philosophy is a genuine differentiator here — decide if it fits your use.',
  'Cohere': 'The quiet enterprise specialist: retrieval-focused models, private deployment options, and pricing aimed at production workloads rather than consumer buzz. Rarely the headline, often the sensible B2B choice.'
};

async function applyEditorialTakes() {
  let applied = 0;
  for (const [name, take] of Object.entries(TAKES)) {
    try {
      const r = await Company.updateOne(
        {
          name: { $regex: '^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', $options: 'i' },
          $or: [{ 'editorial.take': { $exists: false } }, { 'editorial.take': null }, { 'editorial.take': '' }]
        },
        { $set: { editorial: { take, byline: 'Clockwork editorial', updatedAt: new Date() } } }
      );
      if (r.modifiedCount) applied++;
    } catch (e) { /* per-company failures never block the rest */ }
  }
  return { applied, available: Object.keys(TAKES).length };
}

module.exports = { applyEditorialTakes, TAKES };
