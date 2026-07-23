/**
 * Setting — generic admin-managed key/value store for integrations
 * (e.g. the WaveSpeed API key used by the reel render pipeline).
 *
 * Secret values are stored here but NEVER returned to the client in full —
 * endpoints return only a masked preview + a connected flag.
 */
const mongoose = require('mongoose');

const settingSchema = new mongoose.Schema({
  key: { type: String, unique: true, required: true },
  value: { type: String, default: '' },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Setting', settingSchema);
