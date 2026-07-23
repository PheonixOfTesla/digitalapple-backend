/**
 * NewsController - Public news feed
 *
 * Serves aggregated headlines (RSS) + published Signal entries
 */

const express = require('express');
const NewsItem = require('../models/NewsItem');
const SignalEntry = require('../models/SignalEntry');

const router = express.Router();

// Low-signal academic sources to keep out of the feed.
const EXCLUDED_SOURCES = ['arXiv AI', 'arXiv ML'];

// Fields a "college-genius" reader cares about, in surfacing priority. High-signal,
// lower-volume genres lead so they aren't buried under high-volume tech / Hacker News
// items. This is what makes the feed SPAN fields instead of showing 15 near-identical
// tech posts: tech · markets · science · world · culture · policy · business.
const GENRE_PRIORITY = ['markets', 'science', 'world', 'culture', 'policy', 'ai', 'tech', 'business', 'startup', 'general'];

// Round-robin interleave a recency-sorted pool across genres. Within a genre items
// stay newest-first; across genres they alternate so the top of the feed is a spread.
// 'startup' (Hacker News dev-noise) is capped so it can't flood the feed.
function balanceByGenre(pool, outLimit) {
  const byCat = {};
  for (const it of pool) { const c = it.category || 'general'; (byCat[c] = byCat[c] || []).push(it); }
  const cats = [...new Set([...GENRE_PRIORITY, ...Object.keys(byCat)])].filter(c => byCat[c] && byCat[c].length);
  const startupCap = Math.max(2, Math.ceil((outLimit || 20) * 0.18));
  const out = []; let startupUsed = 0, moved = true;
  while (moved) {
    moved = false;
    for (const c of cats) {
      const arr = byCat[c];
      if (!arr || !arr.length) continue;
      if (c === 'startup' && startupUsed >= startupCap) continue;
      out.push(arr.shift());
      if (c === 'startup') startupUsed++;
      moved = true;
    }
  }
  return out;
}

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
      // Fetch headlines. Exclude low-signal academic sources so previously
      // aggregated arXiv jargon stops surfacing immediately (not just going
      // forward). Also drop the 'research' category and absurdly long titles.
      const headlineQuery = {
        source: { $nin: EXCLUDED_SOURCES },
        category: { $ne: 'research' }
      };
      if (category) headlineQuery.category = category; // explicit filter overrides
      const wantHead = (type === 'headlines') ? (skip + limit) : (Math.floor(limit / 2) + 2);
      let ordered;
      if (category) {
        // Explicit field filter → straight recency within that field.
        ordered = await NewsItem.find(headlineQuery).sort({ publishedAt: -1 }).limit(skip + wantHead).lean();
      } else {
        // Gather the newest items PER genre, so low-volume high-signal fields
        // (science, markets, world, culture) surface even when tech / Hacker News
        // out-publish them 10:1 — a single recency pool would bury them entirely.
        const cats = await NewsItem.distinct('category', headlineQuery);
        const groups = await Promise.all(cats.map(c =>
          NewsItem.find({ ...headlineQuery, category: c }).sort({ publishedAt: -1 }).limit(15).lean()
        ));
        ordered = balanceByGenre(groups.flat(), wantHead);
      }
      const headStart = (type === 'headlines') ? skip : 0;
      const headTake = (type === 'headlines') ? limit : (Math.floor(limit / 2) + 2);
      const headlines = ordered.slice(headStart, headStart + headTake);

      items = items.concat(headlines.map(h => ({
        id: h._id,
        origin: 'aggregated',
        type: 'general',
        title: h.title,
        sourceName: h.source,
        sourceUrl: h.link,
        category: h.category,
        publishedAt: h.publishedAt,
        fetchedAt: h.fetchedAt
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
        origin: 'signal',
        type: s.type,
        title: s.title,
        body: s.body,
        sourceName: s.relatedCompany || 'DigitalApple',
        sourceUrl: s.link,
        relatedCompany: s.relatedCompany,
        relatedProduct: s.relatedProduct,
        publishedAt: s.publishedAt
      })));

      if (type === 'signal') {
        total = await SignalEntry.countDocuments(signalQuery);
      }
    }

    // If fetching both, PRESERVE the genre-balanced headline order and sprinkle in
    // Signal (DigitalApple) entries — a plain recency re-sort would collapse the
    // balance and let the highest-volume feed dominate again.
    if (!type) {
      const heads = items.filter(i => i.origin === 'aggregated');
      const sigs = items.filter(i => i.origin === 'signal');
      const merged = [];
      let si = 0;
      for (let hi = 0; hi < heads.length; hi++) {
        merged.push(heads[hi]);
        if ((hi + 1) % 4 === 0 && si < sigs.length) merged.push(sigs[si++]); // a Signal every ~4
      }
      while (si < sigs.length) merged.push(sigs[si++]);
      items = merged.slice(0, limit);

      const headlineCountQuery = category
        ? { category }
        : { source: { $nin: ['arXiv AI', 'arXiv ML'] }, category: { $ne: 'research' } };
      const [headlineCount, signalCount] = await Promise.all([
        NewsItem.countDocuments(headlineCountQuery),
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
