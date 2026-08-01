/**
 * payouts — one Stripe Express account per member, one set of rules.
 *
 * A member has ONE bank connection, and everything they can be paid for runs
 * through it: ticket sales, paid Studio doors, anything that comes later.
 * Connecting it for an event must mean it is connected for a gated room, or
 * somebody ends up doing the same onboarding twice and wondering why.
 *
 * This existed as two near-identical copies — one in EventController keyed on
 * a user id, one in StudioController keyed on a conversation — which is how a
 * rule quietly becomes two rules. Same account, same check, one place.
 *
 * TWO DIFFERENT QUESTIONS, deliberately kept apart:
 *
 *   payoutDest()    can money be routed right now? A yes/no on
 *                   `transfers === 'active'`, which is what Stripe needs to
 *                   accept a destination charge. The right test for a charge.
 *
 *   payoutStatus()  WHY not, in terms a person can act on. Stripe flips
 *                   `transfers` some time AFTER onboarding is submitted, so
 *                   using the yes/no to answer "has this person connected a
 *                   bank" tells someone who just handed over their details
 *                   that they have not. That was a real bug; this is the fix.
 */
const User = require('../models/User');

function stripe() {
  const Stripe = require('stripe');
  return new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
}

/** Stripe's requirement keys, in English. */
function humanRequirement(key) {
  const k = String(key || '');
  if (/verification\.document/.test(k)) return 'a photo of your ID';
  if (/external_account/.test(k)) return 'your bank account details';
  if (/tax_id|ssn_last_4|id_number/.test(k)) return 'your tax or ID number';
  if (/dob/.test(k)) return 'your date of birth';
  if (/address/.test(k)) return 'your address';
  if (/phone/.test(k)) return 'a phone number';
  if (/email/.test(k)) return 'an email address';
  if (/url|business_profile/.test(k)) return 'a few business details';
  if (/name/.test(k)) return 'your name';
  return k.replace(/[._]/g, ' ');
}

/**
 * The connected account to send this member's share to, or null to let it fall
 * to the platform. Null is a real answer — callers decide whether to refuse the
 * sale or take it themselves.
 */
async function payoutDest(userId) {
  try {
    if (!userId) return null;
    const u = await User.findById(userId).select('stripeAccountId').lean();
    if (!u || !u.stripeAccountId) return null;
    const acct = await stripe().accounts.retrieve(u.stripeAccountId);
    if (acct && acct.capabilities && acct.capabilities.transfers === 'active') return u.stripeAccountId;
  } catch (e) { /* fall back to platform */ }
  return null;
}

/**
 * Four states, four different sentences, one of which is an action:
 *   none        no account at all — start
 *   incomplete  Stripe wants more, and `needs` says what
 *   pending     everything is in, Stripe is checking — nothing to do
 *   ready       sell
 *   unknown     Stripe was unreachable. NOT the same as none: telling a
 *               connected member they have no bank because an API call timed
 *               out invites them to redo work they already did.
 */
async function payoutStatus(userId) {
  try {
    if (!userId) return { state: 'none', needs: [] };
    const u = await User.findById(userId).select('stripeAccountId').lean();
    if (!u || !u.stripeAccountId) return { state: 'none', needs: [] };
    const acct = await stripe().accounts.retrieve(u.stripeAccountId);
    if (!acct) return { state: 'none', needs: [] };

    if (acct.capabilities && acct.capabilities.transfers === 'active') {
      return { state: 'ready', needs: [], payoutsEnabled: !!acct.payouts_enabled };
    }
    const req = acct.requirements || {};
    const due = [].concat(req.currently_due || [], req.past_due || []);
    if (!acct.details_submitted || due.length) {
      return { state: 'incomplete', needs: due.slice(0, 6).map(humanRequirement) };
    }
    return { state: 'pending', needs: [], disabledReason: req.disabled_reason || null };
  } catch (e) {
    console.error('payout status:', e.message);
    return { state: 'unknown', needs: [] };
  }
}

module.exports = { payoutDest, payoutStatus, humanRequirement };
