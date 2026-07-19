/**
 * NewsItem - Aggregated headlines from RSS feeds
 *
 * IMPORTANT: Only store title, source, timestamp, and link.
 * NEVER store full article text or images - headlines only for legal compliance.
 */

const mongoose = require('mongoose');

const newsItemSchema = new mongoose.Schema({
  // Headline text only - never full article
  title: {
    type: String,
    required: true,
    maxlength: 500
  },

  // Source attribution
  source: {
    type: String,
    required: true,
    index: true
  },

  // Canonical link to original article
  link: {
    type: String,
    required: true,
    unique: true
  },

  // Original publish timestamp
  publishedAt: {
    type: Date,
    required: true,
    index: true
  },

  // When we fetched it
  fetchedAt: {
    type: Date,
    default: Date.now
  },

  // Category for filtering
  category: {
    type: String,
    enum: ['ai', 'tech', 'startup', 'policy', 'research'],
    default: 'ai',
    index: true
  },

  // For deduplication
  guid: {
    type: String,
    unique: true,
    sparse: true
  }
}, {
  timestamps: true
});

// TTL index - auto-delete after 30 days
newsItemSchema.index({ publishedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

// Compound index for efficient queries
newsItemSchema.index({ publishedAt: -1, category: 1 });

module.exports = mongoose.model('NewsItem', newsItemSchema);
