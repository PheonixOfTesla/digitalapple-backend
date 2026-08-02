/**
 * The job console's API.
 *
 * Personal, not administrative. Every route is scoped to req.userId — your
 * resume, your matches, your applications — rather than to the admin role, so
 * granting somebody admin later does not hand them your salary expectations
 * and your rejections.
 *
 * Three things the console shows, and they are three genuinely different
 * questions: what could I apply to, what did I apply to, and who replied.
 */
const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');

const JobPosting = require('../models/JobPosting');
const JobApplication = require('../models/JobApplication');
const JobProfile = require('../models/JobProfile');
const { verifyToken } = require('../middleware/auth');
const { runIngest } = require('../services/jobs/ingest');
const { rankArchetypes, rankPostings, scorePosting } = require('../services/jobs/match');
const { readResume } = require('../services/jobs/resume');
const { formatSalary } = require('../services/jobs/salary');
const { atsTargets } = require('../services/jobs/companies');
const { SOURCES } = require('../services/jobs/sources');

const router = express.Router();

// Resumes are parsed in memory and the text stored; the binary is never kept.
// 8MB is far above any real resume and well below anything that would hurt.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

async function profileFor(userId) {
  let p = await JobProfile.findOne({ userId }).lean();
  if (!p) p = { userId, skillNames: [], seniority: 'mid', yearsExperience: null, prefs: { remoteOnly: true } };
  return p;
}

/** The corpus, as plain objects the matcher can scan. */
function corpus(extra = {}) {
  return JobPosting.find({ isEngineering: true, closed: false, ...extra })
    .select('title company location remote url applyUrl description skills seniority archetype salary postedAt source sourceKind isEngineering')
    .lean();
}

// ── Overview ────────────────────────────────────────────────────────────────

router.get('/overview', verifyToken, async (req, res) => {
  try {
    const [total, engineering, remote, withSalary, lastPost] = await Promise.all([
      JobPosting.countDocuments({ closed: false }),
      JobPosting.countDocuments({ isEngineering: true, closed: false }),
      JobPosting.countDocuments({ isEngineering: true, remote: true, closed: false }),
      JobPosting.countDocuments({ isEngineering: true, 'salary.midAnnual': { $gt: 0 }, closed: false }),
      JobPosting.findOne({}).sort({ lastSeenAt: -1 }).select('lastSeenAt').lean()
    ]);
    const [applied, responded, queued] = await Promise.all([
      JobApplication.countDocuments({ userId: req.userId, status: { $in: ['applied', 'responded', 'interview', 'offer', 'rejected'] } }),
      JobApplication.countDocuments({ userId: req.userId, status: { $in: ['responded', 'interview', 'offer'] } }),
      JobApplication.countDocuments({ userId: req.userId, status: 'queued' })
    ]);
    const profile = await profileFor(req.userId);
    res.json({
      success: true,
      corpus: { total, engineering, remote, withSalary, lastIngestAt: lastPost ? lastPost.lastSeenAt : null },
      sources: { boards: SOURCES.filter(s => !s.perCompany).length, atsBoards: atsTargets().length },
      me: {
        hasResume: !!profile.resumeUploadedAt,
        atsScore: profile.ats ? profile.ats.score : null,
        years: profile.yearsExperience, seniority: profile.seniority,
        skills: (profile.skillNames || []).length
      },
      pipeline: { queued, applied, responded }
    });
  } catch (e) { console.error('jobs overview:', e.message); res.status(500).json({ error: 'Could not load overview' }); }
});

// ── Resume ──────────────────────────────────────────────────────────────────

router.post('/resume', verifyToken, upload.single('resume'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
      return res.status(400).json({ error: 'No file received. Choose a PDF or .docx and try again.' });
    }
    let r;
    try {
      r = await readResume(req.file.buffer, req.file.originalname, req.file.mimetype);
    } catch (e) {
      // An unsupported or unreadable file is the user's problem to fix, and
      // the message says exactly how — not a 500.
      return res.status(e.code === 'UNSUPPORTED' ? 415 : 422).json({ error: e.message });
    }
    const p = r.parsed;
    await JobProfile.updateOne({ userId: req.userId }, {
      $set: {
        resumeFilename: String(req.file.originalname || '').slice(0, 200),
        resumeKind: r.kind, resumeText: r.text.slice(0, 60000), resumeUploadedAt: new Date(),
        email: p.email, phone: p.phone, github: p.github, linkedin: p.linkedin, links: p.links,
        yearsExperience: p.yearsExperience, seniority: p.seniority, titles: p.titles,
        skills: p.skills, skillNames: p.skillNames, ats: r.ats
      }
    }, { upsert: true });
    res.json({ success: true, parsed: p, ats: r.ats, kind: r.kind, pages: r.pages });
  } catch (e) { console.error('jobs resume:', e.message); res.status(500).json({ error: 'Could not read that resume' }); }
});

router.get('/profile', verifyToken, async (req, res) => {
  const p = await profileFor(req.userId);
  const { resumeText, ...rest } = p;
  res.json({ success: true, profile: rest });
});

// ── Matches ─────────────────────────────────────────────────────────────────

/** The archetype table: soonest and highest paid, side by side. */
router.get('/archetypes', verifyToken, async (req, res) => {
  try {
    const profile = await profileFor(req.userId);
    if (!profile.skillNames || !profile.skillNames.length) {
      return res.json({ success: true, needsResume: true, soonest: [], highest: [] });
    }
    const postings = await corpus();
    const { soonest, highest } = rankArchetypes(profile, postings);
    res.json({ success: true, needsResume: false, soonest, highest, analysed: postings.length });
  } catch (e) { console.error('jobs archetypes:', e.message); res.status(500).json({ error: 'Could not rank roles' }); }
});

router.get('/matches', verifyToken, async (req, res) => {
  try {
    const profile = await profileFor(req.userId);
    if (!profile.skillNames || !profile.skillNames.length) {
      return res.json({ success: true, needsResume: true, matches: [] });
    }
    const remoteOnly = req.query.remote !== '0';
    const archetype = req.query.archetype || null;
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 60);
    const postings = await corpus();
    const ranked = rankPostings(profile, postings, { archetype, remoteOnly, minScore: 0, limit });

    // Which of these you have already dealt with — a queue that keeps showing
    // you jobs you applied to last week is a queue nobody opens twice.
    const ids = ranked.map(r => r.job._id);
    const seen = await JobApplication.find({ userId: req.userId, postingId: { $in: ids } })
      .select('postingId status').lean();
    const byId = new Map(seen.map(s => [String(s.postingId), s.status]));

    res.json({
      success: true, needsResume: false,
      matches: ranked.map(r => ({
        id: r.job._id, title: r.job.title, company: r.job.company,
        location: r.job.location, remote: r.job.remote,
        url: r.job.applyUrl || r.job.url, source: r.job.source, sourceKind: r.job.sourceKind,
        archetype: r.job.archetype, seniority: r.job.seniority,
        postedAt: r.job.postedAt,
        salary: r.job.salary ? formatSalary(r.job.salary) : null,
        salaryMid: r.job.salary ? r.job.salary.midAnnual : null,
        score: r.score, matched: r.matched.slice(0, 10), missing: r.missing.slice(0, 8),
        status: byId.get(String(r.job._id)) || null
      }))
    });
  } catch (e) { console.error('jobs matches:', e.message); res.status(500).json({ error: 'Could not load matches' }); }
});

// ── Applied ─────────────────────────────────────────────────────────────────

router.post('/apply/:postingId', verifyToken, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.postingId)) return res.status(400).json({ error: 'Bad id' });
    const job = await JobPosting.findById(req.params.postingId).lean();
    if (!job) return res.status(404).json({ error: 'That posting is no longer here' });

    const profile = await profileFor(req.userId);
    const s = profile.skillNames && profile.skillNames.length ? scorePosting(profile, job) : { score: null, matched: [], missing: [] };
    const status = req.body && req.body.status === 'skipped' ? 'skipped' : 'applied';

    // Upsert, not insert: pressing approve twice, or a retry after a dropped
    // connection, must not produce two applications to the same job.
    await JobApplication.updateOne(
      { userId: req.userId, postingId: job._id },
      {
        $set: {
          title: job.title, company: job.company, url: job.applyUrl || job.url,
          salaryMid: job.salary ? job.salary.midAnnual : null,
          matchScore: s.score, matched: s.matched.slice(0, 12), missing: s.missing.slice(0, 12),
          status, ...(status === 'applied' ? { appliedAt: new Date() } : {})
        }
      },
      { upsert: true }
    );
    res.json({ success: true, status });
  } catch (e) { console.error('jobs apply:', e.message); res.status(500).json({ error: 'Could not record that' }); }
});

router.get('/applications', verifyToken, async (req, res) => {
  try {
    const q = { userId: req.userId };
    if (req.query.status) q.status = req.query.status;
    else q.status = { $in: ['applied', 'responded', 'interview', 'offer', 'rejected'] };
    const apps = await JobApplication.find(q).sort({ appliedAt: -1, updatedAt: -1 }).limit(300).lean();
    res.json({ success: true, applications: apps });
  } catch (e) { console.error('jobs applications:', e.message); res.status(500).json({ error: 'Could not load applications' }); }
});

router.patch('/applications/:id', verifyToken, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const allowed = ['queued', 'applied', 'responded', 'interview', 'offer', 'rejected', 'skipped'];
    const set = {};
    if (req.body.status && allowed.includes(req.body.status)) {
      set.status = req.body.status;
      if (req.body.status === 'applied' && !set.appliedAt) set.appliedAt = new Date();
      if (['responded', 'interview', 'offer', 'rejected'].includes(req.body.status)) set.respondedAt = new Date();
    }
    if (typeof req.body.notes === 'string') set.notes = req.body.notes.slice(0, 4000);
    if (!Object.keys(set).length) return res.status(400).json({ error: 'Nothing to change' });
    const r = await JobApplication.updateOne({ _id: req.params.id, userId: req.userId }, { $set: set });
    if (!r.matchedCount) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (e) { console.error('jobs patch:', e.message); res.status(500).json({ error: 'Could not update' }); }
});

// ── Responses ───────────────────────────────────────────────────────────────

router.get('/responses', verifyToken, async (req, res) => {
  try {
    const apps = await JobApplication.find({
      userId: req.userId,
      $or: [{ status: { $in: ['responded', 'interview', 'offer', 'rejected'] } }, { 'responses.0': { $exists: true } }]
    }).sort({ respondedAt: -1, updatedAt: -1 }).limit(200).lean();
    const counts = { responded: 0, interview: 0, offer: 0, rejected: 0 };
    apps.forEach(a => { if (counts[a.status] != null) counts[a.status]++; });
    res.json({ success: true, responses: apps, counts });
  } catch (e) { console.error('jobs responses:', e.message); res.status(500).json({ error: 'Could not load responses' }); }
});

router.post('/applications/:id/response', verifyToken, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const kind = ['rejection', 'interview', 'offer', 'other'].includes(req.body.kind) ? req.body.kind : 'other';
    const statusFor = { rejection: 'rejected', interview: 'interview', offer: 'offer', other: 'responded' };
    const r = await JobApplication.updateOne({ _id: req.params.id, userId: req.userId }, {
      $push: { responses: { at: new Date(), kind, subject: String(req.body.subject || '').slice(0, 300), excerpt: String(req.body.excerpt || '').slice(0, 2000) } },
      $set: { status: statusFor[kind], respondedAt: new Date() }
    });
    if (!r.matchedCount) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (e) { console.error('jobs response:', e.message); res.status(500).json({ error: 'Could not record that' }); }
});

// ── Ingest ──────────────────────────────────────────────────────────────────

// One run at a time per process. A second click while 155 boards are being
// read would double the outbound traffic for identical results.
let ingesting = false;
router.post('/ingest', verifyToken, async (req, res) => {
  if (ingesting) return res.status(409).json({ error: 'A refresh is already running' });
  ingesting = true;
  try {
    const report = await runIngest({ engineeringOnly: false });
    res.json({ success: true, report });
  } catch (e) {
    console.error('jobs ingest:', e.message);
    res.status(500).json({ error: 'Ingest failed', reason: String(e.message).slice(0, 200) });
  } finally { ingesting = false; }
});

module.exports = router;
