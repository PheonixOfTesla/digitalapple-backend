/**
 * Application - User-submitted product directory applications
 *
 * Users submit products for inclusion in the AI directory.
 * Admins review and approve/reject.
 */

const mongoose = require('mongoose');

const applicationSchema = new mongoose.Schema({
  // Product details
  productName: {
    type: String,
    required: true,
    maxlength: 200
  },

  url: {
    type: String,
    required: true,
    maxlength: 500
  },

  company: {
    type: String,
    required: true,
    maxlength: 200
  },

  // Submitter's relationship to the product
  role: {
    type: String,
    required: true,
    maxlength: 100
  },

  // Use case description
  useCase: {
    type: String,
    required: true,
    maxlength: 2000
  },

  // Deployment type
  deployment: {
    type: String,
    enum: ['cloud', 'local', 'self-hosted', 'hybrid'],
    required: true
  },

  // Pricing model
  pricing: {
    type: String,
    enum: ['free', 'freemium', 'paid', 'enterprise', 'open-source'],
    required: true
  },

  // AI model used underneath
  modelUnderneath: {
    type: String,
    maxlength: 500
  },

  // What the product does
  description: {
    type: String,
    required: true,
    maxlength: 3000
  },

  // Data policy summary
  dataPolicy: {
    type: String,
    required: true,
    maxlength: 2000
  },

  // Why it belongs in the directory
  whyBelongs: {
    type: String,
    required: true,
    maxlength: 1000
  },

  // User confirmed accuracy
  accuracyConfirmed: {
    type: Boolean,
    required: true,
    default: false
  },

  // Who submitted
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // Review status
  status: {
    type: String,
    enum: ['pending', 'published', 'rejected'],
    default: 'pending',
    index: true
  },

  // If rejected, why
  rejectionReason: {
    type: String,
    maxlength: 1000
  },

  // When reviewed
  reviewedAt: {
    type: Date
  },

  // Who reviewed
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Compound index for admin queries
applicationSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('Application', applicationSchema);
