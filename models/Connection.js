/**
 * Connection — the Clockwork Hub relationship graph ("add you", Facebook-style).
 *
 * One document per pair, keyed by a stable sorted pairKey so a request can't be
 * duplicated in either direction. `requestedBy` records who initiated; `status`
 * is 'pending' until the other person accepts, then 'accepted'.
 */
const mongoose = require('mongoose');

const connectionSchema = new mongoose.Schema({
  // a and b are the two members, stored sorted so (a,b) === (b,a).
  a: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  b: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  pairKey: { type: String, required: true, unique: true },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['pending', 'accepted'], default: 'pending', index: true },
  createdAt: { type: Date, default: Date.now },
  acceptedAt: { type: Date, default: null }
});

// Stable, order-independent key for a pair of user ids.
connectionSchema.statics.keyFor = function (x, y) {
  return [String(x), String(y)].sort().join('_');
};

module.exports = mongoose.model('Connection', connectionSchema);
