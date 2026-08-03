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
const { offerOdds, hireOdds, campaignOdds, applicationsFor, observedCallbackRate, versusTarget } = require('../services/jobs/odds');
const { atsTargets } = require('../services/jobs/companies');
const { SOURCES } = require('../services/jobs/sources');
const { autofillScript, bookmarklet } = require('../services/jobs/autofill');
const jwt = require('jsonwebtoken');

const router = express.Router();

// 8MB is far above any real resume and well below anything that would hurt.
// The binary IS kept: a form's file input cannot be satisfied with parsed text.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

async function profileFor(userId) {
  let p = await JobProfile.findOne({ userId }).lean();
  if (!p) p = { userId, skillNames: [], seniority: 'mid', yearsExperience: null, prefs: { remoteOnly: true } };
  // Forms ask for a name and the resume parser does not reliably find one —
  // the biggest text on the page is a name to a human and a heading to a
  // regex. The account has it already.
  if (!p.firstName) {
    const User = require('../models/User');
    const u = await User.findById(userId).select('firstName lastName email').lean();
    if (u) { p.firstName = u.firstName; p.lastName = u.lastName; p.email = p.email || u.email; }
  }
  return p;
}

/**
 * How many roles each employer has open. The odds model uses it as a proxy for
 * how many people are applying — a company with a 300-role board is a company
 * people have heard of.
 */
async function companySizes() {
  const rows = await JobPosting.aggregate([
    { $match: { closed: false } },
    { $group: { _id: '$company', n: { $sum: 1 } } }
  ]);
  const m = new Map();
  rows.forEach(r => m.set(r._id, r.n));
  return m;
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
      pipeline: { queued, applied, responded },
      prefs: profile.prefs || {},
      // The channel every application goes out on, surfaced rather than
      // assumed: it is the only way a reply can reach you.
      contact: {
        email: (profile.contact && (profile.contact.replyTo || profile.contact.email)) || profile.email || null,
        resumeEmail: (profile.contact && profile.contact.email) || profile.email || null,
        replyTo: (profile.contact && profile.contact.replyTo) || null,
        phone: (profile.contact && profile.contact.phone) || profile.phone || null
      },
      // Your real rate, once there is enough of one to mean anything. This is
      // what recalibrates every probability shown.
      callback: await (async () => {
        const apps = await JobApplication.find({ userId: req.userId }).select('appliedAt status responses').lean();
        const { observedRate, observedN } = observedCallbackRate(apps);
        return { rate: observedRate, n: observedN };
      })()
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
        resumeFile: req.file.buffer, resumeMime: req.file.mimetype || null,
        email: p.email, phone: p.phone, github: p.github, linkedin: p.linkedin, links: p.links,
        yearsExperience: p.yearsExperience, seniority: p.seniority, titles: p.titles,
        skills: p.skills, skillNames: p.skillNames, ats: r.ats,
        // The address on the resume is the one employers will actually use.
        'contact.email': p.email, 'contact.phone': p.phone
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

router.patch('/prefs', verifyToken, async (req, res) => {
  try {
    const set = {};
    const n = v => { const x = Math.round(Number(v)); return Number.isFinite(x) && x >= 0 && x <= 2000000 ? x : null; };
    if ('targetBase' in req.body) set['prefs.targetBase'] = req.body.targetBase === null ? null : n(req.body.targetBase);
    if ('minSalary' in req.body) set['prefs.minSalary'] = req.body.minSalary === null ? null : n(req.body.minSalary);
    if ('remoteOnly' in req.body) set['prefs.remoteOnly'] = !!req.body.remoteOnly;
    if (!Object.keys(set).length) return res.status(400).json({ error: 'Nothing to change' });
    await JobProfile.updateOne({ userId: req.userId }, { $set: set }, { upsert: true });
    const p = await profileFor(req.userId);
    res.json({ success: true, prefs: p.prefs });
  } catch (e) { console.error('jobs prefs:', e.message); res.status(500).json({ error: 'Could not save' }); }
});

/**
 * How employers reach you.
 *
 * Worth its own endpoint rather than being buried in prefs: an application is
 * a promise that somebody can answer it, and a reply sent to an address you no
 * longer read is indistinguishable from never hearing back.
 */
router.patch('/contact', verifyToken, async (req, res) => {
  try {
    const clean = (v, max) => v == null ? null : String(v).trim().slice(0, max) || null;
    const email = clean(req.body.email, 200), replyTo = clean(req.body.replyTo, 200);
    for (const [k, v] of [['email', email], ['replyTo', replyTo]]) {
      if (v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) {
        return res.status(400).json({ error: `That ${k === 'replyTo' ? 'reply-to' : 'email'} address does not look right.` });
      }
    }
    const set = {};
    if ('email' in req.body) set['contact.email'] = email;
    if ('phone' in req.body) set['contact.phone'] = clean(req.body.phone, 40);
    if ('replyTo' in req.body) set['contact.replyTo'] = replyTo;
    if (!Object.keys(set).length) return res.status(400).json({ error: 'Nothing to change' });
    await JobProfile.updateOne({ userId: req.userId }, { $set: set }, { upsert: true });
    const p = await profileFor(req.userId);
    res.json({ success: true, contact: p.contact || {} });
  } catch (e) { console.error('jobs contact:', e.message); res.status(500).json({ error: 'Could not save' }); }
});

// ── Autofill ────────────────────────────────────────────────────────────────
/**
 * Applications are submitted from YOUR browser, not from a server.
 *
 * Every ATS that matters gates its form — Greenhouse with an invisible
 * reCAPTCHA, Lever with hCaptcha holding the submit button hostage, Ashby with
 * reCAPTCHA behind a React form. Read from their live pages, not assumed. A
 * headless submitter scores badly on the invisible check and gets dropped
 * silently, which is the worst outcome available: the application never
 * arrives, you believe it did, and the callback rate that calibrates every
 * probability on the console fills with ghosts.
 *
 * So the fill happens where the checks pass on their own — in your session,
 * where you are a real person with real history — and you press Submit.
 *
 * These three routes are token-authenticated rather than header-authenticated
 * because they are called from greenhouse.io, not from our own page.
 */
const AUTOFILL_PURPOSE = 'jobs-autofill';

function autofillToken(userId) {
  return jwt.sign({ id: String(userId), purpose: AUTOFILL_PURPOSE }, process.env.JWT_SECRET, { expiresIn: '90d' });
}
function readAutofillToken(raw) {
  try {
    const d = jwt.verify(String(raw || ''), process.env.JWT_SECRET);
    // A general session token must NOT work here: this one is handed to a
    // third-party page, so it is scoped to exactly this job and nothing else.
    return d && d.purpose === AUTOFILL_PURPOSE ? d.id : null;
  } catch (e) { return null; }
}

// Called cross-origin from the ATS page.
function allowAtsOrigin(req, res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'X-CW-Token, Content-Type');
}

router.get('/autofill/setup', verifyToken, async (req, res) => {
  const p = await profileFor(req.userId);
  const token = autofillToken(req.userId);
  const base = (process.env.PUBLIC_API_URL || 'https://digitalapple-backend-production.up.railway.app').replace(/\/+$/, '');
  res.json({
    success: true,
    bookmarklet: bookmarklet(base, token),
    ready: !!p.resumeFile,
    // Named plainly, because a half-configured autofill that silently skips
    // the resume is worse than one that refuses.
    missing: [!p.resumeFile ? 'resume file (re-upload it — older uploads stored only the text)' : null,
              !(p.contact && (p.contact.replyTo || p.contact.email)) && !p.email ? 'email address' : null].filter(Boolean)
  });
});

router.options('/autofill.js', (req, res) => { allowAtsOrigin(res.req, res); res.sendStatus(204); });
router.get('/autofill.js', async (req, res) => {
  const userId = readAutofillToken(req.query.t);
  allowAtsOrigin(req, res);
  res.type('application/javascript');
  if (!userId) return res.send('alert("Clockwork: this autofill link has expired — regenerate it in the Jobs tab.");');

  const p = await profileFor(userId);
  const base = (process.env.PUBLIC_API_URL || 'https://digitalapple-backend-production.up.railway.app').replace(/\/+$/, '');
  const name = [p.firstName, p.lastName].filter(Boolean).join(' ');
  const titleName = (p.titles && p.titles[0]) || '';
  const cfg = {
    firstName: p.firstName || null, lastName: p.lastName || null,
    fullName: name || null,
    email: (p.contact && (p.contact.replyTo || p.contact.email)) || p.email || null,
    phone: (p.contact && p.contact.phone) || p.phone || null,
    location: (p.prefs && p.prefs.location) || null,
    org: null,
    linkedin: p.linkedin || null, github: p.github || null,
    website: (p.links || []).find(l => !/linkedin|github/i.test(l)) || null,
    resumeUrl: p.resumeFile ? `${base}/api/v1/jobs/autofill/resume` : null,
    resumeName: p.resumeFilename || 'resume.pdf',
    token: String(req.query.t || '')
  };
  res.send('window.__CW_JOBS__=' + JSON.stringify(cfg) + ';\n' + autofillScript());
});

router.options('/autofill/resume', (req, res) => { allowAtsOrigin(res.req, res); res.sendStatus(204); });
router.get('/autofill/resume', async (req, res) => {
  allowAtsOrigin(req, res);
  const userId = readAutofillToken(req.get('X-CW-Token') || req.query.t);
  if (!userId) return res.status(401).json({ error: 'expired' });
  const p = await JobProfile.findOne({ userId }).select('resumeFile resumeMime resumeFilename').lean();
  if (!p || !p.resumeFile) return res.status(404).json({ error: 'no resume stored' });
  res.type(p.resumeMime || 'application/pdf');
  res.set('Content-Disposition', 'inline; filename="' + String(p.resumeFilename || 'resume.pdf').replace(/[^\w.\-]/g, '_') + '"');
  res.send(Buffer.from(p.resumeFile.buffer || p.resumeFile));
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
    const [sizes, myApps] = await Promise.all([
      companySizes(),
      JobApplication.find({ userId: req.userId }).select('appliedAt status responses').lean()
    ]);
    const { observedRate, observedN } = observedCallbackRate(myApps);
    const atsScore = profile.ats ? profile.ats.score : null;
    const oddsFor = (job, fit) => hireOdds(profile, job, fit, {
      companySize: sizes.get(job.company) || 0, atsScore, observedRate, observedN
    });

    const { rows, soonest, highest } = rankArchetypes(profile, postings, { odds: oddsFor });
    // The third ranking, and the one that actually decides: expected value is
    // hire probability times pay, which is the only way to compare a long shot
    // at a lot of money with a likely offer at less.
    // Expected value ranks lanes, but a demotion with good EV is still a
    // demotion — the same rule the soonest column already follows. Below-level
    // lanes sort last rather than heading a column called Best bet.
    const bestBet = [...rows].filter(r => r.evMedian != null)
      .sort((a, b) => {
        const aDown = a.levelDelta < 0, bDown = b.levelDelta < 0;
        if (aDown !== bDown) return aDown ? 1 : -1;
        return b.evMedian - a.evMedian;
      });
    // The question under all the others: will I get hired at all? Nobody
    // applies once, and 1 - (1-p)^N turns a demoralising per-application
    // number into something you can plan a month around.
    const top = bestBet[0] || soonest[0];
    const perApp = top && top.hireMedian ? top.hireMedian : null;
    const applied = myApps.filter(a => a.appliedAt).length;
    const campaign = perApp ? {
      lane: top.archetype,
      perApp,
      applied,
      soFar: campaignOdds(perApp, applied).adjusted,
      milestones: [20, 40, 60, 100].map(n => ({ n, p: campaignOdds(perApp, n).adjusted })),
      for80: applicationsFor(perApp, 0.8),
      for95: applicationsFor(perApp, 0.95)
    } : null;

    res.json({ success: true, needsResume: false, soonest, highest, bestBet, campaign, analysed: postings.length });
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
    let pool = postings;
    // The floor is a filter, not a sort key: a job under it is not a worse
    // option, it is not an option.
    const floor = profile.prefs && profile.prefs.minSalary;
    if (floor) pool = pool.filter(p => !p.salary || !p.salary.midAnnual || p.salary.midAnnual >= floor);
    const ranked = rankPostings(profile, pool, { archetype, remoteOnly, minScore: 0, limit: limit * 2 });

    // Odds need context the matcher does not have: how crowded this employer
    // is, whether the resume parses, and your own real callback rate.
    const [sizes, myApps] = await Promise.all([
      companySizes(),
      JobApplication.find({ userId: req.userId }).select('appliedAt status responses').lean()
    ]);
    const { observedRate, observedN } = observedCallbackRate(myApps);
    const target = (profile.prefs && profile.prefs.targetBase) || null;
    const atsScore = profile.ats ? profile.ats.score : null;

    for (const r of ranked) {
      r.odds = hireOdds(profile, r.job, r, {
        companySize: sizes.get(r.job.company) || 0, atsScore, observedRate, observedN
      });
      r.target = versusTarget(r.job, target);
    }
    // Rank by what the application is WORTH: the chance of it landing, and
    // whether the job clears your number. A 100% skill match on a role that
    // pays under target and has been open six weeks is not the top of a list.
    // Expected value is the only figure that compares two unlike jobs: a 2%
    // shot at $300k beats a 6% shot at $150k, and neither a match score nor a
    // callback rate can say so. Jobs with no stated pay fall back to the hire
    // probability alone rather than being dropped.
    ranked.sort((a, b) => {
      if (a.odds.blocked !== b.odds.blocked) return a.odds.blocked ? 1 : -1;
      const ev = r => r.odds.expectedValue != null ? r.odds.expectedValue : r.odds.hire * 150000;
      const t = r => (r.target && r.target.known && !r.target.meetsAtTop) ? 0.7 : 1;
      return (ev(b) * t(b)) - (ev(a) * t(a));
    });
    ranked.length = Math.min(ranked.length, limit);

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
        odds: { band: r.odds.band, probability: r.odds.probability, blocked: r.odds.blocked,
                blockers: r.odds.blockers, confidence: r.odds.confidence,
                summary: r.odds.summary, factors: r.odds.factors.slice(0, 6),
                // The gauge itself, and the funnel underneath it — one number
                // hides where you actually get eliminated.
                hire: r.odds.hire, hireBand: r.odds.hireBand, hireSummary: r.odds.hireSummary,
                callback: r.odds.callback, conversion: r.odds.conversion,
                gauge: r.odds.gauge, expectedValue: r.odds.expectedValue,
                conversionNotes: (r.odds.conversionNotes || []).slice(0, 3) },
        target: r.target,
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
          ats: job.ats || null,
          contactEmail: (profile.contact && (profile.contact.replyTo || profile.contact.email)) || profile.email || null,
          status, ...(status === 'applied' ? { appliedAt: new Date() } : {})
        }
      },
      { upsert: true }
    );
    res.json({ success: true, status });
  } catch (e) { console.error('jobs apply:', e.message); res.status(500).json({ error: 'Could not record that' }); }
});

/**
 * Queue every role in a lane.
 *
 * Deliberately NOT "mark them all applied". Nothing here submits a form yet,
 * so recording fifty applications that were never sent would corrupt the one
 * number that makes the odds honest — your real callback rate. These are
 * queued, which is a true statement, and each becomes applied when it is.
 *
 * Blocked roles are skipped rather than queued: a job requiring a clearance
 * you do not have should never reach the run list.
 */
router.post('/queue-lane', verifyToken, async (req, res) => {
  try {
    const profile = await profileFor(req.userId);
    if (!profile.skillNames || !profile.skillNames.length) {
      return res.status(400).json({ error: 'Upload a resume first — there is nothing to score against.' });
    }
    const archetype = req.body.archetype || null;
    const remoteOnly = req.body.remoteOnly !== false;
    // Default to queueing EVERYTHING that is not outright blocked. A silent
    // odds floor made "Apply to all 42" queue nothing and say so in six words
    // at the bottom of the page, which reads exactly like a dead button.
    const minOdds = req.body.minOdds == null ? 0 : Number(req.body.minOdds);
    const cap = Math.min(100, parseInt(req.body.limit, 10) || 40);

    let pool = await corpus();
    const floor = profile.prefs && profile.prefs.minSalary;
    if (floor) pool = pool.filter(p => !p.salary || !p.salary.midAnnual || p.salary.midAnnual >= floor);
    const ranked = rankPostings(profile, pool, { archetype, remoteOnly, limit: 400 });

    const [sizes, myApps] = await Promise.all([
      companySizes(),
      JobApplication.find({ userId: req.userId }).select('postingId appliedAt status responses').lean()
    ]);
    const { observedRate, observedN } = observedCallbackRate(myApps);
    const already = new Set(myApps.map(a => String(a.postingId)));
    const atsScore = profile.ats ? profile.ats.score : null;
    const contactEmail = (profile.contact && (profile.contact.replyTo || profile.contact.email)) || profile.email || null;

    const chosen = [];
    let blocked = 0, seen = 0, belowOdds = 0;
    for (const r of ranked) {
      if (already.has(String(r.job._id))) { seen++; continue; }
      const o = offerOdds(profile, r.job, r, { companySize: sizes.get(r.job.company) || 0, atsScore, observedRate, observedN });
      if (o.blocked) { blocked++; continue; }
      if (o.probability < minOdds) { belowOdds++; continue; }
      chosen.push({ r, o });
      if (chosen.length >= cap) break;
    }

    if (chosen.length) {
      await JobApplication.insertMany(chosen.map(({ r, o }) => ({
        userId: req.userId, postingId: r.job._id,
        title: r.job.title, company: r.job.company, url: r.job.applyUrl || r.job.url,
        salaryMid: r.job.salary ? r.job.salary.midAnnual : null,
        ats: r.job.ats || null, contactEmail,
        matchScore: r.score, matched: r.matched.slice(0, 12), missing: r.missing.slice(0, 12),
        status: 'queued', preparedAt: new Date()
      })), { ordered: false }).catch(e => {
        // A duplicate key here means it was already queued, which is fine.
        if (e.code !== 11000) throw e;
      });
    }

    // Zero is an answer that has to explain itself. "0 queued" alone is
    // indistinguishable from a button that does nothing, which is how this
    // got reported as broken.
    let reason = null;
    if (!chosen.length) {
      if (!ranked.length) reason = archetype
        ? `No postings in ${archetype} match your filters. Try turning off Remote only, or clear the salary floor.`
        : 'Nothing matched your filters. Try turning off Remote only, or clear the salary floor.';
      else if (seen && !blocked && !belowOdds) reason = `All ${seen} are already in your list — check the Applied tab.`;
      else if (blocked && blocked >= ranked.length - seen) reason = `All ${blocked} have a hard requirement you do not meet (clearance, PhD, fully onsite).`;
      else if (belowOdds) reason = `${belowOdds} fell below the odds threshold you set.`;
      else reason = 'Nothing new to queue.';
    }

    res.json({
      success: true,
      queued: chosen.length,
      considered: ranked.length,
      skippedAlreadySeen: seen, skippedBlocked: blocked, skippedBelowOdds: belowOdds,
      reason,
      contactEmail,
      note: 'Queued, not submitted. Each one still needs opening — marking them applied without sending would corrupt your callback rate, which is what makes the odds honest.'
    });
  } catch (e) { console.error('jobs queue-lane:', e.message); res.status(500).json({ error: 'Could not queue those' }); }
});

router.get('/applications', verifyToken, async (req, res) => {
  try {
    const q = { userId: req.userId };
    if (req.query.status) q.status = req.query.status;
    else q.status = { $in: ['queued', 'applied', 'responded', 'interview', 'offer', 'rejected'] };
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
