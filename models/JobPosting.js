/**
 * JobPosting — one role, from wherever we found it.
 *
 * The same job genuinely appears many times: an ATS carries it, then three
 * aggregators syndicate it, and the company reposts it a fortnight later with
 * a comma moved. Measured in one raw pass: LawnStarter's opening arrived five
 * times. So dedupe is not a nicety here, it is the difference between a queue
 * you can review and a wall of the same job.
 *
 * `fingerprint` is the dedupe key: company + a normalised title. Not the URL —
 * every source has a different URL for the same role, which is exactly why the
 * URL is useless for this — and not the description, which the aggregators
 * truncate differently.
 *
 * When duplicates collide we keep the record that can be APPLIED to. An ATS
 * posting has a form we can fill; an aggregator's copy is a redirect. Same job,
 * very different value.
 */
const mongoose = require('mongoose');

const jobPostingSchema = new mongoose.Schema({
  fingerprint: { type: String, required: true, unique: true, index: true },

  source: { type: String, required: true, index: true },
  sourceKind: { type: String, enum: ['ats', 'board'], default: 'board', index: true },
  sourceId: { type: String, required: true },
  ats: { type: String, default: null },

  title: { type: String, required: true, trim: true, maxlength: 300 },
  company: { type: String, trim: true, maxlength: 200, index: true },
  location: { type: String, trim: true, maxlength: 200 },
  remote: { type: Boolean, default: false, index: true },
  url: { type: String, required: true, maxlength: 1000 },
  applyUrl: { type: String, maxlength: 1000 },
  description: { type: String, maxlength: 20000 },
  employmentType: { type: String, maxlength: 60 },
  tags: [{ type: String, maxlength: 60 }],
  postedAt: { type: Date, default: null, index: true },

  // Parsed once at ingest rather than on every read: the corpus is scanned
  // repeatedly by the matcher and re-running a regex over 15,000 descriptions
  // per request is the obvious way to make this feel slow.
  salary: {
    minAnnual: Number, maxAnnual: Number, midAnnual: { type: Number, index: true },
    currency: String, isRange: Boolean, converted: Boolean,
    confidence: Number, evidence: String
  },
  skills: [{ type: String, maxlength: 40, index: true }],
  seniority: { type: String, enum: ['junior', 'mid', 'senior', 'staff', 'unknown'], default: 'unknown', index: true },
  // Which role archetype this posting belongs to — the thing the two rankings
  // are computed over.
  archetype: { type: String, maxlength: 80, default: null, index: true },
  isEngineering: { type: Boolean, default: false, index: true },

  // Every place we have seen this job, so a duplicate is recorded rather than
  // discarded — useful when the ATS copy disappears but a board still has it.
  seenIn: [{ source: String, url: String, at: Date }],

  firstSeenAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now, index: true },
  // Postings vanish without notice. Rather than deleting — which would lose
  // the record of something already applied to — they are marked closed.
  closed: { type: Boolean, default: false, index: true }
}, { timestamps: true });

jobPostingSchema.index({ isEngineering: 1, remote: 1, postedAt: -1 });
jobPostingSchema.index({ archetype: 1, 'salary.midAnnual': -1 });

/**
 * The dedupe key.
 *
 * Titles differ cosmetically across sources for the same job: "Senior Software
 * Engineer, Backend (Remote)" and "Senior Software Engineer - Backend" are one
 * role. Strip the decoration, keep the substance.
 */
jobPostingSchema.statics.fingerprintOf = function (company, title) {
  const norm = s => String(s || '').toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')                      // "(Remote)", "[US]"
    .replace(/\b(remote|hybrid|onsite|on-site|contract|full[\s-]?time|part[\s-]?time|w2|c2c)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an|and|or|of|for|to|at|in|with)\b/g, ' ')
    .trim().replace(/\s+/g, ' ');
  return norm(company) + '|' + norm(title);
};

module.exports = mongoose.model('JobPosting', jobPostingSchema);
