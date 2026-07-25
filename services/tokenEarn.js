/**
 * tokenEarn — creator royalties, paid in the existing token.
 *
 * Two faucets:
 *   fork          — a registered user forks your published map (once per
 *                   forker per map, never for self-forks)
 *   video_export  — someone else pays a token to video-export your published
 *                   map (a transfer of the token they spent)
 *
 * Best-effort by design: earning must never break the action that triggered
 * it. All grants are whole tokens and land in the TokenLedger as 'earn'.
 */
const mongoose = require('mongoose');

async function earnToken({ creatorId, sourceUserId = null, kind, mapId = null, projectId = null, amount = 1 }) {
  try {
    if (!creatorId) return { earned: false, why: 'no-creator' };
    if (sourceUserId && String(creatorId) === String(sourceUserId)) {
      return { earned: false, why: 'self' };            // no royalties on your own actions
    }

    const TokenLedger = require('../models/TokenLedger');
    const User = require('../models/User');

    // Fork royalty: once per (map, forker) pair — repeat forks don't re-earn
    if (kind === 'fork' && mapId && sourceUserId) {
      const already = await TokenLedger.exists({
        userId: creatorId, reason: 'earn',
        'metadata.kind': 'fork', 'metadata.mapId': String(mapId), 'metadata.fromUserId': String(sourceUserId)
      });
      if (already) return { earned: false, why: 'duplicate' };
    }

    const updated = await User.findByIdAndUpdate(creatorId,
      { $inc: { tokenBalance: amount } }, { new: true }).select('tokenBalance').lean();
    if (!updated) return { earned: false, why: 'no-user' };

    await TokenLedger.create({
      userId: creatorId,
      delta: amount,
      reason: 'earn',
      projectId: projectId || undefined,
      balanceAfter: updated.tokenBalance,
      metadata: {
        kind,
        mapId: mapId ? String(mapId) : null,
        fromUserId: sourceUserId ? String(sourceUserId) : null
      }
    });
    return { earned: true, newBalance: updated.tokenBalance };
  } catch (e) {
    console.error('[tokenEarn] failed:', e.message);
    return { earned: false, why: e.message };
  }
}

module.exports = { earnToken };
