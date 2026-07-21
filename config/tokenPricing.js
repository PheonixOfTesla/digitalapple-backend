/**
 * Token Pricing Configuration
 *
 * Nebula Tokens: 1 token = 1 nebula (generate + unlimited refine/expand/scope)
 * Anyone can buy/spend without account. Persistence gates on auth.
 */

const TOKEN_PACKS = {
  starter: {
    id: 'starter',
    name: 'Starter',
    tokens: 10,
    priceUsd: 9,
    priceCents: 900,
    description: 'Get started with 10 nebulas'
  },
  builder: {
    id: 'builder',
    name: 'Builder',
    tokens: 50,
    priceUsd: 29,
    priceCents: 2900,
    description: 'Build out your ideas with 50 nebulas'
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    tokens: 200,
    priceUsd: 79,
    priceCents: 7900,
    description: 'Full creative freedom with 200 nebulas'
  }
};

// Subscription (stubbed for later)
const SUBSCRIPTIONS = {
  cartographer: {
    id: 'cartographer',
    name: 'Cartographer',
    priceUsd: 20,
    interval: 'month',
    tokensPerMonth: 30,
    description: '~30 nebulas/month',
    status: 'coming_soon' // Not purchasable yet
  }
};

// Token economics
const TOKEN_COSTS = {
  nebula: 1,        // 1 token to create a new nebula
  refine: 0,        // Free on owned nebula
  expand: 0,        // Free on owned nebula
  scope: 0,         // Free on owned nebula
  chat: 0           // Free on owned nebula
};

// Free tier limits (before requiring purchase)
const FREE_TIER = {
  authenticated: {
    projects: 3,           // 3 free nebulas lifetime
    unitsPerProject: 5     // 5 refine/expand ops per free project
  },
  anonymous: {
    projects: 1,           // 1 free nebula per session
    unitsPerProject: 5
  }
};

module.exports = {
  TOKEN_PACKS,
  SUBSCRIPTIONS,
  TOKEN_COSTS,
  FREE_TIER,

  // Helper to get pack by ID
  getPack: (packId) => TOKEN_PACKS[packId] || null,

  // Helper to validate pack ID
  isValidPack: (packId) => Object.keys(TOKEN_PACKS).includes(packId),

  // Get all purchasable packs
  getPurchasablePacks: () => Object.values(TOKEN_PACKS)
};
