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
  photo: { type: String, trim: true, maxlength: 500 }, // room photo (Cloudinary URL)
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  // Social rooms of all types: public (anyone can join) or private (invite).
  visibility: { type: String, enum: ['private', 'public'], default: 'private' },
  // Business hours: when enabled, non-members can only walk in while open.
  // Times are host-local HH:MM; tzOffset is the host's getTimezoneOffset().
  hours: {
    enabled: { type: Boolean, default: false },
    open: { type: String, default: '09:00' },
    close: { type: String, default: '17:00' },
    days: { type: [Number], default: [0, 1, 2, 3, 4, 5, 6] }, // 0=Sun … 6=Sat
    tzOffset: { type: Number, default: 0 },
    // Advance notice: visitors can't walk in — they request ahead (hours).
    noticeHours: { type: Number, default: 0, min: 0, max: 168 }
  },
  // Entry price in cents (0 = free). Paid rooms collect via Stripe at the door.
  price: { type: Number, default: 0, min: 0, max: 50000 },
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
  // A Studio is a live room: chat channel + voice + screen share, hosted by the
  // owner, where a blueprint is built together. The blueprint being worked on is
  // linked here so everyone who joins opens the same canvas.
  isStudio: { type: Boolean, default: false },
  blueprintProjectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', default: null },
  // Host-assigned member roles inside a Studio (Co-host, Builder, …) — display
  // labels chosen by the host; the Host badge itself always comes from ownerId.
  memberRoles: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    role: { type: String, trim: true, maxlength: 24 }
  }],
  // Knock-to-enter: private rooms/Studios queue join requests here until the
  // host accepts (they get a notification) — public ones are free to join.
  // Paid rooms are paid-then-accepted: the request files only after payment,
  // and a declined paid request refunds via its paymentIntent.
  joinRequests: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    at: { type: Date, default: Date.now },
    paid: { type: Boolean, default: false },
    paymentIntent: { type: String, trim: true, maxlength: 80 }
  }],
  // Anonymous guest knocks on private rooms: name-only, keyed by a random
  // token the guest holds; when the host accepts, the key becomes a pass.
  guestKnocks: [{
    key: { type: String, trim: true, maxlength: 64 },
    name: { type: String, trim: true, maxlength: 60 },
    at: { type: Date, default: Date.now },
    status: { type: String, enum: ['pending', 'accepted', 'declined'], default: 'pending' }
  }],
  // Archive/delete: archivedBy hides the thread for those users only; closedAt
  // set by the owner shuts the room/Studio itself down for everyone.
  archivedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  closedAt: { type: Date, default: null },
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
