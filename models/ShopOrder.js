/**
 * ShopOrder — a merch order through its whole lifecycle.
 *  - 'started'   : checkout session created, not yet paid (an in-progress or
 *                  abandoned cart — this is how we see who stopped at checkout)
 *  - 'paid'      : Stripe confirmed payment (webhook)
 *  - 'submitted' : sent to Printful for print + ship
 *  - 'draft'     : paid but Printful submit deferred (retry manually)
 *  - 'failed'    : terminal error
 * Unique on the Stripe session so replays can't double-order.
 */
const mongoose = require('mongoose');

const shopOrderSchema = new mongoose.Schema({
  stripeSessionId: { type: String, required: true, unique: true },
  stripeEventId: { type: String, default: null },
  email: { type: String, default: null },
  items: [{ sku: String, name: String, syncVariantId: Number, quantity: Number, unitAmount: Number }],
  amountTotal: { type: Number, default: 0 },        // cents (goods; shipping added at Stripe)
  recipient: { type: mongoose.Schema.Types.Mixed, default: null },
  printfulOrderId: { type: Number, default: null },
  status: { type: String, enum: ['started', 'paid', 'submitted', 'draft', 'failed'], default: 'paid', index: true },
  error: { type: String, default: null },
  paidAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now, index: true },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ShopOrder', shopOrderSchema);
