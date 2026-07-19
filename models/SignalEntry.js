/**
 * SignalEntry - Curated product change-log entries
 *
 * These are authored by admins and carry the DigitalApple perspective.
 * Types: launch, pricing, model, data-policy, feature, shutdown
 */

const mongoose = require('mongoose');

const signalEntrySchema = new mongoose.Schema({
  // Entry title
  title: {
    type: String,
    required: true,
    maxlength: 300
  },

  // Entry body - markdown supported
  body: {
    type: String,
    required: true,
    maxlength: 5000
  },

  // Type of change
  type: {
    type: String,
    enum: ['launch', 'pricing', 'model', 'data-policy', 'feature', 'shutdown', 'update'],
    required: true,
    index: true
  },

  // Company/product this relates to (optional - for directory integration)
  relatedCompany: {
    type: String,
    index: true
  },

  relatedProduct: {
    type: String
  },

  // Optional link for more info
  link: {
    type: String
  },

  // Author (admin user)
  authorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  // Publication status
  status: {
    type: String,
    enum: ['draft', 'published'],
    default: 'draft',
    index: true
  },

  // When published
  publishedAt: {
    type: Date,
    index: true
  }
}, {
  timestamps: true
});

// Compound index for feed queries
signalEntrySchema.index({ status: 1, publishedAt: -1 });

module.exports = mongoose.model('SignalEntry', signalEntrySchema);
