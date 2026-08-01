/**
 * Ticket — one admission, issued after payment (or instantly, if free).
 *
 * IDENTITY: email is the anchor, userId is optional.
 *
 * Requiring a Hub account before someone can buy a ticket to a Friday show is
 * how you lose the sale. So the buyer's email — which Stripe always gives us —
 * is what a ticket belongs to, and userId is filled in when the buyer happens
 * to be signed in, or later when someone signs up with that address and claims
 * it. Tightening this to accounts-only later is easy; loosening it after real
 * tickets exist is not.
 *
 * SCANNING: `code` is what the door reads. It is not the _id — an ObjectId is
 * sequential enough to guess neighbours from, and a ticket is a bearer
 * instrument. It is random, unique, and the only thing needed to admit someone.
 */
const crypto = require('crypto');
const mongoose = require('mongoose');

const ticketSchema = new mongoose.Schema({
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
  tierId: { type: mongoose.Schema.Types.ObjectId, required: true },
  tierName: { type: String, trim: true, maxlength: 60 },   // snapshot: tiers get renamed

  // Who holds it. See the identity note above.
  email: { type: String, trim: true, lowercase: true, required: true, index: true },
  name: { type: String, trim: true, maxlength: 120 },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

  // The bearer token the scanner reads.
  code: { type: String, unique: true, required: true, index: true },

  // valid → used at the door. refunded/void keep the row: a vanished ticket is
  // impossible to reason about when a buyer turns up saying they paid.
  status: { type: String, enum: ['valid', 'used', 'refunded', 'void'], default: 'valid', index: true },
  scannedAt: { type: Date, default: null },
  scannedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // What was actually charged, snapshotted. Rates change; a ticket sold last
  // month must still reconcile against what it cost then.
  pricePaidCents: { type: Number, default: 0, min: 0 },
  serviceFeeCents: { type: Number, default: 0, min: 0 },
  hostPayoutCents: { type: Number, default: 0, min: 0 },

  // Stripe's session id. THIS is the idempotency guard: Stripe retries
  // webhooks, and a duplicate delivery must not mint a second ticket for one
  // payment. The database refuses it rather than the handler remembering to.
  //
  // NO `default: null`, and a PARTIAL index rather than a sparse one. A sparse
  // unique index only skips documents where the field is ABSENT — a stored
  // null still collides. With a default of null every free ticket would write
  // an explicit null, and the second free ticket ever sold would be rejected as
  // a duplicate. Free events would have broken after exactly one sale.
  stripeSessionId: { type: String },
  paymentIntentId: { type: String, default: null, index: true },

  createdAt: { type: Date, default: Date.now }
});

// The two reads the door and the buyer make.
ticketSchema.index({ eventId: 1, status: 1 });
ticketSchema.index({ email: 1, createdAt: -1 });

// One ticket per Stripe session — enforced only over documents that actually
// have one, so unlimited free tickets coexist with paid-ticket idempotency.
ticketSchema.index(
  { stripeSessionId: 1 },
  { unique: true, partialFilterExpression: { stripeSessionId: { $type: 'string' } } }
);

/**
 * A human-typeable bearer code: CW-XXXX-XXXX.
 *
 * Crockford-style alphabet with I, L, O and U removed — a doorman reading a
 * damaged QR aloud must not have to guess between O and 0, and dropping U
 * keeps the set from spelling anything unfortunate. 8 chars from 32 symbols is
 * ~40 bits: not guessable at door-scanning rates.
 */
ticketSchema.statics.newCode = function () {
  const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const b = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += A[b[i] % A.length];
  return 'CW-' + s.slice(0, 4) + '-' + s.slice(4);
};

module.exports = mongoose.models.Ticket || mongoose.model('Ticket', ticketSchema);
