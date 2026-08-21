/**
 * AI Client Provider Module
 *
 * Single source of truth for LLM client configuration.
 * Supports Moonshot Kimi and OpenAI as providers.
 * All blueprint LLM calls go through this module.
 */

const OpenAI = require('openai');

// Provider configurations with default models
const providers = {
  moonshot: {
    key: process.env.MOONSHOT_API_KEY,
    baseURL: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k2.6'
  },
  openai: {
    key: process.env.OPENAI_API_KEY,
    baseURL: undefined,
    defaultModel: 'gpt-4o-mini'
  },
  // OpenRouter speaks the OpenAI wire format, so it needs no client of its own —
  // only a base URL and a key. Its free tier is the point: `:free` models cost
  // nothing and are rate-limited rather than billed, which suits a grader that runs
  // only on answers the offline scorer already failed.
  //
  // The default is pinned rather than left to OpenRouter's routing so a deploy
  // cannot silently change what grades a student. Override with AI_MODEL.
  openrouter: {
    key: process.env.OPENROUTER_API_KEY,
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free'
  }
};

// Select provider from env, default to openai (more reliable for structured output)
const providerName = process.env.AI_PROVIDER || 'openai';
const providerConfig = providers[providerName] || providers.openai;

// Model from env, or use provider's default
const model = process.env.AI_MODEL || providerConfig.defaultModel;

// Create OpenAI-compatible client with provider config
const client = new OpenAI({
  apiKey: providerConfig.key,
  baseURL: providerConfig.baseURL
});

// Boot log - exactly one line with provider, model, and key presence
console.log(
  `[AI] provider=${providerName} model=${model || '(not set)'} ` +
  `key_present=${!!providerConfig.key}`
);

// ── Real token-usage tracking ──────────────────────────────────────────────
// Wrap chat.completions.create ONCE so every LLM call across the app records its
// actual prompt/completion tokens + cost. Best-effort: wrapping and logging never
// break a generation call.
try {
  const completions = client.chat && client.chat.completions;
  if (completions && typeof completions.create === 'function') {
    const _create = completions.create.bind(completions);
    completions.create = async function (...args) {
      const resp = await _create(...args);
      try {
        const u = resp && resp.usage;
        if (u && (u.prompt_tokens || u.completion_tokens)) {
          const mdl = (args[0] && args[0].model) || model;
          // Lazy require avoids a load-order cycle with the model layer.
          require('./aiUsage').record({
            model: mdl,
            promptTokens: u.prompt_tokens || 0,
            completionTokens: u.completion_tokens || 0
          });
        }
      } catch (_) { /* never let usage logging break a call */ }
      return resp;
    };
    console.log('[AI] token-usage tracking enabled');
  }
} catch (_) { /* leave client unwrapped if the SDK shape changes */ }

module.exports = {
  client,
  model,
  provider: providerName,
  // Whether a key was actually configured for the selected provider. Callers that
  // must fail closed rather than fire a doomed request check this first — the boot
  // log already reports it, and there is no reason each caller should re-derive it.
  hasKey: !!providerConfig.key
};
