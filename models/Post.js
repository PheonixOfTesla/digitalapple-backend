const mongoose = require('mongoose');

/**
 * Post — a Clockwork Hub feed entry ("Add to Clockwork Hub").
 * A post is a short text update and/or a shared Atlas map. Kept intentionally
 * lean for a clean, uncluttered feed; connections/comments layer on later.
 */
const postSchema = new mongoose.Schema({
  authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  authorName: { type: String, trim: true, maxlength: 80 },
  authorHandle: { type: String, trim: true, maxlength: 40 },
  authorAvatar: { type: String },                 // Cloudinary URL, optional

  body: { type: String, trim: true, maxlength: 2000 },

  // Optional shared map (the "share an Atlas map to the Hub" case)
  sharedMapId: { type: mongoose.Schema.Types.ObjectId, ref: 'SharedMap' },
  sharedMap: {                                     // denormalized preview snapshot
    title: { type: String, trim: true, maxlength: 140 },
    previewSvg: { type: String },
    coverage: { type: Number },
    nodeCount: { type: Number }
  },

  likeCount: { type: Number, default: 0 },
  likedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  commentCount: { type: Number, default: 0 },

  hidden: { type: Boolean, default: false },       // admin moderation
  createdAt: { type: Date, default: Date.now }
});

postSchema.index({ hidden: 1, createdAt: -1 });
postSchema.index({ authorId: 1, createdAt: -1 });

module.exports = mongoose.model('Post', postSchema);
