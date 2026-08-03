/**
 * JobProfile — you, as the matcher sees you.
 *
 * One per user. Holds the parsed resume, the answer bank, and what you are
 * actually looking for. The raw resume text is kept so re-parsing after a
 * taxonomy change does not require re-uploading the file.
 */
const mongoose = require('mongoose');

const jobProfileSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },

  resumeFilename: { type: String, maxlength: 200 },
  resumeKind: { type: String, enum: ['pdf', 'docx'], default: null },
  resumeText: { type: String, maxlength: 60000 },
  resumeUploadedAt: { type: Date, default: null },
  /**
   * The file itself, not just its text.
   *
   * Every application form has a file input, and no employer accepts a string.
   * Keeping only the parsed text made scoring possible and submitting
   * impossible — the binary has to survive the upload. One resume is a few
   * hundred KB against Mongo's 16MB document limit, so it lives here rather
   * than adding a storage dependency for a single file per person.
   */
  resumeFile: { type: Buffer, default: null },
  resumeMime: { type: String, maxlength: 120, default: null },

  // Parsed structure — regenerated from resumeText whenever the parser improves,
  // which is why the raw text is worth its storage.
  email: String, phone: String, github: String, linkedin: String,
  links: [String],
  yearsExperience: { type: Number, default: null },
  seniority: { type: String, default: 'mid' },
  titles: [String],
  skills: [{ skill: String, mentions: Number, group: String }],
  skillNames: [{ type: String, index: true }],

  // The readability verdict, kept so the console can show it without
  // re-parsing on every page load.
  ats: {
    score: Number,
    passes: Boolean,
    summary: String,
    issues: [{ severity: String, title: String, detail: String }]
  },

  // What you want. Used to filter the corpus before scoring.
  prefs: {
    remoteOnly: { type: Boolean, default: true },
    // What you actually want to earn. Everything ranks against this — a job
    // is not "good" in the abstract, it is above or below your number.
    targetBase: { type: Number, default: null },
    // The floor. Below this a posting is not shown at all.
    minSalary: { type: Number, default: null },
    titles: [String],
    excludeCompanies: [String]
  },

  /**
   * How employers reach you.
   *
   * Seeded from the resume, because the address on the resume is the one they
   * will actually use — but overridable, since the resume may carry an old one
   * and a reply sent to a dead inbox is indistinguishable from silence.
   */
  contact: {
    email: { type: String, maxlength: 200, default: null },
    phone: { type: String, maxlength: 40, default: null },
    // Where you want replies to land, if different from the resume's address.
    replyTo: { type: String, maxlength: 200, default: null }
  },

  /**
   * Gmail, read-only, so replies are detected rather than remembered.
   *
   * The refresh token is encrypted at rest with the same service that protects
   * message bodies. Scope is gmail.readonly — this can read and nothing else.
   */
  gmail: {
    refreshToken: { type: String, default: null },   // encrypted
    email: { type: String, maxlength: 200, default: null },
    connectedAt: { type: Date, default: null },
    lastScanAt: { type: Date, default: null },
    lastScanFound: { type: Number, default: 0 },
    revoked: { type: Boolean, default: false }
  },

  // Reused answers for screening questions, so nothing is retyped.
  answers: [{ key: String, question: String, answer: String }]
}, { timestamps: true });

module.exports = mongoose.model('JobProfile', jobProfileSchema);
