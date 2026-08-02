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

  // Reused answers for screening questions, so nothing is retyped.
  answers: [{ key: String, question: String, answer: String }]
}, { timestamps: true });

module.exports = mongoose.model('JobProfile', jobProfileSchema);
