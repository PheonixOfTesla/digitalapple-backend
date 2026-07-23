/**
 * aiUsage - record + read real LLM token usage/cost.
 * Fire-and-forget recording: logging must NEVER break a generation call.
 */

const AiUsage = require('../models/AiUsage');

// USD per 1M tokens [input, output]. Env overrides win so you can set exact prices.
function rates(model) {
  const envIn = parseFloat(process.env.AI_PRICE_IN_PER_M);
  const envOut = parseFloat(process.env.AI_PRICE_OUT_PER_M);
  if (Number.isFinite(envIn) && Number.isFinite(envOut)) return [envIn, envOut];
  const T = {
    'kimi-k2.6': [0.60, 2.50],
    'kimi-k2': [0.60, 2.50],
    'gpt-4o-mini': [0.15, 0.60],
    'gpt-4o': [2.50, 10.00],
    'gpt-4.1-mini': [0.40, 1.60]
  };
  return T[model] || [0.30, 1.20];
}

function estimateCost(model, inTok, outTok) {
  const [i, o] = rates(model);
  return (inTok / 1e6) * i + (outTok / 1e6) * o;
}

async function record({ model, promptTokens = 0, completionTokens = 0, costUsd = null }) {
  try {
    const cost = costUsd == null ? estimateCost(model, promptTokens, completionTokens) : costUsd;
    await AiUsage.updateOne(
      { key: 'global' },
      {
        $inc: {
          calls: 1,
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
          costUsd: cost
        },
        $set: { lastCallAt: new Date() }
      },
      { upsert: true }
    );
  } catch (e) {
    // swallow — usage logging is best-effort
  }
}

async function getTotals() {
  try { return await AiUsage.findOne({ key: 'global' }).lean(); }
  catch (e) { return null; }
}

module.exports = { record, getTotals, estimateCost, rates };
