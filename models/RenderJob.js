/**
 * RenderJob — persisted reel-render job state, so status survives process
 * restarts (an OOM'd render must report "failed", not vanish into a 404).
 */
const mongoose = require('mongoose');

const renderJobSchema = new mongoose.Schema({
  jobId: { type: String, required: true, unique: true, index: true },
  status: { type: String, enum: ['queued', 'running', 'done', 'failed'], default: 'queued' },
  step: { type: String, default: 'queued' },
  error: { type: String, default: null },
  spec: { type: mongoose.Schema.Types.Mixed, default: null },
  asset: { type: mongoose.Schema.Types.Mixed, default: null },
  createdAt: { type: Date, default: Date.now, expires: 86400 }   // auto-clean after a day
});

module.exports = mongoose.model('RenderJob', renderJobSchema);
