/**
 * NebulaLog — durable record of every nebula (blueprint map) created.
 *
 * Why a dedicated log: anonymous Projects auto-delete after 24h (TTL), so the
 * Project collection can't answer "how many anonymous vs registered users
 * created nebulas, and what did they make?" over time. This log persists the
 * creation event independently of the (possibly deleted) Project.
 *
 * Written best-effort at successful nebula generation. Read by the admin
 * Nebula-creation tracker (GET /analytics/nebulas).
 */

const mongoose = require('mongoose');

const nebulaLogSchema = new mongoose.Schema({
  // Who created it: 'anonymous' (no account) or 'registered' (logged in)
  creatorType: {
    type: String,
    enum: ['anonymous', 'registered'],
    required: true,
    index: true
  },

  // Owner, if a registered user (null for anonymous)
  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },

  // Anonymous session id (null for registered)
  anonymousSessionId: String,

  // The project this nebula belongs to (may be gone if anon + expired)
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project'
  },

  // What was created
  premise: { type: String, maxlength: 1000 },
  title: { type: String, maxlength: 200 },

  // Frame classification (venture, event, personal-goal, …) and determination
  classificationType: String,
  determination: String,

  // Fork provenance, if this nebula was forked from a shared map
  forked: { type: Boolean, default: false },
  forkedFromTitle: String,

  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
});

nebulaLogSchema.index({ creatorType: 1, createdAt: -1 });

// Retain 180 days of creation history, then auto-prune.
nebulaLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

module.exports = mongoose.model('NebulaLog', nebulaLogSchema);
