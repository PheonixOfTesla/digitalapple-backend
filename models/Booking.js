/**
 * Booking — one appointment in the chair.
 *
 * The service is snapshotted (name, price, duration) rather than referenced.
 * A barber who raises the price of a fade on Friday must not silently change
 * what Tuesday's client agreed to pay, and a service deleted from the menu must
 * not blank out the appointments already on the books.
 *
 * `startsAt`/`endsAt` are real UTC instants; the wall-clock the client was told
 * is derived from the shop's timezone at render time.
 *
 * Statuses:
 *  - 'booked'    : on the books, money not taken yet (pay in the chair)
 *  - 'paid'      : the verified Stripe webhook confirmed payment
 *  - 'cancelled' : called off by either side; the slot is free again
 *  - 'completed' : marked done by the barber
 */
const mongoose = require('mongoose');
const crypto = require('crypto');

const bookingSchema = new mongoose.Schema({
  shopHandle: { type: String, required: true, index: true, lowercase: true },

  clientName: { type: String, required: true, trim: true },
  clientEmail: { type: String, required: true, trim: true, lowercase: true },
  clientPhone: { type: String, default: '', trim: true },
  notes: { type: String, default: '', trim: true },

  serviceId: { type: String, default: '' },
  serviceName: { type: String, required: true },
  durationMin: { type: Number, required: true },
  priceCents: { type: Number, default: 0 },

  startsAt: { type: Date, required: true, index: true },
  endsAt: { type: Date, required: true },

  status: { type: String, enum: ['booked', 'paid', 'cancelled', 'completed'], default: 'booked', index: true },
  source: { type: String, enum: ['client', 'barber'], default: 'client' },

  // Payment. `billed` is a bill the barber sent that has not been settled;
  // `paidAt` is only ever written by the verified webhook.
  amountDueCents: { type: Number, default: 0 },
  amountPaidCents: { type: Number, default: 0 },
  // What the platform keeps out of this transaction, decided when the payment
  // link is made and frozen there. Changing a shop's rate must never rewrite
  // the split on money that has already moved.
  platformFeeCents: { type: Number, default: 0 },
  platformFeeBps: { type: Number, default: 0 },
  payoutAccountId: { type: String, default: null },

  stripeSessionId: { type: String, default: null, index: true },
  stripeEventId: { type: String, default: null },
  paymentUrl: { type: String, default: null },
  paidAt: { type: Date, default: null },

  // Unguessable handle for the client's own manage/cancel link — they have no
  // account, so the link in their email is the only credential they get.
  manageToken: { type: String, default: () => crypto.randomBytes(24).toString('hex'), index: true },

  cancelledAt: { type: Date, default: null },
  cancelledBy: { type: String, default: null },            // 'client' | 'barber'
  remindedAt: { type: Date, default: null },

  createdAt: { type: Date, default: Date.now, index: true },
  updatedAt: { type: Date, default: Date.now }
});

/**
 * Two people hitting "book" on the same 2:30 slot is not a hypothetical — it is
 * the normal failure of any booking site that only checks before it writes.
 * A partial unique index makes the database the referee: only one live booking
 * can hold a given start time, and the loser gets a duplicate-key error the API
 * turns into "someone just took that one".
 */
bookingSchema.index(
  { shopHandle: 1, startsAt: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['booked', 'paid'] } } }
);

bookingSchema.methods.toPublic = function () {
  return {
    id: String(this._id),
    clientName: this.clientName,
    clientEmail: this.clientEmail,
    clientPhone: this.clientPhone,
    notes: this.notes,
    serviceName: this.serviceName,
    durationMin: this.durationMin,
    priceCents: this.priceCents,
    startsAt: this.startsAt,
    endsAt: this.endsAt,
    status: this.status,
    source: this.source,
    amountDueCents: this.amountDueCents,
    amountPaidCents: this.amountPaidCents,
    platformFeeCents: this.platformFeeCents,
    paidAt: this.paidAt,
    paymentUrl: this.status === 'cancelled' ? null : this.paymentUrl,
    createdAt: this.createdAt
  };
};

module.exports = mongoose.model('Booking', bookingSchema);
