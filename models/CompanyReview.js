const mongoose = require('mongoose');

/**
 * CompanyReview — a Clockwork-native review of a directory Company.
 * Reading is public; writing requires a signed-in user (one review per
 * user per company, updatable). Admin can hide for moderation.
 * These feed ratings.clockwork on the Company and the blended rank.
 */
const companyReviewSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  authorName: { type: String, trim: true, maxlength: 80 },
  rating: { type: Number, required: true, min: 1, max: 5 },
  title: { type: String, trim: true, maxlength: 120 },
  body: { type: String, trim: true, maxlength: 2000 },
  hidden: { type: Boolean, default: false }, // admin moderation
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// One review per user per company (updatable).
companyReviewSchema.index({ companyId: 1, authorId: 1 }, { unique: true });
companyReviewSchema.index({ companyId: 1, hidden: 1, createdAt: -1 });

companyReviewSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('CompanyReview', companyReviewSchema);
