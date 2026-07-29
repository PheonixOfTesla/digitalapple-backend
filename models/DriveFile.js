const mongoose = require('mongoose');

/**
 * DriveFile — a file that lives with YOU on Clockwork Drive (not with a room).
 * Chat attachments and Ticker media surface in Drive too; these are the files
 * uploaded straight into it. Cloudinary-hosted (Railway FS is ephemeral).
 */
const driveFileSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, trim: true, maxlength: 200, required: true },
  url: { type: String, trim: true, maxlength: 500, required: true },
  type: { type: String, enum: ['image', 'video', 'pdf', 'doc', 'ppt', 'other'], default: 'other' },
  // Drawer — Clockwork's word for a folder. Free-form label; empty = loose file.
  drawer: { type: String, trim: true, maxlength: 60 },
  size: { type: Number },
  createdAt: { type: Date, default: Date.now }
});

driveFileSchema.index({ ownerId: 1, createdAt: -1 });

module.exports = mongoose.model('DriveFile', driveFileSchema);
