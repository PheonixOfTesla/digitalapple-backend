const mongoose = require('mongoose');

const analyticsEventSchema = new mongoose.Schema({
  // Event type: page_view, app_click, install_click, discord_click, instagram_click, creator_click, etc.
  event: {
    type: String,
    required: true,
    index: true
  },

  // Optional: which app/product this relates to
  app: {
    type: String,
    index: true
  },

  // Page path
  path: String,

  // Referrer (raw)
  referrer: String,

  // Classified traffic source: instagram, snapchat, tiktok, google, facebook,
  // twitter, reddit, youtube, discord, direct, internal, other …
  source: { type: String, index: true },

  // UTM params (from campaign links)
  utmSource: String,
  utmMedium: String,
  utmCampaign: String,

  // User agent (for detecting device type)
  userAgent: String,

  // Anonymous session identifier (not tied to user accounts)
  sessionId: String,

  // Whether this is from a standalone/installed PWA
  standalone: {
    type: Boolean,
    default: false
  },

  // IP-based country (if available)
  country: String,

  // Timestamp
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
});

// Compound indexes for common queries
analyticsEventSchema.index({ event: 1, createdAt: -1 });
analyticsEventSchema.index({ app: 1, event: 1, createdAt: -1 });

// TTL index - auto-delete events older than 90 days to manage storage
analyticsEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model('AnalyticsEvent', analyticsEventSchema);
