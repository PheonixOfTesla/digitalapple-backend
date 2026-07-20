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

module.exports = {
  client,
  model,
  provider: providerName
};
