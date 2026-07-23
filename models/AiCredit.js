/**
 * AiCredit — a single running ledger of the AI budget that keeps the platform's
 * generation running (LLM API credits at the provider).
 *
 * The admin loads credits when they top up the provider; the system draws them
 * down using the real, tracked AI spend (AiUsage.costUsd). Because AiUsage has
 * counted cost since before credit-tracking began, we freeze that historical
 * total in `anchorCostUsd` the first time credits are set, and only count spend
 * ACCRUED AFTER the anchor. So:
 *
 *   spentSinceAnchor = AiUsage.costUsd - anchorCostUsd
 *   remaining        = loaded - spentSinceAnchor
 *
 * Singleton document keyed 'global'.
 */

const mongoose = require('mongoose');

const aiCreditSchema = new mongoose.Schema({
  key: { type: String, unique: true, default: 'global' },

  // Total dollars of credit the admin has loaded (sum of top-ups / set-balances).
  loaded: { type: Number, default: 0 },

  // AiUsage.costUsd captured when credit tracking started (or was reconciled).
  // Spend before this point is historical and does not draw down the balance.
  anchorCostUsd: { type: Number, default: null },
  anchorAt: { type: Date, default: null },

  // Cumulative cost of Lab reel renders (WaveSpeed video) since the anchor.
  // Rolls into total spend alongside LLM cost. Reset on set-balance.
  labCostUsd: { type: Number, default: 0 },

  // Warn when remaining falls at/below this many dollars.
  lowThresholdUsd: { type: Number, default: 10 },

  // Audit trail of adjustments.
  history: [{
    type: { type: String, enum: ['load', 'set-balance', 'threshold', 'reconcile'], default: 'load' },
    amount: Number,        // dollars added (load) or the new balance (set-balance)
    note: String,
    balanceAfter: Number,  // computed remaining right after the change
    at: { type: Date, default: Date.now }
  }]
}, { timestamps: true });

module.exports = mongoose.model('AiCredit', aiCreditSchema);
