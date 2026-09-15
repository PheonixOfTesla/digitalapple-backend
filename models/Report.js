const mongoose = require('mongoose');

/**
 * A report filed by one user against another user, or against a specific piece
 * of content (a message, a post, a room).
 *
 * WHY THIS IS ITS OWN COLLECTION. Reports are an audit trail, not app state:
 * they must survive the deletion of the thing reported (a user who deletes an
 * abusive message must not erase the report of it), they accumulate for review,
 * and admins act on patterns across many of them. Folding them into the User or
 * Message document would lose all three properties.
 *
 * Status moves open -> reviewed -> actioned|dismissed. Nothing here auto-acts;
 * a human in the admin console decides. The point of the record is that the
 * decision is possible at all — before this, an abuse report had nowhere to go.
 */
const reportSchema = new mongoose.Schema({
  // Who filed it.
  reporterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  reporterName: { type: String, default: '' },

  // Who or what it is about. `targetUserId` is always set (the person responsible);
  // the content fields narrow it to a specific artifact when there is one.
  targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  targetName: { type: String, default: '' },

  // Kind of thing reported and its id, so an admin can open the exact artifact.
  contentType: { type: String, enum: ['user', 'message', 'post', 'room', 'comment', 'other'], default: 'user' },
  contentId: { type: mongoose.Schema.Types.ObjectId, default: null },
  // A frozen copy of the reported text, because the original may be edited or
  // deleted before anyone reviews it. This is the evidence.
  snapshot: { type: String, default: '', maxlength: 4000 },

  // Why. A short category plus optional free text.
  reason: { type: String, enum: ['spam', 'harassment', 'hate', 'sexual', 'violence', 'scam', 'other'], default: 'other' },
  detail: { type: String, default: '', maxlength: 2000 },

  status: { type: String, enum: ['open', 'reviewed', 'actioned', 'dismissed'], default: 'open', index: true },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt: { type: Date, default: null },

  createdAt: { type: Date, default: Date.now, index: true }
});

// One person cannot pile twenty reports on the same artifact to inflate a count.
// A repeat report of the same content by the same reporter updates the existing
// row rather than creating a new one — enforced in the controller via this key.
reportSchema.index({ reporterId: 1, contentType: 1, contentId: 1 });

module.exports = mongoose.model('Report', reportSchema);
