/**
 * NewsController - Public news feed
 *
 * Serves aggregated headlines (RSS) + published Signal entries
 */

const express = require('express');
const NewsItem = require('../models/NewsItem');
const SignalEntry = require('../models/SignalEntry');

const router = express.Router();

// Get news feed (headlines + signal entries combined)
router.get('/', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;
  const category = req.query.category;
  const type = req.query.type; // 'headlines', 'signal', or undefined for both

  try {
    let items = [];
    let total = 0;

    if (type === 'headlines' || !type) {
      // Fetch headlines
      const headlineQuery = category ? { category } : {};
      const headlines = await NewsItem.find(headlineQuery)
        .sort({ publishedAt: -1 })
        .skip(type === 'headlines' ? skip : 0)
        .limit(type === 'headlines' ? limit : Math.floor(limit / 2))
        .lean();

      items = items.concat(headlines.map(h => ({
        id: h._id,
        type: 'headline',
        title: h.title,
        source: h.source,
        link: h.link,
        category: h.category,
        publishedAt: h.publishedAt
      })));

      if (type === 'headlines') {
        total = await NewsItem.countDocuments(headlineQuery);
      }
    }

    if (type === 'signal' || !type) {
      // Fetch published Signal entries
      const signalQuery = { status: 'published' };
      const signals = await SignalEntry.find(signalQuery)
        .sort({ publishedAt: -1 })
        .skip(type === 'signal' ? skip : 0)
        .limit(type === 'signal' ? limit : Math.floor(limit / 2))
        .lean();

      items = items.concat(signals.map(s => ({
        id: s._id,
        type: 'signal',
        signalType: s.type,
        title: s.title,
        body: s.body,
        relatedCompany: s.relatedCompany,
        relatedProduct: s.relatedProduct,
        link: s.link,
        publishedAt: s.publishedAt
      })));

      if (type === 'signal') {
        total = await SignalEntry.countDocuments(signalQuery);
      }
    }

    // If fetching both, sort by publishedAt and paginate
    if (!type) {
      items.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
      items = items.slice(0, limit);

      const [headlineCount, signalCount] = await Promise.all([
        NewsItem.countDocuments(category ? { category } : {}),
        SignalEntry.countDocuments({ status: 'published' })
      ]);
      total = headlineCount + signalCount;
    }

    res.json({
      success: true,
      items,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('News feed error:', error);
    res.status(500).json({ error: 'Failed to fetch news' });
  }
});

// Get single Signal entry
router.get('/signal/:id', async (req, res) => {
  try {
    const entry = await SignalEntry.findOne({
      _id: req.params.id,
      status: 'published'
    }).lean();

    if (!entry) {
      return res.status(404).json({ error: 'Entry not found' });
    }

    res.json({
      success: true,
      entry: {
        id: entry._id,
        type: entry.type,
        title: entry.title,
        body: entry.body,
        relatedCompany: entry.relatedCompany,
        relatedProduct: entry.relatedProduct,
        link: entry.link,
        publishedAt: entry.publishedAt
      }
    });

  } catch (error) {
    console.error('Get signal entry error:', error);
    res.status(500).json({ error: 'Failed to fetch entry' });
  }
});

// Get categories with counts
router.get('/categories', async (req, res) => {
  try {
    const categories = await NewsItem.aggregate([
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    res.json({
      success: true,
      categories: categories.map(c => ({
        name: c._id,
        count: c.count
      }))
    });

  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

module.exports = router;
