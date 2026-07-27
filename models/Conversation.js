const mongoose = require('mongoose');

/**
 * Conversation — a Clockwork "Thread": a private channel between Hub members for
 * exchanging ideas (and blueprints). 1:1 for now; participantKey dedupes them.
 */
const conversationSchema = new mongoose.Schema({
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }],
  participantKey: { type: String, unique: true, sparse: true }, // 1:1 dedupe key (null for rooms)
  isRoom: { type: Boolean, default: false },   // room (group) vs 1:1 DM
  name: { type: String, trim: true, maxlength: 80 }, // room name
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  // Social rooms of all types: public (anyone can join) or private (invite).
  visibility: { type: String, enum: ['private', 'public'], default: 'private' },
  category: { type: String, enum: ['ideas', 'network', 'social', 'business', 'other'], default: 'other' },
  description: { type: String, trim: true, maxlength: 300 },
  // A room can be "about" something on the platform — an Atlas map, a Directory
  // company, or a News/Signal item. That's the Connect ↔ content integration.
  source: {
    type: { type: String, enum: ['map', 'company', 'news', null], default: null },
    refId: { type: String, trim: true },
    title: { type: String, trim: true, maxlength: 140 },
    url: { type: String, trim: true, maxlength: 300 }
  },
  sourceKey: { type: String, unique: true, sparse: true }, // "map:<id>" — one public room per source
  lastMessage: {
    body: { type: String, trim: true, maxlength: 400 },
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    hasMap: { type: Boolean, default: false },
    at: { type: Date }
  },
  updatedAt: { type: Date, default: Date.now, index: true }
});

conversationSchema.index({ participants: 1, updatedAt: -1 });
conversationSchema.index({ isRoom: 1, visibility: 1, category: 1, updatedAt: -1 });

conversationSchema.statics.keyFor = function (a, b) {
  return [String(a), String(b)].sort().join(':');
};

module.exports = mongoose.model('Conversation', conversationSchema);
