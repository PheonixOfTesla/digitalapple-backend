/**
 * AI Client Provider Module
 *
 * Single source of truth for LLM client configuration.
 * Supports Moonshot Kimi and OpenAI as providers.
 * All blueprint LLM calls go through this module.
 */

const OpenAI = require('openai');

// Provider configurations
const providers = {
  moonshot: {
    key: process.env.MOONSHOT_API_KEY,
    baseURL: 'https://api.moonshot.ai/v1'
  },
  openai: {
    key: process.env.OPENAI_API_KEY,
    baseURL: undefined
  }
};

// Select provider from env, default to moonshot
const providerName = process.env.AI_PROVIDER || 'moonshot';
const providerConfig = providers[providerName] || providers.moonshot;

// Model from env (required)
const model = process.env.AI_MODEL;

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
