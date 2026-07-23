const express = require('express');
const User = require('../models/User');
const Product = require('../models/Product');
const Review = require('../models/Review');
const SignalEntry = require('../models/SignalEntry');
const Application = require('../models/Application');
const { verifyToken, requireAdmin } = require('../middleware/auth');
const { upload, cloudinary } = require('../config/cloudinary');

const router = express.Router();

// ALL routes require admin role - SERVER-SIDE ENFORCEMENT
router.use(verifyToken);
router.use(requireAdmin);

// ==================== USERS ====================

// List all users
router.get('/users', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;

  try {
    const [users, total] = await Promise.all([
      User.find()
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('-passwordHash -passwordResetToken -pendingEmailToken')
        .lean(),
      User.countDocuments()
    ]);

    const formattedUsers = users.map(user => ({
      id: user._id,
      email: user.email,
      role: user.role,
      firstName: user.firstName,
      lastName: user.lastName,
      profilePhoto: user.profilePhoto,
      marketingOptIn: user.marketingOptIn,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt
    }));

    res.json({
      success: true,
      users: formattedUsers,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Admin list users error:', error);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// Get single user
router.get('/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select('-passwordHash -passwordResetToken -pendingEmailToken')
      .lean();

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      success: true,
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        firstName: user.firstName,
        lastName: user.lastName,
        profilePhoto: user.profilePhoto,
        marketingOptIn: user.marketingOptIn,
        emailVerified: user.emailVerified,
        pendingEmail: user.pendingEmail,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      }
    });

  } catch (error) {
    console.error('Admin get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// Get users with marketing opt-in
router.get('/marketing-list', async (req, res) => {
  try {
    const users = await User.find({ marketingOptIn: true })
      .select('email firstName lastName createdAt')
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      count: users.length,
      users: users.map(u => ({
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        subscribedAt: u.createdAt
      }))
    });

  } catch (error) {
    console.error('Admin marketing list error:', error);
    res.status(500).json({ error: 'Failed to get marketing list' });
  }
});

// ==================== PRODUCTS ====================

// Create product
router.post('/products', async (req, res) => {
  const { name, tagline, description, image, status, link, order } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Product name required' });
  }

  try {
    const product = new Product({
      name: name.trim(),
      tagline: tagline?.trim(),
      description: description?.trim(),
      image,
      status: ['live', 'soon', '2027'].includes(status) ? status : 'soon',
      link: link?.trim(),
      order: order || 0
    });

    await product.save();

    console.log(`Product created: ${product.name}`);

    res.json({
      success: true,
      product: {
        id: product._id,
        name: product.name,
        tagline: product.tagline,
        description: product.description,
        image: product.image,
        status: product.status,
        link: product.link,
        order: product.order,
        createdAt: product.createdAt
      }
    });

  } catch (error) {
    console.error('Admin create product error:', error);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// Update product
router.put('/products/:id', async (req, res) => {
  const { name, tagline, description, image, status, link, order } = req.body;

  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    if (name !== undefined) product.name = name.trim();
    if (tagline !== undefined) product.tagline = tagline?.trim();
    if (description !== undefined) product.description = description?.trim();
    if (image !== undefined) product.image = image;
    if (status !== undefined && ['live', 'soon', '2027'].includes(status)) {
      product.status = status;
    }
    if (link !== undefined) product.link = link?.trim();
    if (order !== undefined) product.order = order;

    await product.save();

    console.log(`Product updated: ${product.name}`);

    res.json({
      success: true,
      product: {
        id: product._id,
        name: product.name,
        tagline: product.tagline,
        description: product.description,
        image: product.image,
        status: product.status,
        link: product.link,
        order: product.order,
        updatedAt: product.updatedAt
      }
    });

  } catch (error) {
    console.error('Admin update product error:', error);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// Delete product
router.delete('/products/:id', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // Delete associated reviews
    await Review.deleteMany({ productId: product._id });

    await product.deleteOne();

    console.log(`Product deleted: ${req.params.id}`);

    res.json({ success: true });

  } catch (error) {
    console.error('Admin delete product error:', error);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// ==================== REVIEWS MODERATION ====================

// List all reviews (including hidden)
router.get('/reviews', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;
  const showHidden = req.query.hidden === 'true';

  try {
    const query = showHidden ? {} : { hidden: { $ne: true } };

    const [reviews, total] = await Promise.all([
      Review.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('authorId', 'email firstName lastName')
        .populate('productId', 'name')
        .lean(),
      Review.countDocuments(query)
    ]);

    const formattedReviews = reviews.map(review => ({
      id: review._id,
      rating: review.rating,
      body: review.body,
      author: review.authorId ? {
        id: review.authorId._id,
        email: review.authorId.email,
        name: `${review.authorId.firstName || ''} ${review.authorId.lastName || ''}`.trim()
      } : null,
      product: review.productId ? {
        id: review.productId._id,
        name: review.productId.name
      } : null,
      hidden: review.hidden,
      hiddenReason: review.hiddenReason,
      createdAt: review.createdAt
    }));

    res.json({
      success: true,
      reviews: formattedReviews,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Admin list reviews error:', error);
    res.status(500).json({ error: 'Failed to list reviews' });
  }
});

// Hide/unhide review (moderate)
router.put('/reviews/:id/moderate', async (req, res) => {
  const { hidden, reason } = req.body;

  try {
    const review = await Review.findById(req.params.id);

    if (!review) {
      return res.status(404).json({ error: 'Review not found' });
    }

    review.hidden = hidden === true;
    review.hiddenReason = hidden ? reason : undefined;
    review.hiddenBy = hidden ? req.userId : undefined;

    await review.save();

    console.log(`Review ${hidden ? 'hidden' : 'unhidden'}: ${review._id}`);

    res.json({
      success: true,
      review: {
        id: review._id,
        hidden: review.hidden,
        hiddenReason: review.hiddenReason
      }
    });

  } catch (error) {
    console.error('Admin moderate review error:', error);
    res.status(500).json({ error: 'Failed to moderate review' });
  }
});

// Delete review (permanent)
router.delete('/reviews/:id', async (req, res) => {
  try {
    const review = await Review.findById(req.params.id);

    if (!review) {
      return res.status(404).json({ error: 'Review not found' });
    }

    await review.deleteOne();

    console.log(`Review deleted by admin: ${req.params.id}`);

    res.json({ success: true });

  } catch (error) {
    console.error('Admin delete review error:', error);
    res.status(500).json({ error: 'Failed to delete review' });
  }
});

// ==================== STATS ====================

router.get('/stats', async (req, res) => {
  try {
    const now = new Date();
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);

    const [userCount, newUsersThisWeek, productCount, reviewCount, marketingCount, pendingApplications, signalCount] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ createdAt: { $gte: weekAgo } }),
      Product.countDocuments(),
      Review.countDocuments(),
      User.countDocuments({ marketingOptIn: true }),
      Application.countDocuments({ status: 'pending' }),
      SignalEntry.countDocuments({ status: 'published' })
    ]);

    res.json({
      success: true,
      stats: {
        users: userCount,
        newUsersThisWeek,
        products: productCount,
        reviews: reviewCount,
        marketingSubscribers: marketingCount,
        pendingApplications,
        signalEntries: signalCount
      }
    });

  } catch (error) {
    console.error('Admin stats error:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// ==================== SIGNAL ENTRIES ====================

// List all Signal entries
router.get('/signal', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;
  const status = req.query.status;

  try {
    const query = status ? { status } : {};

    const [entries, total] = await Promise.all([
      SignalEntry.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('authorId', 'email firstName lastName')
        .lean(),
      SignalEntry.countDocuments(query)
    ]);

    res.json({
      success: true,
      entries: entries.map(e => ({
        id: e._id,
        title: e.title,
        body: e.body,
        type: e.type,
        relatedCompany: e.relatedCompany,
        relatedProduct: e.relatedProduct,
        link: e.link,
        status: e.status,
        publishedAt: e.publishedAt,
        author: e.authorId ? {
          id: e.authorId._id,
          email: e.authorId.email,
          name: `${e.authorId.firstName || ''} ${e.authorId.lastName || ''}`.trim()
        } : null,
        createdAt: e.createdAt
      })),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Admin list signal error:', error);
    res.status(500).json({ error: 'Failed to list signal entries' });
  }
});

// Create Signal entry
router.post('/signal', async (req, res) => {
  const { title, body, type, relatedCompany, relatedProduct, link, status } = req.body;

  if (!title?.trim()) {
    return res.status(400).json({ error: 'Title is required' });
  }
  if (!body?.trim()) {
    return res.status(400).json({ error: 'Body is required' });
  }
  if (!type) {
    return res.status(400).json({ error: 'Type is required' });
  }

  try {
    const entry = new SignalEntry({
      title: title.trim(),
      body: body.trim(),
      type,
      relatedCompany: relatedCompany?.trim(),
      relatedProduct: relatedProduct?.trim(),
      link: link?.trim(),
      authorId: req.userId,
      status: status === 'published' ? 'published' : 'draft',
      publishedAt: status === 'published' ? new Date() : undefined
    });

    await entry.save();

    console.log(`Signal entry created: ${entry.title}`);

    res.json({
      success: true,
      entry: {
        id: entry._id,
        title: entry.title,
        type: entry.type,
        status: entry.status,
        createdAt: entry.createdAt
      }
    });

  } catch (error) {
    console.error('Admin create signal error:', error);
    res.status(500).json({ error: 'Failed to create signal entry' });
  }
});

// Update Signal entry
router.put('/signal/:id', async (req, res) => {
  const { title, body, type, relatedCompany, relatedProduct, link, status } = req.body;

  try {
    const entry = await SignalEntry.findById(req.params.id);

    if (!entry) {
      return res.status(404).json({ error: 'Signal entry not found' });
    }

    if (title !== undefined) entry.title = title.trim();
    if (body !== undefined) entry.body = body.trim();
    if (type !== undefined) entry.type = type;
    if (relatedCompany !== undefined) entry.relatedCompany = relatedCompany?.trim();
    if (relatedProduct !== undefined) entry.relatedProduct = relatedProduct?.trim();
    if (link !== undefined) entry.link = link?.trim();

    // Handle publish status change
    if (status !== undefined) {
      const wasPublished = entry.status === 'published';
      entry.status = status === 'published' ? 'published' : 'draft';
      if (!wasPublished && entry.status === 'published') {
        entry.publishedAt = new Date();
      }
    }

    await entry.save();

    console.log(`Signal entry updated: ${entry.title}`);

    res.json({
      success: true,
      entry: {
        id: entry._id,
        title: entry.title,
        type: entry.type,
        status: entry.status,
        publishedAt: entry.publishedAt,
        updatedAt: entry.updatedAt
      }
    });

  } catch (error) {
    console.error('Admin update signal error:', error);
    res.status(500).json({ error: 'Failed to update signal entry' });
  }
});

// Delete Signal entry
router.delete('/signal/:id', async (req, res) => {
  try {
    const entry = await SignalEntry.findById(req.params.id);

    if (!entry) {
      return res.status(404).json({ error: 'Signal entry not found' });
    }

    await entry.deleteOne();

    console.log(`Signal entry deleted: ${req.params.id}`);

    res.json({ success: true });

  } catch (error) {
    console.error('Admin delete signal error:', error);
    res.status(500).json({ error: 'Failed to delete signal entry' });
  }
});

// ==================== APPLICATIONS ====================

// List all applications
router.get('/applications', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;
  const status = req.query.status;

  try {
    const query = status ? { status } : {};

    const [applications, total] = await Promise.all([
      Application.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('userId', 'email firstName lastName')
        .populate('reviewedBy', 'email firstName lastName')
        .lean(),
      Application.countDocuments(query)
    ]);

    res.json({
      success: true,
      applications: applications.map(app => ({
        id: app._id,
        productName: app.productName,
        company: app.company,
        url: app.url,
        deployment: app.deployment,
        pricing: app.pricing,
        status: app.status,
        submittedBy: app.userId ? {
          id: app.userId._id,
          email: app.userId.email,
          name: `${app.userId.firstName || ''} ${app.userId.lastName || ''}`.trim()
        } : null,
        reviewedBy: app.reviewedBy ? {
          id: app.reviewedBy._id,
          email: app.reviewedBy.email
        } : null,
        reviewedAt: app.reviewedAt,
        createdAt: app.createdAt
      })),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Admin list applications error:', error);
    res.status(500).json({ error: 'Failed to list applications' });
  }
});

// Get single application (full details)
router.get('/applications/:id', async (req, res) => {
  try {
    const application = await Application.findById(req.params.id)
      .populate('userId', 'email firstName lastName')
      .populate('reviewedBy', 'email firstName lastName')
      .lean();

    if (!application) {
      return res.status(404).json({ error: 'Application not found' });
    }

    res.json({
      success: true,
      application: {
        id: application._id,
        productName: application.productName,
        url: application.url,
        company: application.company,
        role: application.role,
        useCase: application.useCase,
        deployment: application.deployment,
        pricing: application.pricing,
        modelUnderneath: application.modelUnderneath,
        description: application.description,
        dataPolicy: application.dataPolicy,
        whyBelongs: application.whyBelongs,
        status: application.status,
        rejectionReason: application.rejectionReason,
        submittedBy: application.userId ? {
          id: application.userId._id,
          email: application.userId.email,
          name: `${application.userId.firstName || ''} ${application.userId.lastName || ''}`.trim()
        } : null,
        reviewedBy: application.reviewedBy ? {
          id: application.reviewedBy._id,
          email: application.reviewedBy.email,
          name: `${application.reviewedBy.firstName || ''} ${application.reviewedBy.lastName || ''}`.trim()
        } : null,
        reviewedAt: application.reviewedAt,
        createdAt: application.createdAt
      }
    });

  } catch (error) {
    console.error('Admin get application error:', error);
    res.status(500).json({ error: 'Failed to fetch application' });
  }
});

// Review application (publish/reject)
router.put('/applications/:id/review', async (req, res) => {
  const { status, rejectionReason } = req.body;

  if (!['published', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Status must be published or rejected' });
  }

  if (status === 'rejected' && !rejectionReason?.trim()) {
    return res.status(400).json({ error: 'Rejection reason is required' });
  }

  try {
    const application = await Application.findById(req.params.id);

    if (!application) {
      return res.status(404).json({ error: 'Application not found' });
    }

    application.status = status;
    application.rejectionReason = status === 'rejected' ? rejectionReason.trim() : undefined;
    application.reviewedAt = new Date();
    application.reviewedBy = req.userId;

    await application.save();

    console.log(`Application ${status}: ${application.productName}`);

    res.json({
      success: true,
      application: {
        id: application._id,
        productName: application.productName,
        status: application.status,
        reviewedAt: application.reviewedAt
      }
    });

  } catch (error) {
    console.error('Admin review application error:', error);
    res.status(500).json({ error: 'Failed to review application' });
  }
});

// Delete application
router.delete('/applications/:id', async (req, res) => {
  try {
    const application = await Application.findById(req.params.id);

    if (!application) {
      return res.status(404).json({ error: 'Application not found' });
    }

    await application.deleteOne();

    console.log(`Application deleted: ${req.params.id}`);

    res.json({ success: true });

  } catch (error) {
    console.error('Admin delete application error:', error);
    res.status(500).json({ error: 'Failed to delete application' });
  }
});

// ==================== SEED MAPS ====================

// Trigger seed map generation (admin only)
router.post('/seed-maps', async (req, res) => {
  const count = Math.min(10, Math.max(1, parseInt(req.query.count) || 5));

  try {
    const { generateSeedMaps } = require('../jobs/seedMaps');
    const result = await generateSeedMaps(count);
    res.json({ success: true, result });
  } catch (error) {
    console.error('Admin seed maps error:', error);
    res.status(500).json({ error: 'Failed to generate seed maps', details: error.message });
  }
});

// ==================== ATLAS BACKFILL (one-click) ====================
// Runs in-process in the background (server has the LLM keys + DB). Resumable,
// so if the process restarts mid-run just trigger it again to continue.

let backfillState = {
  running: false, target: 0, created: 0, failed: 0, need: 0, total: 0,
  startedAt: null, finishedAt: null, error: null
};

// Start (or report already-running).
// POST /admin/atlas/backfill { target } -> generate until the Atlas holds `target` maps
// POST /admin/atlas/backfill { add }    -> generate `add` MORE maps on top of the current total
// `add` wins if both are present. This makes "seed 10 more" behave intuitively even when
// the Atlas already has maps (a plain `target` of 10 would create 0 when 11 already exist).
router.post('/atlas/backfill', async (req, res) => {
  const body = req.body || {};
  const addRaw = parseInt(body.add);
  const useAdd = Number.isFinite(addRaw) && addRaw > 0;

  if (backfillState.running) {
    return res.json({ started: false, alreadyRunning: true, state: backfillState });
  }

  const { backfillTo, getCurrentAtlasCount } = require('../jobs/seedMaps');

  let target;
  if (useAdd) {
    // Resolve the current total now so `add` means "this many NEW maps".
    let current = 0;
    try { current = await getCurrentAtlasCount(); } catch (e) { /* fall back to 0 */ }
    target = Math.min(5000, current + Math.min(5000, addRaw));
  } else {
    target = Math.min(5000, Math.max(1, parseInt(body.target) || 3000));
  }

  backfillState = { running: true, target, created: 0, failed: 0, need: 0, total: 0, startedAt: new Date(), finishedAt: null, error: null };

  // Fire-and-forget: do NOT await — return immediately, run in the background.
  backfillTo(target, { onProgress: (p) => { Object.assign(backfillState, p); } })
    .then((r) => { Object.assign(backfillState, r, { running: false, finishedAt: new Date() }); console.log('[atlas-backfill] done', r); })
    .catch((e) => { backfillState.running = false; backfillState.finishedAt = new Date(); backfillState.error = e.message; console.error('[atlas-backfill] error', e.message); });

  res.json({ started: true, state: backfillState });
});

// Progress. GET /admin/atlas/backfill/status
router.get('/atlas/backfill/status', (req, res) => {
  res.json({ state: backfillState });
});

// Purge real-person seed maps from the Atlas (legal safety). Reversible (soft
// unpublish). GET ?dryRun=1 to preview counts without changing anything.
// POST to actually unpublish.
router.get('/atlas/purge-people', async (req, res) => {
  try {
    const { purgePersonSeeds } = require('../jobs/seedMaps');
    const result = await purgePersonSeeds({ dryRun: true });
    res.json({ success: true, dryRun: true, ...result });
  } catch (e) {
    console.error('[purge-people] preview error', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});
router.post('/atlas/purge-people', async (req, res) => {
  try {
    const { purgePersonSeeds } = require('../jobs/seedMaps');
    const result = await purgePersonSeeds({ dryRun: false });
    console.log('[purge-people] done', result.unpublished, 'unpublished of', result.matched);
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('[purge-people] error', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Generate Wikipedia-sourced, genre-spanning signals into the news feed on demand.
// POST /admin/news/generate-signals  { limit? }
router.post('/news/generate-signals', async (req, res) => {
  try {
    const limit = Math.min(60, Math.max(1, parseInt(req.body && req.body.limit) || 24));
    const { generateSignals } = require('../jobs/signalGenerator');
    const result = await generateSignals({ limit });
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('[generate-signals] error', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Economics — revenue (real, from Stripe purchases) vs estimated AI cost, so admin
// can see profit/loss. AI cost is an ESTIMATE (we don't meter every LLM token),
// tunable via AI_COST_PER_MAP / AI_COST_PER_1K_NODES env vars.
router.get('/economics', async (req, res) => {
  try {
    const TokenLedger = require('../models/TokenLedger');
    const Project = require('../models/Project');
    const SharedMap = require('../models/SharedMap');
    const Node = require('../models/Node');

    const dayAgo = new Date(Date.now() - 86400000);

    const [purchaseAll, purchaseDay, spendAgg, totalMaps, seedMaps, totalNodes] = await Promise.all([
      TokenLedger.aggregate([
        { $match: { reason: 'purchase' } },
        { $group: { _id: null, cents: { $sum: { $ifNull: ['$metadata.amountPaid', 0] } }, tokens: { $sum: '$delta' }, count: { $sum: 1 } } }
      ]),
      TokenLedger.aggregate([
        { $match: { reason: 'purchase', createdAt: { $gte: dayAgo } } },
        { $group: { _id: null, cents: { $sum: { $ifNull: ['$metadata.amountPaid', 0] } } } }
      ]),
      TokenLedger.aggregate([
        { $match: { reason: 'spend' } },
        { $group: { _id: null, tokens: { $sum: { $abs: '$delta' } } } }
      ]),
      Project.countDocuments(),
      SharedMap.countDocuments({ isSeed: true }),
      Node.countDocuments()
    ]);

    const revenueUsd = (purchaseAll[0]?.cents || 0) / 100;
    const revenueTodayUsd = (purchaseDay[0]?.cents || 0) / 100;
    const tokensSold = purchaseAll[0]?.tokens || 0;
    const purchases = purchaseAll[0]?.count || 0;
    const tokensSpent = spendAgg[0]?.tokens || 0;

    // AI cost = REAL tracked LLM tokens (going forward) + an ESTIMATE for the maps
    // generated before tracking was enabled — so the total reflects true spend and
    // is never a misleading $0. The tracked portion grows and dominates over time.
    const aiUsage = require('../services/aiUsage');
    const usage = await aiUsage.getTotals();
    const trackedUsd = usage ? (usage.costUsd || 0) : 0;
    const trackedSince = usage ? (usage.createdAt || null) : null;

    const COST_PER_MAP = parseFloat(process.env.AI_COST_PER_MAP) || 0.03;
    const COST_PER_1K_NODES = parseFloat(process.env.AI_COST_PER_1K_NODES) || 0.50;

    let untrackedMaps = totalMaps;
    if (trackedSince) {
      untrackedMaps = await Project.countDocuments({ createdAt: { $lt: trackedSince } });
    }
    const nodeFrac = totalMaps > 0 ? (untrackedMaps / totalMaps) : 1;
    const historicalEstUsd = untrackedMaps * COST_PER_MAP + (totalNodes * nodeFrac / 1000) * COST_PER_1K_NODES;

    const aiCostUsd = historicalEstUsd + trackedUsd;
    const profitUsd = revenueUsd - aiCostUsd;
    const marginPct = revenueUsd > 0 ? (profitUsd / revenueUsd) * 100 : null;

    res.json({
      success: true,
      revenue: { usd: +revenueUsd.toFixed(2), todayUsd: +revenueTodayUsd.toFixed(2), purchases, tokensSold },
      usage: { mapsGenerated: totalMaps, seedMaps, userMaps: Math.max(0, totalMaps - seedMaps), totalNodes, tokensSpent },
      aiCost: {
        usd: +aiCostUsd.toFixed(2),                     // headline: historical estimate + real tracked
        trackedUsd: +trackedUsd.toFixed(2),             // the precisely-tracked, real portion
        historicalEstUsd: +historicalEstUsd.toFixed(2), // estimate for maps made before tracking
        llmCalls: usage ? (usage.calls || 0) : 0,
        llmTokens: usage ? (usage.totalTokens || 0) : 0,
        tracking: !!trackedSince
      },
      profit: { usd: +profitUsd.toFixed(2), marginPct: marginPct == null ? null : +marginPct.toFixed(0) },
      note: 'Revenue is real (Stripe). AI cost = live-tracked LLM tokens + an estimate for maps generated before tracking was enabled.'
    });
  } catch (e) {
    console.error('[economics] error', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
