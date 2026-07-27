const mongoose = require('mongoose');

/**
 * Conversation — a Clockwork "Thread": a private channel between Hub members for
 * exchanging ideas (and blueprints). 1:1 for now; participantKey dedupes them.
 */
const conversationSchema = new mongoose.Schema({
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }],
  participantKey: { type: String, unique: true }, // sorted "idA:idB" — one thread per pair
  lastMessage: {
    body: { type: String, trim: true, maxlength: 400 },
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    hasMap: { type: Boolean, default: false },
    at: { type: Date }
  },
  updatedAt: { type: Date, default: Date.now, index: true }
});

conversationSchema.index({ participants: 1, updatedAt: -1 });

conversationSchema.statics.keyFor = function (a, b) {
  return [String(a), String(b)].sort().join(':');
};

module.exports = mongoose.model('Conversation', conversationSchema);
