/**
 * Notification — the Clockwork Hub notification box.
 *
 * One row per event delivered to a recipient. Kept deliberately small: a type,
 * who caused it (actor), an optional deep-link, and read state. Written at the
 * moment an event happens (connect request, request accepted, …) and read in
 * bulk from the bell.
 */
const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, required: true }, // connect_request | connect_accepted | message | room_invite | system
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  actorName: { type: String, default: '' },
  actorAvatar: { type: String, default: null },
  text: { type: String, default: '' },
  link: { type: String, default: '' }, // e.g. hub-profile.html?id=... or host-portal.html?room=...
  read: { type: Boolean, default: false, index: true },
  createdAt: { type: Date, default: Date.now }
});

notificationSchema.index({ userId: 1, createdAt: -1 });

// Fire-and-forget helper; never throws into the caller's request path.
notificationSchema.statics.push = async function (data) {
  try { await this.create(data); } catch (e) { /* non-fatal */ }
};

module.exports = mongoose.model('Notification', notificationSchema);
