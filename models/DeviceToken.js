const mongoose = require('mongoose');

/**
 * A push destination: one device belonging to one user.
 *
 * The native app registers here on launch and after every permission grant, so
 * the backend can turn an in-app Notification write into a real push to a locked
 * phone. This is the missing half of notifications — the Notification model
 * records WHAT happened; this records WHERE to send it.
 *
 * Platform-agnostic on purpose. `apns` for the iOS app, `fcm` for a future
 * Android build, `webpush` for the installed PWA — one sender abstraction fans
 * out across all three, so adding a platform never touches the calling code.
 *
 * A token is unique: the same device re-registering updates its user and
 * timestamp rather than creating duplicates, which is how a phone that changes
 * hands stops notifying the previous owner.
 */
const deviceTokenSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // The APNs/FCM device token, or the JSON of a web-push subscription.
  token: { type: String, required: true, unique: true },
  platform: { type: String, enum: ['apns', 'fcm', 'webpush'], required: true },
  // Bundle/app id and build, so a token can be retired when an old app version
  // is sunset, and sandbox-vs-production APNs can be chosen per registration.
  appId: { type: String, default: '' },
  environment: { type: String, enum: ['production', 'sandbox'], default: 'production' },
  lastSeen: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('DeviceToken', deviceTokenSchema);
