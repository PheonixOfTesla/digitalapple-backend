/**
 * DirectoryController — the AI company directory + reviews + zip-code Spotlight.
 *
 * Public:  GET  /directory/companies         list/search (approved only)
 *          GET  /directory/companies/:id      one company + visible reviews
 *          GET  /directory/spotlight          location-aware picks (visitor zip via ipapi, sent by client)
 * Auth:    POST /directory/companies          submit a company (queued 'pending')
 *          POST /directory/companies/:id/reviews  add/update your review (sign-in required)
 * Admin:   GET  /directory/admin/pending, POST /directory/admin/:id/(approve|reject|feature),
 *          DELETE /directory/admin/:id, POST /directory/admin/reviews/:id/hide
 *
 * Ranking = one blended score across all sources (Clockwork reviews are the
 * backbone; Google/Yelp are optional enrichment). Sort by the Bayesian rankScore.
 */
const express = require('express');
const mongoose = require('mongoose');
const Company = require('../models/Company');
const CompanyReview = require('../models/CompanyReview');
const User = require('../models/User');
const { verifyToken, optionalAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

const PUBLIC_FIELDS = '-submittedBy';

function clampStr(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }

async function authorNameFor(userId, fallbackEmail) {
  try {
    const u = await User.findById(userId).select('firstName lastName email').lean();
    if (u) {
      const nm = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
      if (nm) return nm.slice(0, 80);
      if (u.email) return u.email.split('@')[0].slice(0, 80);
    }
  } catch (e) { /* fall through */ }
  return (fallbackEmail ? String(fallbackEmail).split('@')[0] : 'Member').slice(0, 80);
}

// Recompute a company's Clockwork rating from its visible reviews, then the blend.
async function recomputeClockwork(companyId) {
  const agg = await CompanyReview.aggregate([
    { $match: { companyId: new mongoose.Types.ObjectId(String(companyId)), hidden: { $ne: true } } },
    { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } }
  ]);
  const { avg = 0, count = 0 } = agg[0] || {};
  const company = await Company.findById(companyId);
  if (!company) return null;
  company.ratings.clockwork.avg = +Number(avg || 0).toFixed(3);
  company.ratings.clockwork.count = count || 0;
  company.recomputeScores();
  await company.save();
  return company;
}

function publicReview(r) {
  return {
    id: r._id, rating: r.rating, title: r.title || '', body: r.body || '',
    authorName: r.authorName || 'Member', createdAt: r.createdAt
  };
}

// ==================== PUBLIC ====================

// List / search approved companies.
// ?q= &category= &deployment= &sort=(rank|new|reviews) &page= &limit=
router.get('/companies', optionalAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(48, Math.max(1, parseInt(req.query.limit) || 24));
    const q = clampStr(req.query.q, 120);
    const category = clampStr(req.query.category, 60);
    const deployment = clampStr(req.query.deployment, 20);
    const sort = clampStr(req.query.sort, 12) || 'rank';

    const filter = { status: 'approved' };
    if (category && category !== 'all') filter.category = category;
    if (deployment && deployment !== 'all') filter.deployment = deployment;
    if (q) filter.$text = { $search: q };

    const sortSpec = sort === 'new' ? { approvedAt: -1, createdAt: -1 }
      : sort === 'reviews' ? { aggregateCount: -1, sortScore: -1 }
      : { sortScore: -1, aggregateCount: -1 };  // rank: honest score + adoption boost

    const [companies, total] = await Promise.all([
      Company.find(filter).select(PUBLIC_FIELDS).sort(sortSpec).skip((page - 1) * limit).limit(limit).lean(),
      Company.countDocuments(filter)
    ]);

    res.json({ success: true, companies, page, total, pages: Math.ceil(total / limit) });
  } catch (error) {
    console.error('Directory list error:', error.message);
    res.status(500).json({ error: 'Failed to load directory' });
  }
});

// Distinct categories among approved companies (for filter chips).
router.get('/categories', async (req, res) => {
  try {
    const cats = await Company.distinct('category', { status: 'approved' });
    res.json({ success: true, categories: cats.filter(Boolean).sort() });
  } catch (e) { res.status(500).json({ error: 'Failed to load categories' }); }
});

// Zip-code Spotlight. The client sends the visitor's location (from ipapi):
// ?regionCode=FL&postal=34236&city=Sarasota&country=US
// We surface: featured pins first, then companies HQ'd in the same region/postal,
// then top-ranked as a fallback so the row is never empty.
router.get('/spotlight', optionalAuth, async (req, res) => {
  try {
    const regionCode = clampStr(req.query.regionCode, 12);
    const postal = clampStr(req.query.postal, 16);
    const city = clampStr(req.query.city, 80);
    const limit = Math.min(12, Math.max(3, parseInt(req.query.limit) || 6));

    const base = { status: 'approved' };
    const near = [];
    if (postal) near.push({ 'location.postal': postal });
    if (regionCode) near.push({ 'location.regionCode': regionCode });
    if (city) near.push({ 'location.city': new RegExp('^' + city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') });

    let local = [];
    if (near.length) {
      local = await Company.find({ ...base, $or: near }).select(PUBLIC_FIELDS)
        .sort({ sortScore: -1 }).limit(limit).lean();
    }

    // Fill the rest with featured / top-ranked so the Spotlight always renders.
    const have = new Set(local.map(c => String(c._id)));
    let filler = [];
    if (local.length < limit) {
      filler = await Company.find({ ...base, _id: { $nin: [...have].map(id => new mongoose.Types.ObjectId(id)) } })
        .select(PUBLIC_FIELDS).sort({ sortScore: -1 }).limit(limit - local.length).lean();
    }

    res.json({
      success: true,
      location: { regionCode, postal, city },
      local: local.length,
      companies: [...local, ...filler]
    });
  } catch (error) {
    console.error('Spotlight error:', error.message);
    res.status(500).json({ error: 'Failed to load spotlight' });
  }
});

// One company + its visible reviews (+ your own review if signed in).
router.get('/companies/:id', optionalAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const company = await Company.findOne({ _id: req.params.id, status: 'approved' }).select(PUBLIC_FIELDS).lean();
    if (!company) return res.status(404).json({ error: 'Company not found' });

    const reviews = await CompanyReview.find({ companyId: company._id, hidden: { $ne: true } })
      .sort({ createdAt: -1 }).limit(100).lean();

    let yourReview = null;
    if (req.userId) {
      const mine = reviews.find(r => String(r.authorId) === String(req.userId));
      if (mine) yourReview = publicReview(mine);
    }

    res.json({
      success: true,
      company,
      reviews: reviews.map(publicReview),
      yourReview,
      canReview: !!req.userId
    });
  } catch (error) {
    console.error('Directory get error:', error.message);
    res.status(500).json({ error: 'Failed to load company' });
  }
});

// ==================== AUTH (write) ====================

// Submit a company — queued as 'pending' for admin approval.
router.post('/companies', verifyToken, async (req, res) => {
  try {
    const b = req.body || {};
    const name = clampStr(b.name, 120);
    if (!name) return res.status(400).json({ error: 'Company name is required' });

    // Legal-registration gate: a registration number + jurisdiction are required to
    // even submit. The listing stays pending + unverified until confirmed.
    const legal = b.legal || {};
    const registrationNumber = clampStr(legal.registrationNumber, 60);
    const jurisdiction = clampStr(legal.jurisdiction, 100);
    if (!registrationNumber || !jurisdiction) {
      return res.status(400).json({ error: 'A business registration number and jurisdiction are required — only legally registered businesses can be listed.' });
    }

    const loc = b.location || {};
    const company = new Company({
      name,
      tagline: clampStr(b.tagline, 200),
      description: clampStr(b.description, 2000),
      website: clampStr(b.website, 300),
      logo: clampStr(b.logo, 400) || undefined,
      category: clampStr(b.category, 60) || 'other',
      deployment: ['cloud', 'local', 'self-hosted', 'hybrid'].includes(b.deployment) ? b.deployment : 'unknown',
      dataPolicy: clampStr(b.dataPolicy, 600),
      whyUseThem: clampStr(b.whyUseThem, 600),
      products: Array.isArray(b.products) ? b.products.slice(0, 12).map(p => ({
        name: clampStr(p.name, 100), tagline: clampStr(p.tagline, 160), link: clampStr(p.link, 300)
      })).filter(p => p.name) : [],
      location: {
        city: clampStr(loc.city, 80), region: clampStr(loc.region, 80), regionCode: clampStr(loc.regionCode, 12),
        country: clampStr(loc.country, 60), countryCode: clampStr(loc.countryCode, 4), postal: clampStr(loc.postal, 16)
      },
      legal: {
        registeredName: clampStr(legal.registeredName, 160) || name,
        registrationNumber,
        entityType: clampStr(legal.entityType, 60),
        jurisdiction,
        verified: false
      },
      status: 'pending',
      submittedBy: req.userId,
      submittedName: await authorNameFor(req.userId, req.userEmail)
    });
    company.recomputeScores();
    await company.save();
    require('../models/Notification').pushAdmins({
      type: 'admin_company', text: `New company pending review: ${name}`, link: 'admin.html#directory'
    });
    res.json({ success: true, message: 'Submitted for review. It appears once approved.', id: company._id });
  } catch (error) {
    console.error('Directory submit error:', error.message);
    res.status(500).json({ error: 'Failed to submit company' });
  }
});

// Add or update YOUR review of a company (one per user, sign-in required).
router.post('/companies/:id/reviews', verifyToken, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const company = await Company.findOne({ _id: req.params.id, status: 'approved' });
    if (!company) return res.status(404).json({ error: 'Company not found' });

    const rating = Math.round(Number((req.body || {}).rating));
    if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'Rating must be 1–5' });
    const title = clampStr((req.body || {}).title, 120);
    const body = clampStr((req.body || {}).body, 2000);
    const authorName = await authorNameFor(req.userId, req.userEmail);

    await CompanyReview.findOneAndUpdate(
      { companyId: company._id, authorId: req.userId },
      { $set: { rating, title, body, authorName, hidden: false }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const updated = await recomputeClockwork(company._id);
    require('../models/Notification').pushAdmins({
      type: 'admin_review', text: `New ${rating}★ review on ${company.name} by ${authorName}`, link: 'admin.html#reviews'
    });
    res.json({
      success: true,
      message: 'Review saved.',
      ratings: updated ? updated.ratings : null,
      aggregateScore: updated ? updated.aggregateScore : null,
      aggregateCount: updated ? updated.aggregateCount : null
    });
  } catch (error) {
    console.error('Directory review error:', error.message);
    res.status(500).json({ error: 'Failed to save review' });
  }
});

// ==================== ADMIN (moderation) ====================

router.get('/admin/pending', verifyToken, requireAdmin, async (req, res) => {
  try {
    const companies = await Company.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(100).lean();
    res.json({ success: true, companies });
  } catch (e) { res.status(500).json({ error: 'Failed to load pending' }); }
});

// Aggregate real companies across every industry from Wikidata into the directory.
router.post('/admin/aggregate', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { aggregateCompanies } = require('../jobs/aggregateCompanies');
    const perIndustry = parseInt((req.body || {}).perIndustry) || undefined;
    const result = await aggregateCompanies({ perIndustry });
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('company aggregate:', e.message);
    res.status(500).json({ error: 'Aggregation failed', detail: e.message });
  }
});

// Pull REAL ratings (Google Places / Yelp Fusion) onto companies that don't
// have them yet. Loud preflight: no keys, no run — numbers are never invented.
router.post('/admin/enrich', verifyToken, requireAdmin, async (req, res) => {
  try {
    if (!process.env.GOOGLE_PLACES_API_KEY && !process.env.YELP_API_KEY) {
      return res.status(400).json({
        error: 'No review sources configured',
        detail: 'Set GOOGLE_PLACES_API_KEY and/or YELP_API_KEY as Railway env vars, then run again.'
      });
    }
    const { enrichRatings } = require('../jobs/enrichRatings');
    const limit = parseInt((req.body || {}).limit) || undefined;
    const result = await enrichRatings({ limit });
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('company enrich:', e.message);
    res.status(500).json({ error: 'Enrichment failed', detail: e.message });
  }
});

// Clear imported filler: Wikidata-sourced companies that never picked up a
// single real review from any source. User submissions are never touched.
router.post('/admin/purge-unreviewed', verifyToken, requireAdmin, async (req, res) => {
  try {
    const q = {
      wikidataId: { $exists: true, $nin: [null, ''] },
      $or: [{ aggregateCount: { $in: [null, 0] } }, { aggregateCount: { $exists: false } }]
    };
    const n = await Company.countDocuments(q);
    const r = await Company.deleteMany(q);
    res.json({ success: true, removed: r.deletedCount != null ? r.deletedCount : n });
  } catch (e) {
    console.error('company purge:', e.message);
    res.status(500).json({ error: 'Purge failed', detail: e.message });
  }
});

router.post('/admin/:id/approve', verifyToken, requireAdmin, async (req, res) => {
  try {
    const c = await Company.findByIdAndUpdate(req.params.id,
      { $set: { status: 'approved', approvedAt: new Date() } }, { new: true });
    if (!c) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, company: c });
  } catch (e) { res.status(500).json({ error: 'Failed to approve' }); }
});

router.post('/admin/:id/reject', verifyToken, requireAdmin, async (req, res) => {
  try {
    const c = await Company.findByIdAndUpdate(req.params.id, { $set: { status: 'rejected' } }, { new: true });
    if (!c) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed to reject' }); }
});

router.post('/admin/:id/feature', verifyToken, requireAdmin, async (req, res) => {
  try {
    const c = await Company.findById(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    c.featured = !c.featured; c.recomputeScores(); await c.save();
    res.json({ success: true, featured: c.featured });
  } catch (e) { res.status(500).json({ error: 'Failed to toggle feature' }); }
});

// Confirm the legal registration (the hard gate). Boosts rank + unlocks trust badge.
router.post('/admin/:id/verify', verifyToken, requireAdmin, async (req, res) => {
  try {
    const c = await Company.findById(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    const on = !(c.legal && c.legal.verified);
    c.legal.verified = on;
    c.legal.verifiedAt = on ? new Date() : null;
    c.legal.verificationSource = on ? (clampStr((req.body || {}).source, 120) || 'admin') : '';
    c.recomputeScores(); await c.save();
    res.json({ success: true, verified: c.legal.verified });
  } catch (e) { res.status(500).json({ error: 'Failed to verify' }); }
});

// Mark a company as a Blueprint adopter / partner — ranks it higher on the atlas.
router.post('/admin/:id/adoption', verifyToken, requireAdmin, async (req, res) => {
  try {
    const c = await Company.findById(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    if (typeof b.usesBlueprint === 'boolean') c.usesBlueprint = b.usesBlueprint;
    if (typeof b.partner === 'boolean') c.partner = b.partner;
    c.recomputeScores(); await c.save();
    res.json({ success: true, usesBlueprint: c.usesBlueprint, partner: c.partner });
  } catch (e) { res.status(500).json({ error: 'Failed to update adoption' }); }
});

router.delete('/admin/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    await CompanyReview.deleteMany({ companyId: req.params.id });
    await Company.deleteOne({ _id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed to delete' }); }
});

router.post('/admin/reviews/:reviewId/hide', verifyToken, requireAdmin, async (req, res) => {
  try {
    const r = await CompanyReview.findById(req.params.reviewId);
    if (!r) return res.status(404).json({ error: 'Not found' });
    r.hidden = !r.hidden; await r.save();
    await recomputeClockwork(r.companyId);
    res.json({ success: true, hidden: r.hidden });
  } catch (e) { res.status(500).json({ error: 'Failed to moderate review' }); }
});

module.exports = router;
