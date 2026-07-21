/**
 * TokenController - Nebula token purchase and balance management
 *
 * Handles:
 * - Token balance queries (logged in or anon)
 * - Stripe Checkout for token pack purchases
 * - Stripe webhook for credit verification
 * - Session-to-account token claim on signup
 *
 * KEY PRINCIPLE: Buy/spend anonymously, sign up to keep.
 * Only the verified webhook grants tokens - never trust the client.
 */

const express = require('express');
const router = express.Router();
const Stripe = require('stripe');

const User = require('../models/User');
const TokenLedger = require('../models/TokenLedger');
const SessionToken = require('../models/SessionToken');
const Project = require('../models/Project');
const { optionalAuth, verifyToken } = require('../middleware/auth');
const { TOKEN_PACKS, getPack, isValidPack, getPurchasablePacks } = require('../config/tokenPricing');

// Initialize Stripe (lazy - only when needed)
let stripe = null;
function getStripe() {
  if (!stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY not configured');
    }
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2023-10-16'
    });
  }
  return stripe;
}

// ============== BALANCE ==============

/**
 * GET /tokens/balance
 * Get token balance for current user or session
 */
router.get('/balance', optionalAuth, async (req, res) => {
  try {
    let balance = 0;
    let source = 'none';

    if (req.userId) {
      // Authenticated user
      const user = await User.findById(req.userId);
      balance = user?.tokenBalance || 0;
      source = 'user';
    } else if (req.anonymousSessionId) {
      // Anonymous session
      const session = await SessionToken.findOne({
        sessionId: req.anonymousSessionId,
        claimedBy: null
      });
      balance = session?.tokenBalance || 0;
      source = 'session';
    }

    res.json({
      success: true,
      balance,
      source
    });
  } catch (error) {
    console.error('Balance check error:', error);
    res.status(500).json({ error: 'Failed to check balance' });
  }
});

/**
 * GET /tokens/packs
 * Get available token packs for purchase
 */
router.get('/packs', (req, res) => {
  res.json({
    success: true,
    packs: getPurchasablePacks(),
    note: '1 token = 1 nebula (generate, refine, expand, and scope it as much as you want)'
  });
});

// ============== CHECKOUT ==============

/**
 * POST /tokens/checkout
 * Create Stripe Checkout session for token pack purchase
 * Works for both authenticated users and anonymous sessions
 */
router.post('/checkout', optionalAuth, async (req, res) => {
  try {
    const { packId, idempotencyKey } = req.body;

    // Validate pack
    if (!isValidPack(packId)) {
      return res.status(400).json({ error: 'Invalid pack ID' });
    }

    const pack = getPack(packId);
    const stripeClient = getStripe();

    // Determine who's buying
    const userId = req.userId || null;
    const sessionId = req.anonymousSessionId || null;

    if (!userId && !sessionId) {
      return res.status(400).json({ error: 'No user or session identifier' });
    }

    // Create Stripe Checkout session
    const checkoutSession = await stripeClient.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `${pack.name} - ${pack.tokens} Nebula Tokens`,
            description: pack.description
          },
          unit_amount: pack.priceCents
        },
        quantity: 1
      }],
      metadata: {
        packId: pack.id,
        tokens: pack.tokens.toString(),
        userId: userId || '',
        sessionId: sessionId || ''
      },
      success_url: `${process.env.FRONTEND_URL}/blueprint.html?purchase=success&tokens=${pack.tokens}`,
      cancel_url: `${process.env.FRONTEND_URL}/blueprint.html?purchase=cancelled`
    }, {
      idempotencyKey: idempotencyKey || undefined
    });

    res.json({
      success: true,
      checkoutUrl: checkoutSession.url,
      sessionId: checkoutSession.id
    });
  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// ============== WEBHOOK ==============

/**
 * POST /tokens/webhook
 * Stripe webhook handler - ONLY source of token credits
 * Verifies signature, credits tokens, creates ledger entry
 * Note: Raw body parsing is handled in server.js BEFORE express.json()
 */
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET not configured');
    return res.status(500).json({ error: 'Webhook not configured' });
  }

  let event;

  try {
    event = getStripe().webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // Handle checkout.session.completed
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    try {
      await handleSuccessfulPayment(session, event.id);
      console.log(`[Tokens] Payment processed: ${session.id}`);
    } catch (err) {
      console.error('Payment processing error:', err);
      // Return 200 to prevent Stripe retries if it's a duplicate
      if (err.code === 11000) {
        console.log('[Tokens] Duplicate event ignored:', event.id);
        return res.json({ received: true, duplicate: true });
      }
      return res.status(500).json({ error: 'Payment processing failed' });
    }
  }

  res.json({ received: true });
});

/**
 * Process successful payment - credit tokens
 * Idempotent on Stripe event ID
 */
async function handleSuccessfulPayment(checkoutSession, stripeEventId) {
  const { packId, tokens, userId, sessionId } = checkoutSession.metadata;
  const tokenCount = parseInt(tokens, 10);

  if (!tokenCount || tokenCount <= 0) {
    throw new Error('Invalid token count in metadata');
  }

  // Check for duplicate (idempotency via stripeEventId index)
  const existing = await TokenLedger.findOne({ 'metadata.stripeEventId': stripeEventId });
  if (existing) {
    console.log('[Tokens] Duplicate event, skipping:', stripeEventId);
    return;
  }

  if (userId) {
    // Credit to authenticated user
    const user = await User.findByIdAndUpdate(
      userId,
      { $inc: { tokenBalance: tokenCount } },
      { new: true }
    );

    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    // Create ledger entry
    await TokenLedger.create({
      userId: user._id,
      delta: tokenCount,
      reason: 'purchase',
      balanceAfter: user.tokenBalance,
      metadata: {
        stripeEventId,
        stripeSessionId: checkoutSession.id,
        packId,
        amountPaid: checkoutSession.amount_total
      }
    });

    console.log(`[Tokens] Credited ${tokenCount} to user ${userId}, new balance: ${user.tokenBalance}`);

  } else if (sessionId) {
    // Credit to anonymous session
    const session = await SessionToken.creditTokens(sessionId, tokenCount);

    // Create ledger entry
    await TokenLedger.create({
      sessionId,
      delta: tokenCount,
      reason: 'purchase',
      balanceAfter: session.tokenBalance,
      metadata: {
        stripeEventId,
        stripeSessionId: checkoutSession.id,
        packId,
        amountPaid: checkoutSession.amount_total
      }
    });

    console.log(`[Tokens] Credited ${tokenCount} to session ${sessionId}, new balance: ${session.tokenBalance}`);

  } else {
    throw new Error('No userId or sessionId in checkout metadata');
  }
}

// ============== SPEND ==============

/**
 * Spend a token for nebula creation
 * Called internally by BlueprintController
 * Returns { success, newBalance } or { success: false, error }
 */
async function spendToken(userId, sessionId, projectId) {
  try {
    let newBalance;

    if (userId) {
      // Authenticated user - try token first, then free tier
      const user = await User.findById(userId);
      if (!user) {
        return { success: false, error: 'User not found' };
      }

      // Check if admin (exempt from spend)
      if (user.role === 'admin') {
        return { success: true, newBalance: user.tokenBalance, exempt: true };
      }

      if (user.tokenBalance > 0) {
        // Spend from token balance
        const updated = await User.findOneAndUpdate(
          { _id: userId, tokenBalance: { $gte: 1 } },
          { $inc: { tokenBalance: -1 } },
          { new: true }
        );

        if (!updated) {
          return { success: false, error: 'Insufficient tokens' };
        }

        newBalance = updated.tokenBalance;

        // Ledger entry
        await TokenLedger.create({
          userId,
          delta: -1,
          reason: 'spend',
          projectId,
          operationType: 'nebula',
          balanceAfter: newBalance,
          metadata: { action: 'nebula_creation' }
        });

        return { success: true, newBalance, source: 'tokens' };
      }

      // Fall through to free tier check in BlueprintController
      return { success: true, newBalance: 0, source: 'free_tier' };

    } else if (sessionId) {
      // Anonymous session
      const session = await SessionToken.findOne({
        sessionId,
        claimedBy: null,
        tokenBalance: { $gte: 1 }
      });

      if (!session) {
        // Check free tier in BlueprintController
        return { success: true, newBalance: 0, source: 'free_tier' };
      }

      // Spend from session balance
      const updated = await SessionToken.spendTokens(sessionId, 1);
      if (!updated) {
        return { success: false, error: 'Insufficient tokens' };
      }

      newBalance = updated.tokenBalance;

      // Ledger entry
      await TokenLedger.create({
        sessionId,
        delta: -1,
        reason: 'spend',
        projectId,
        operationType: 'nebula',
        balanceAfter: newBalance,
        metadata: { action: 'nebula_creation' }
      });

      return { success: true, newBalance, source: 'tokens' };
    }

    return { success: false, error: 'No user or session' };
  } catch (error) {
    console.error('Token spend error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Refund a token on provider failure
 */
async function refundToken(userId, sessionId, projectId, reason) {
  try {
    if (userId) {
      const user = await User.findByIdAndUpdate(
        userId,
        { $inc: { tokenBalance: 1 } },
        { new: true }
      );

      if (user) {
        await TokenLedger.create({
          userId,
          delta: 1,
          reason: 'refund',
          projectId,
          operationType: 'nebula',
          balanceAfter: user.tokenBalance,
          metadata: { refundReason: reason }
        });
        console.log(`[Tokens] Refunded 1 token to user ${userId}`);
      }
    } else if (sessionId) {
      const session = await SessionToken.creditTokens(sessionId, 1);

      await TokenLedger.create({
        sessionId,
        delta: 1,
        reason: 'refund',
        projectId,
        operationType: 'nebula',
        balanceAfter: session.tokenBalance,
        metadata: { refundReason: reason }
      });
      console.log(`[Tokens] Refunded 1 token to session ${sessionId}`);
    }
  } catch (error) {
    console.error('Token refund error:', error);
  }
}

// ============== CLAIM ==============

/**
 * POST /tokens/claim
 * Transfer session tokens to authenticated user account
 * Called after signup/login
 * Also claims any anonymous projects from that session
 */
router.post('/claim', verifyToken, async (req, res) => {
  try {
    // Accept sessionId from body or header
    const sessionId = req.body.sessionId || req.headers['x-session-id'];
    const userId = req.userId;

    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID required' });
    }

    // Find session with unclaimed tokens (any balance, including 0)
    const sessionTokens = await SessionToken.findOne({
      sessionId,
      claimedBy: null
    });

    // Check for projects even if no session token record exists
    const pendingProjects = await Project.countDocuments({
      anonymousSessionId: sessionId,
      ownerId: null
    });

    if (!sessionTokens && pendingProjects === 0) {
      return res.json({
        success: true,
        transferred: 0,
        projectsClaimed: 0,
        message: 'No tokens or projects to claim'
      });
    }

    const tokensToTransfer = sessionTokens?.tokenBalance || 0;
    let user = await User.findById(userId);

    // Transfer tokens if any
    if (tokensToTransfer > 0) {
      user = await User.findByIdAndUpdate(
        userId,
        { $inc: { tokenBalance: tokensToTransfer } },
        { new: true }
      );

      // Create ledger entries
      await TokenLedger.create({
        sessionId,
        delta: -tokensToTransfer,
        reason: 'spend', // Transfer out
        balanceAfter: 0,
        metadata: { action: 'claim_transfer_out', claimedBy: userId }
      });

      await TokenLedger.create({
        userId,
        delta: tokensToTransfer,
        reason: 'grant', // Transfer in
        balanceAfter: user.tokenBalance,
        metadata: { action: 'claim_transfer_in', fromSession: sessionId }
      });

      console.log(`[Tokens] Claimed ${tokensToTransfer} tokens from session ${sessionId} to user ${userId}`);
    }

    // Mark session as claimed (if exists)
    if (sessionTokens) {
      await SessionToken.claimToUser(sessionId, userId);
    }

    // Claim any projects from the session
    const claimedProjects = await Project.updateMany(
      { anonymousSessionId: sessionId, ownerId: null },
      { $set: { ownerId: userId, anonymousSessionId: null } }
    );

    if (claimedProjects.modifiedCount > 0) {
      console.log(`[Tokens] Claimed ${claimedProjects.modifiedCount} projects from session ${sessionId} to user ${userId}`);
    }

    res.json({
      success: true,
      transferred: tokensToTransfer,
      newBalance: user.tokenBalance,
      projectsClaimed: claimedProjects.modifiedCount
    });
  } catch (error) {
    console.error('Token claim error:', error);
    res.status(500).json({ error: 'Failed to claim tokens' });
  }
});

/**
 * GET /tokens/history
 * Get transaction history for current user
 */
router.get('/history', verifyToken, async (req, res) => {
  try {
    const history = await TokenLedger.find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    res.json({
      success: true,
      history
    });
  } catch (error) {
    console.error('History error:', error);
    res.status(500).json({ error: 'Failed to get history' });
  }
});

// Export for use in other controllers
module.exports = router;
module.exports.spendToken = spendToken;
module.exports.refundToken = refundToken;
