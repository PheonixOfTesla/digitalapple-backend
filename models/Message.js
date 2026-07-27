const mongoose = require('mongoose');

/**
 * Message — one message in a Conversation. Can carry a shared blueprint/map so
 * ideas travel with the conversation.
 */
const messageSchema = new mongoose.Schema({
  conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  senderName: { type: String, trim: true, maxlength: 80 },
  body: { type: String, trim: true, maxlength: 4000 },

  // Optional attachment (Cloudinary-hosted): photo, GIF, or PDF
  attachment: {
    url: { type: String, trim: true, maxlength: 500 },
    type: { type: String, enum: ['image', 'gif', 'pdf'] },
    name: { type: String, trim: true, maxlength: 160 }
  },

  // Optional shared blueprint (denormalized preview)
  sharedMapId: { type: mongoose.Schema.Types.ObjectId, ref: 'SharedMap' },
  sharedMap: {
    title: { type: String, trim: true, maxlength: 140 },
    previewSvg: { type: String },
    coverage: { type: Number },
    nodeCount: { type: Number }
  },

  readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdAt: { type: Date, default: Date.now }
});

messageSchema.index({ conversationId: 1, createdAt: -1 });

module.exports = mongoose.model('Message', messageSchema);
