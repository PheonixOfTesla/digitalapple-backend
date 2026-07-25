/**
 * ShopOrder — a paid merch order. Created only by the verified Stripe
 * webhook; unique on the Stripe session so replays can't double-order.
 */
const mongoose = require('mongoose');

const shopOrderSchema = new mongoose.Schema({
  stripeSessionId: { type: String, required: true, unique: true },
  stripeEventId: { type: String, default: null },
  email: { type: String, default: null },
  items: [{ sku: String, name: String, syncVariantId: Number, quantity: Number, unitAmount: Number }],
  amountTotal: { type: Number, default: 0 },        // cents
  recipient: { type: mongoose.Schema.Types.Mixed, default: null },
  printfulOrderId: { type: Number, default: null },
  status: { type: String, enum: ['paid', 'submitted', 'draft', 'failed'], default: 'paid' },
  error: { type: String, default: null },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ShopOrder', shopOrderSchema);
