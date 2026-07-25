/**
 * LabAsset — a rendered reel MP4 (or other Lab-produced file) hosted on
 * Cloudinary and listed in the Lab's Attachments tab.
 */
const mongoose = require('mongoose');

const labAssetSchema = new mongoose.Schema({
  name: { type: String, required: true, maxlength: 120 },
  kind: { type: String, enum: ['reel'], default: 'reel' },
  url: { type: String, required: true },          // Cloudinary secure_url
  publicId: { type: String, default: null },      // for deletion
  bytes: { type: Number, default: 0 },
  duration: { type: Number, default: 0 },         // seconds
  voiced: { type: Boolean, default: false },
  topic: { type: String, default: '' },
  spec: { type: mongoose.Schema.Types.Mixed, default: null },  // the reel definition
  costUsd: { type: Number, default: 0 },          // TTS cost recorded for this render
  createdAt: { type: Date, default: Date.now }
});

labAssetSchema.index({ createdAt: -1 });

module.exports = mongoose.model('LabAsset', labAssetSchema);
