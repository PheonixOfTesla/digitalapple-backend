/**
 * JobApplication — one role you decided to go after, and what happened next.
 *
 * Separate from JobPosting because the posting is the world's data and this is
 * yours. A posting closes, gets edited, or vanishes; none of that should touch
 * the record that you applied on a date and heard back on another.
 *
 * The status ladder is deliberately short. Longer ones look thorough and then
 * nobody maintains them.
 */
const mongoose = require('mongoose');

const jobApplicationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  postingId: { type: mongoose.Schema.Types.ObjectId, ref: 'JobPosting', required: true, index: true },

  // Copied, not referenced. If the posting is deleted or the company pulls the
  // role, the record of what you applied to must still read correctly.
  title: { type: String, maxlength: 300 },
  company: { type: String, maxlength: 200 },
  url: { type: String, maxlength: 1000 },
  salaryMid: { type: Number, default: null },

  status: {
    type: String,
    enum: ['queued', 'applied', 'responded', 'interview', 'offer', 'rejected', 'skipped'],
    default: 'queued', index: true
  },
  // What the queue is FOR: everything prepared, waiting on one tap.
  preparedAt: { type: Date, default: null },
  appliedAt: { type: Date, default: null, index: true },
  respondedAt: { type: Date, default: null },

  matchScore: { type: Number, default: null },
  // Why it scored that way, kept so a decision is inspectable later rather
  // than being a number you have to trust.
  matched: [{ type: String, maxlength: 40 }],
  missing: [{ type: String, maxlength: 40 }],

  coverLetter: { type: String, maxlength: 8000 },
  resumeVersion: { type: String, maxlength: 120 },
  notes: { type: String, maxlength: 4000 },

  // Replies, however they arrive. `kind` is what the message actually was —
  // a rejection dressed as a thank-you is still a rejection.
  responses: [{
    at: { type: Date, default: Date.now },
    kind: { type: String, enum: ['rejection', 'interview', 'offer', 'other'], default: 'other' },
    subject: { type: String, maxlength: 300 },
    excerpt: { type: String, maxlength: 2000 }
  }]
}, { timestamps: true });

// One application per posting per person: pressing approve twice must not
// send twice, and a retry after a network error must not either.
jobApplicationSchema.index({ userId: 1, postingId: 1 }, { unique: true });
jobApplicationSchema.index({ userId: 1, status: 1, appliedAt: -1 });

module.exports = mongoose.model('JobApplication', jobApplicationSchema);
