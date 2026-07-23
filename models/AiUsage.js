/**
 * AiUsage - cumulative real LLM token usage + cost.
 *
 * A single 'global' document, incremented atomically after each LLM call, so the
 * economics dashboard reads ONE doc for all-time-accurate AI spend. Cheap ($inc).
 */

const mongoose = require('mongoose');

const aiUsageSchema = new mongoose.Schema({
  key: { type: String, unique: true, default: 'global' },
  calls: { type: Number, default: 0 },
  promptTokens: { type: Number, default: 0 },
  completionTokens: { type: Number, default: 0 },
  totalTokens: { type: Number, default: 0 },
  costUsd: { type: Number, default: 0 },
  // last-24h rolling counters are derived from TokenLedger-style timestamps elsewhere;
  // here we keep the running total + a lastCall marker.
  lastCallAt: { type: Date }
}, { timestamps: true });

module.exports = mongoose.model('AiUsage', aiUsageSchema);
