const express = require('express');
const Product = require('../models/Product');
const Review = require('../models/Review');
const User = require('../models/User');
const SharedMap = require('../models/SharedMap');
const Star = require('../models/Star');
const Follow = require('../models/Follow');
const { verifyToken, optionalAuth } = require('../middleware/auth');

const router = express.Router();

// Get feed (products with reviews, paginated)
router.get('/', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
  const skip = (page - 1) * limit;

  try {
    const [products, total] = await Promise.all([
      Product.find()
        .sort({ order: 1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Product.countDocuments()
    ]);

    // Get reviews for these products (excluding hidden ones)
    const productIds = products.map(p => p._id);
    const reviews = await Review.find({
      productId: { $in: productIds },
      hidden: { $ne: true }
    })
      .sort({ createdAt: -1 })
      .populate('authorId', 'firstName lastName profilePhoto profilePhotoThumb')
      .lean();

    // Group reviews by product
    const reviewsByProduct = {};
    reviews.forEach(review => {
      const pid = review.productId.toString();
      if (!reviewsByProduct[pid]) {
        reviewsByProduct[pid] = [];
      }
      reviewsByProduct[pid].push({
        id: review._id,
        rating: review.rating,
        body: review.body,
        author: review.authorId ? {
          id: review.authorId._id,
          firstName: review.authorId.firstName,
          lastName: review.authorId.lastName,
          profilePhoto: review.authorId.profilePhoto,
          profilePhotoThumb: review.authorId.profilePhotoThumb
        } : null,
        createdAt: review.createdAt
      });
    });

    // Attach reviews to products
    const feedItems = products.map(product => ({
      id: product._id,
      name: product.name,
      tagline: product.tagline,
      description: product.description,
      image: product.image,
      status: product.status,
      link: product.link,
      reviews: reviewsByProduct[product._id.toString()] || [],
      createdAt: product.createdAt
    }));

    res.json({
      success: true,
      feed: feedItems,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Get feed error:', error);
    res.status(500).json({ error: 'Failed to get feed' });
  }
});

// Get single product with reviews
router.get('/product/:id', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).lean();

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const reviews = await Review.find({
      productId: product._id,
      hidden: { $ne: true }
    })
      .sort({ createdAt: -1 })
      .populate('authorId', 'firstName lastName profilePhoto profilePhotoThumb')
      .lean();

    const formattedReviews = reviews.map(review => ({
      id: review._id,
      rating: review.rating,
      body: review.body,
      author: review.authorId ? {
        id: review.authorId._id,
        firstName: review.authorId.firstName,
        lastName: review.authorId.lastName,
        profilePhoto: review.authorId.profilePhoto,
        profilePhotoThumb: review.authorId.profilePhotoThumb
      } : null,
      createdAt: review.createdAt
    }));

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
        reviews: formattedReviews,
        createdAt: product.createdAt
      }
    });

  } catch (error) {
    console.error('Get product error:', error);
    res.status(500).json({ error: 'Failed to get product' });
  }
});

// Post a review (one per user per product)
router.post('/product/:id/review', verifyToken, async (req, res) => {
  const { rating, body } = req.body;

  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be between 1 and 5' });
  }

  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // Check for existing review
    const existing = await Review.findOne({
      productId: product._id,
      authorId: req.userId
    });

    if (existing) {
      return res.status(400).json({ error: 'You have already reviewed this product' });
    }

    const review = new Review({
      productId: product._id,
      authorId: req.userId,
      rating: Math.round(rating),
      body: body?.trim()?.slice(0, 1000)
    });

    await review.save();

    // Get author info for response
    const user = await User.findById(req.userId);

    console.log(`Review posted: ${user.email} on ${product.name}`);

    res.json({
      success: true,
      review: {
        id: review._id,
        rating: review.rating,
        body: review.body,
        author: {
          id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          profilePhoto: user.profilePhoto,
          profilePhotoThumb: user.profilePhotoThumb
        },
        createdAt: review.createdAt
      }
    });

  } catch (error) {
    console.error('Post review error:', error);
    res.status(500).json({ error: 'Failed to post review' });
  }
});

// Edit own review
router.put('/review/:id', verifyToken, async (req, res) => {
  const { rating, body } = req.body;

  try {
    const review = await Review.findById(req.params.id);

    if (!review) {
      return res.status(404).json({ error: 'Review not found' });
    }

    // Server-enforced: can only edit own review
    if (review.authorId.toString() !== req.userId) {
      return res.status(403).json({ error: 'Cannot edit another user\'s review' });
    }

    if (rating !== undefined) {
      if (rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'Rating must be between 1 and 5' });
      }
      review.rating = Math.round(rating);
    }

    if (body !== undefined) {
      review.body = body?.trim()?.slice(0, 1000);
    }

    await review.save();

    console.log(`Review edited: ${review._id}`);

    res.json({
      success: true,
      review: {
        id: review._id,
        rating: review.rating,
        body: review.body,
        updatedAt: review.updatedAt
      }
    });

  } catch (error) {
    console.error('Edit review error:', error);
    res.status(500).json({ error: 'Failed to edit review' });
  }
});

// Delete own review
router.delete('/review/:id', verifyToken, async (req, res) => {
  try {
    const review = await Review.findById(req.params.id);

    if (!review) {
      return res.status(404).json({ error: 'Review not found' });
    }

    // Server-enforced: can only delete own review
    if (review.authorId.toString() !== req.userId) {
      return res.status(403).json({ error: 'Cannot delete another user\'s review' });
    }

    await review.deleteOne();

    console.log(`Review deleted: ${req.params.id}`);

    res.json({ success: true });

  } catch (error) {
    console.error('Delete review error:', error);
    res.status(500).json({ error: 'Failed to delete review' });
  }
});

// Get user's own reviews
router.get('/my-reviews', verifyToken, async (req, res) => {
  try {
    const reviews = await Review.find({ authorId: req.userId })
      .sort({ createdAt: -1 })
      .populate('productId', 'name image')
      .lean();

    const formattedReviews = reviews.map(review => ({
      id: review._id,
      rating: review.rating,
      body: review.body,
      product: review.productId ? {
        id: review.productId._id,
        name: review.productId.name,
        image: review.productId.image
      } : null,
      hidden: review.hidden,
      createdAt: review.createdAt
    }));

    res.json({
      success: true,
      reviews: formattedReviews
    });

  } catch (error) {
    console.error('Get my reviews error:', error);
    res.status(500).json({ error: 'Failed to get reviews' });
  }
});

// ============================================================
// SHARED MAP FEED - Blueprint maps shared publicly
// ============================================================

// GET /feed/maps/public - Public shared maps feed
// GET /feed/stats - exact public-map counts for the live homepage counter.
// Total is authoritative; "today" is a true count (not a sampled estimate).
router.get('/stats', async (req, res) => {
  try {
    const base = { visibility: 'public', publishedAt: { $ne: null }, unpublishedAt: null };
    const since = new Date(Date.now() - 86400000);
    const [total, today] = await Promise.all([
      SharedMap.countDocuments(base),
      SharedMap.countDocuments({ ...base, publishedAt: { $gte: since } })
    ]);
    res.json({ success: true, total, today });
  } catch (err) {
    console.error('Feed stats error:', err);
    res.status(500).json({ success: false, error: 'Failed to load stats' });
  }
});

// GET /feed/maps/suggest — instant suggestions for the search dropdown
// (Google-style). Title-prefix first, then title-substring, then creators.
// Fast and forgiving: never errors the client, just returns fewer rows.
router.get('/maps/suggest', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 80);
    if (q.length < 2) return res.json({ success: true, suggestions: [] });
    const escq = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const base = { visibility: 'public', publishedAt: { $ne: null }, unpublishedAt: null };
    const pick = 'title ownerName ownerHandle category starCount';
    const [starts, contains, owners] = await Promise.all([
      SharedMap.find({ ...base, title: { $regex: '(^|[^a-zA-Z0-9])' + escq, $options: 'i' } })
        .sort({ starCount: -1, publishedAt: -1 }).limit(6).select(pick).lean(),
      SharedMap.find({ ...base, title: { $regex: escq, $options: 'i' } })
        .sort({ starCount: -1, publishedAt: -1 }).limit(8).select(pick).lean(),
      SharedMap.find({ ...base, ownerName: { $regex: '^' + escq, $options: 'i' } })
        .sort({ starCount: -1 }).limit(3).select(pick).lean()
    ]);
    const seen = new Set();
    const out = [];
    for (const m of [...starts, ...contains, ...owners]) {
      const id = m._id.toString();
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, title: m.title, ownerName: m.ownerName || 'Clockwork', category: m.category || 'other' });
      if (out.length >= 8) break;
    }
    res.json({ success: true, suggestions: out });
  } catch (e) {
    res.json({ success: true, suggestions: [] });
  }
});

router.get('/maps/public', optionalAuth, async (req, res) => {
  try {
    const {
      sort = 'forks',
      category,
      limit = 30,
      offset = 0,
      search
    } = req.query;

    // Base conditions for all queries
    const baseConditions = {
      visibility: 'public',
      publishedAt: { $ne: null },
      unpublishedAt: null
    };

    // Add category filter if present
    if (category && category !== 'all') {
      baseConditions.category = category;
    }

    let maps;
    let searchTotal = 0;

    if (search && search.trim()) {
      // Search-engine style: wide recall (three nets), then a single relevance
      // ranking — exact > phrase > word-start > substring, title > creator >
      // description, with engagement and freshness as quality signals and real
      // user maps outranking seeds on ties.
      const searchTerm = search.trim().slice(0, 120);
      const parsedLimit = parseInt(limit);
      const parsedOffset = parseInt(offset);
      const escRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const STOP_WORDS = new Set(['how','to','a','an','the','of','in','on','for','and','or','with','my','your','into','from','at','by','as','is','are','be','do','does','i','you','it','that','this','become','becoming','becomes','get','getting','make','making','build','building','learn','learning','guide','map','out']);
      const tokens = searchTerm.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);

      // Recall nets:
      //  1. ALL tokens present somewhere (title/desc/owner) — substring match
      //     so half-typed words still hit ("schoo" → school)
      //  2. Text index — stemmed whole-word relevance ("running" → run)
      //  3. ANY token — so one typo'd word can't zero the results; ranking
      //     naturally sinks the weaker partial matches
      const tokNets = tokens.map(t => {
        const rx = { $regex: escRx(t), $options: 'i' };
        return { $or: [{ title: rx }, { description: rx }, { ownerName: rx }] };
      });
      const andQuery = { ...baseConditions, $and: tokNets };
      const anyQuery = { ...baseConditions, $or: tokNets };
      const textQuery = { ...baseConditions, $text: { $search: searchTerm } };

      const [andR, textR, anyR] = await Promise.all([
        SharedMap.find(andQuery).sort({ starCount: -1, publishedAt: -1 }).limit(500).select('-snapshot').lean(),
        SharedMap.find(textQuery).sort({ score: { $meta: 'textScore' } }).limit(200).select('-snapshot').lean(),
        tokens.length > 1
          ? SharedMap.find(anyQuery).sort({ starCount: -1, publishedAt: -1 }).limit(200).select('-snapshot').lean()
          : Promise.resolve([])
      ]);

      const seen = new Set();
      const cands = [];
      for (const m of [...andR, ...textR, ...anyR]) {
        const id = m._id.toString();
        if (!seen.has(id)) { seen.add(id); cands.push(m); }
      }

      const q = searchTerm.toLowerCase();
      const now = Date.now();
      const scored = cands.map(m => {
        const title = (m.title || '').toLowerCase();
        const descr = (m.description || '').toLowerCase();
        const owner = (m.ownerName || '').toLowerCase();
        let s = 0;
        if (title === q) s += 1000;
        else if (title.startsWith(q)) s += 400;
        else if (title.includes(q)) s += 200;
        if (owner === q) s += 500;
        else if (owner.includes(q)) s += 120;
        let inTitle = 0, distinctiveHit = false;
        for (const t of tokens) {
          // Common words ("how to become an…") shouldn't decide relevance — the
          // distinctive term ("astronaut") should. Stopwords score a fraction.
          const stop = STOP_WORDS.has(t);
          const w = stop ? 0.12 : 1;
          if (new RegExp('(^|[^a-z0-9])' + escRx(t)).test(title)) { s += 60 * w; inTitle++; if (!stop) distinctiveHit = true; }
          else if (title.includes(t)) { s += 25 * w; inTitle++; if (!stop) distinctiveHit = true; }
          else if (descr.includes(t)) { s += 8 * w; if (!stop) distinctiveHit = true; }
          if (owner.includes(t)) s += 15 * w;
        }
        // A result that only matched common words (no distinctive token) is noise
        // unless the whole phrase is in the title — sink it hard.
        const hasDistinctive = tokens.some(t => !STOP_WORDS.has(t));
        if (hasDistinctive && !distinctiveHit && !title.includes(q)) s -= 120;
        if (tokens.length > 1 && inTitle === tokens.length) s += 80;
        s += Math.min(60, Math.log1p((m.starCount || 0) * 2 + (m.forkCount || 0) * 3 + (m.repostCount || 0)) * 12);
        const days = (now - new Date(m.publishedAt || m.createdAt || 0).getTime()) / 86400000;
        s += Math.max(0, 15 - days / 30);
        if (m.isSeed) s -= 25;
        return { m, s };
      }).filter(x => x.s > 0).sort((a, b) => b.s - a.s);

      searchTotal = scored.length;
      maps = scored.slice(parsedOffset, parsedOffset + parsedLimit).map(x => x.m);
    } else {
      // No search - use standard query
      const query = baseConditions;

      // Sort options - default to forks (usefulness)
      // isSeed: 1 ensures real user maps rank above seeds when engagement is equal
      const sortOptions = {
        forks: { forkCount: -1, isSeed: 1, publishedAt: -1 },
        stars: { starCount: -1, isSeed: 1, publishedAt: -1 },
        coverage: { coverage: -1, isSeed: 1, publishedAt: -1 },
        newest: { publishedAt: -1, isSeed: 1 }
      };

      const sortBy = sortOptions[sort] || sortOptions.forks;

      // Fetch maps
      maps = await SharedMap.find(query)
        .sort(sortBy)
        .skip(parseInt(offset))
        .limit(parseInt(limit))
        .select('-snapshot') // Don't send full snapshot in list view
        .lean();
    }

    // If user is logged in, check which maps they've starred/followed
    let userStars = new Set();
    let userFollows = new Set();

    if (req.user) {
      const [stars, follows] = await Promise.all([
        Star.find({ userId: req.user._id, mapId: { $in: maps.map(m => m._id) } }).select('mapId'),
        Follow.find({ followerId: req.user._id }).select('followeeId')
      ]);

      userStars = new Set(stars.map(s => s.mapId.toString()));
      userFollows = new Set(follows.map(f => f.followeeId.toString()));
    }

    // Enrich maps with user-specific data
    const enrichedMaps = maps.map(map => ({
      ...map,
      isStarred: userStars.has(map._id.toString()),
      isFollowing: userFollows.has(map.ownerId?.toString())
    }));

    // Total: search already ranked the full candidate set — its length IS the
    // result count (no re-query, no approximation).
    let total;
    if (search && search.trim()) {
      total = searchTotal;
    } else {
      total = await SharedMap.countDocuments(baseConditions);
    }

    res.json({
      success: true,
      maps: enrichedMaps,
      pagination: {
        total,
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: parseInt(offset) + maps.length < total
      }
    });
  } catch (err) {
    console.error('Maps feed error:', err);
    res.status(500).json({ success: false, error: 'Failed to load feed' });
  }
});

// GET /feed/maps/following - Feed from followed users
router.get('/maps/following', verifyToken, async (req, res) => {
  try {
    const { limit = 30, offset = 0 } = req.query;

    // Get followed user IDs
    const follows = await Follow.find({ followerId: req.userId }).select('followeeId');
    const followeeIds = follows.map(f => f.followeeId);

    if (followeeIds.length === 0) {
      return res.json({
        success: true,
        maps: [],
        pagination: { total: 0, limit: parseInt(limit), offset: parseInt(offset), hasMore: false }
      });
    }

    // Fetch maps from followed users
    const query = {
      ownerId: { $in: followeeIds },
      visibility: 'public',
      publishedAt: { $ne: null },
      unpublishedAt: null
    };

    const maps = await SharedMap.find(query)
      .sort({ publishedAt: -1 })
      .skip(parseInt(offset))
      .limit(parseInt(limit))
      .select('-snapshot')
      .lean();

    // Check stars
    const stars = await Star.find({
      userId: req.userId,
      mapId: { $in: maps.map(m => m._id) }
    }).select('mapId');
    const userStars = new Set(stars.map(s => s.mapId.toString()));

    const enrichedMaps = maps.map(map => ({
      ...map,
      isStarred: userStars.has(map._id.toString()),
      isFollowing: true
    }));

    const total = await SharedMap.countDocuments(query);

    res.json({
      success: true,
      maps: enrichedMaps,
      pagination: {
        total,
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: parseInt(offset) + maps.length < total
      }
    });
  } catch (err) {
    console.error('Following feed error:', err);
    res.status(500).json({ success: false, error: 'Failed to load feed' });
  }
});

// GET /feed/maps/:mapId - Get single shared map with full snapshot
router.get('/maps/:mapId', optionalAuth, async (req, res) => {
  try {
    const map = await SharedMap.findById(req.params.mapId).lean();

    if (!map) {
      return res.status(404).json({ success: false, error: 'Map not found' });
    }

    // Check visibility
    if (map.visibility === 'private') {
      if (!req.user || req.user._id.toString() !== map.ownerId.toString()) {
        return res.status(404).json({ success: false, error: 'Map not found' });
      }
    }

    if (map.unpublishedAt) {
      return res.status(404).json({ success: false, error: 'Map has been unpublished' });
    }

    // Check if user has starred/is following
    let isStarred = false;
    let isFollowing = false;

    if (req.user) {
      const [star, follow] = await Promise.all([
        Star.findOne({ mapId: map._id, userId: req.user._id }),
        Follow.findOne({ followerId: req.user._id, followeeId: map.ownerId })
      ]);
      isStarred = !!star;
      isFollowing = !!follow;
    }

    res.json({
      success: true,
      map: {
        ...map,
        isStarred,
        isFollowing
      }
    });
  } catch (err) {
    console.error('Get map error:', err);
    res.status(500).json({ success: false, error: 'Failed to load map' });
  }
});

// GET /feed/maps/user/:userId - Maps by a specific user
router.get('/maps/user/:userId', optionalAuth, async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;

    const query = {
      ownerId: req.params.userId,
      visibility: 'public',
      publishedAt: { $ne: null },
      unpublishedAt: null
    };

    // If viewing own profile, include unlisted
    if (req.user && req.user._id.toString() === req.params.userId) {
      query.visibility = { $in: ['public', 'unlisted'] };
    }

    const maps = await SharedMap.find(query)
      .sort({ publishedAt: -1 })
      .skip(parseInt(offset))
      .limit(parseInt(limit))
      .select('-snapshot')
      .lean();

    const total = await SharedMap.countDocuments(query);

    res.json({
      success: true,
      maps,
      pagination: {
        total,
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: parseInt(offset) + maps.length < total
      }
    });
  } catch (err) {
    console.error('User maps error:', err);
    res.status(500).json({ success: false, error: 'Failed to load maps' });
  }
});

module.exports = router;
