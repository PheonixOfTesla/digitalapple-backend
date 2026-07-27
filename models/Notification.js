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
  // Two separate streams. 'personal' = your Hub bell (connects, messages…).
  // 'admin' = the admin console stream (system-down, new submissions, orders…),
  // shown only in the admin portal so it never clutters the personal bell.
  channel: { type: String, enum: ['personal', 'admin'], default: 'personal', index: true },
  type: { type: String, required: true }, // connect_request | connect_accepted | message | room_invite | system | admin_*
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

// Fan a notification out to every admin's admin-channel stream. Used for system
// health alerts and admin-portal activity (new submissions, orders, applications).
notificationSchema.statics.pushAdmins = async function (data) {
  try {
    const User = require('./User');
    const admins = await User.find({ role: 'admin' }).select('_id').lean();
    if (!admins.length) return;
    const now = new Date();
    await this.insertMany(admins.map(a => ({
      userId: a._id, channel: 'admin', read: false, createdAt: now,
      type: data.type || 'admin', text: data.text || '', link: data.link || '',
      actorName: data.actorName || '', actorAvatar: data.actorAvatar || null
    })));
  } catch (e) { /* non-fatal */ }
};

module.exports = mongoose.model('Notification', notificationSchema);
