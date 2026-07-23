const express = require('express');
const AnalyticsEvent = require('../models/AnalyticsEvent');
const NebulaLog = require('../models/NebulaLog');
const realtime = require('../services/realtime');
const { verifyToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ==================== PUBLIC TRACKING ====================

// Track an event (no auth required)
// Classify a referrer / utm_source into a traffic source bucket.
function classifySource(referrer, utmSource) {
  const u = (utmSource || '').toLowerCase().trim();
  if (u) {
    if (/insta|ig\b/.test(u)) return 'instagram';
    if (/snap/.test(u)) return 'snapchat';
    if (/tiktok|tt\b/.test(u)) return 'tiktok';
    if (/google|adwords|gads|gclid/.test(u)) return 'google';
    if (/face|^fb$/.test(u)) return 'facebook';
    if (/twitter|^x$/.test(u)) return 'twitter';
    if (/reddit/.test(u)) return 'reddit';
    if (/youtube|^yt$/.test(u)) return 'youtube';
    if (/discord/.test(u)) return 'discord';
    if (/linkedin/.test(u)) return 'linkedin';
    return u.replace(/[^a-z0-9_-]/g, '').slice(0, 20) || 'other';
  }
  const r = (referrer || '').toLowerCase();
  if (!r) return 'direct';
  if (/instagram\.com|l\.instagram/.test(r)) return 'instagram';
  if (/snapchat|snpc/.test(r)) return 'snapchat';
  if (/tiktok/.test(r)) return 'tiktok';
  if (/(^|\.)google\./.test(r)) return 'google';
  if (/facebook\.com|fb\.com|l\.facebook|m\.facebook/.test(r)) return 'facebook';
  if (/twitter\.com|t\.co|(^|\.)x\.com/.test(r)) return 'twitter';
  if (/reddit\.com/.test(r)) return 'reddit';
  if (/youtube\.com|youtu\.be/.test(r)) return 'youtube';
  if (/discord/.test(r)) return 'discord';
  if (/bing\.com/.test(r)) return 'bing';
  if (/duckduckgo/.test(r)) return 'duckduckgo';
  if (/linkedin/.test(r)) return 'linkedin';
  if (/theclockworkhub|digitalapple/.test(r)) return 'internal';
  return 'other';
}

router.post('/track', async (req, res) => {
  const { event, app, path, referrer, standalone, sessionId, utmSource, utmMedium, utmCampaign } = req.body;

  if (!event) {
    return res.status(400).json({ error: 'Event name required' });
  }

  // Validate event name (prevent injection of arbitrary events)
  const allowedEvents = [
    'page_view',
    'app_click',
    'install_click',
    'app_installed',
    'standalone_launch',
    'discord_click',
    'instagram_click',
    'creator_click'
  ];

  if (!allowedEvents.includes(event)) {
    return res.status(400).json({ error: 'Invalid event type' });
  }

  try {
    const ref = referrer || req.headers.referer || null;
    const analyticsEvent = new AnalyticsEvent({
      event,
      app: app || null,
      path: path || req.headers.referer || null,
      referrer: ref,
      source: classifySource(ref, utmSource),
      utmSource: utmSource || null,
      utmMedium: utmMedium || null,
      utmCampaign: utmCampaign || null,
      userAgent: req.headers['user-agent'] || null,
      sessionId: sessionId || null,
      standalone: standalone === true
    });

    await analyticsEvent.save();

    // Push to any connected admin dashboards (fire-and-forget).
    realtime.emitAnalytics(analyticsEvent);

    res.json({ success: true });

  } catch (error) {
    console.error('Analytics track error:', error);
    // Fail silently for analytics - don't break the user experience
    res.json({ success: true });
  }
});

// ==================== ADMIN STATS ====================

// Get analytics stats (admin only)
router.get('/stats', verifyToken, requireAdmin, async (req, res) => {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(todayStart);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const monthAgo = new Date(todayStart);
    monthAgo.setDate(monthAgo.getDate() - 30);

    // Get page views
    const [todayViews, weekViews, monthViews] = await Promise.all([
      AnalyticsEvent.countDocuments({ event: 'page_view', createdAt: { $gte: todayStart } }),
      AnalyticsEvent.countDocuments({ event: 'page_view', createdAt: { $gte: weekAgo } }),
      AnalyticsEvent.countDocuments({ event: 'page_view', createdAt: { $gte: monthAgo } })
    ]);

    // Get unique visitors (by sessionId)
    const [todayVisitors, weekVisitors, monthVisitors] = await Promise.all([
      AnalyticsEvent.distinct('sessionId', { event: 'page_view', createdAt: { $gte: todayStart }, sessionId: { $ne: null } }).then(r => r.length),
      AnalyticsEvent.distinct('sessionId', { event: 'page_view', createdAt: { $gte: weekAgo }, sessionId: { $ne: null } }).then(r => r.length),
      AnalyticsEvent.distinct('sessionId', { event: 'page_view', createdAt: { $gte: monthAgo }, sessionId: { $ne: null } }).then(r => r.length)
    ]);

    // Get app-specific stats
    const apps = ['lightning_pass', 'hermes', 'conscious_clothes', 'clockwork'];
    const appStats = {};

    for (const app of apps) {
      const [clicks, installClicks, confirmed, standaloneCount] = await Promise.all([
        AnalyticsEvent.countDocuments({ event: 'app_click', app, createdAt: { $gte: monthAgo } }),
        AnalyticsEvent.countDocuments({ event: 'install_click', app, createdAt: { $gte: monthAgo } }),
        AnalyticsEvent.countDocuments({ event: 'app_installed', app, createdAt: { $gte: monthAgo } }),
        AnalyticsEvent.countDocuments({ event: 'standalone_launch', app, createdAt: { $gte: monthAgo } })
      ]);

      appStats[app] = {
        app_clicks: clicks,
        install_clicks: installClicks,
        confirmed_installs: confirmed,
        standalone_launches: standaloneCount,
        conversion: installClicks > 0 ? ((confirmed / installClicks) * 100).toFixed(1) + '%' : '0%'
      };
    }

    // Get social stats
    const [discordClicks, instagramClicks, creatorClicks] = await Promise.all([
      AnalyticsEvent.countDocuments({ event: 'discord_click', createdAt: { $gte: monthAgo } }),
      AnalyticsEvent.countDocuments({ event: 'instagram_click', createdAt: { $gte: monthAgo } }),
      AnalyticsEvent.countDocuments({ event: 'creator_click', createdAt: { $gte: monthAgo } })
    ]);

    // Traffic-source breakdown — where visitors come from (Instagram, Snapchat,
    // Google, etc.) over the last 30 days. Grouped by classified `source`, with
    // both raw views and unique-session visitors per source.
    const sourceAgg = await AnalyticsEvent.aggregate([
      { $match: { event: 'page_view', createdAt: { $gte: monthAgo } } },
      { $group: {
        _id: { $ifNull: ['$source', 'other'] },
        views: { $sum: 1 },
        sessions: { $addToSet: '$sessionId' }
      } },
      { $project: {
        _id: 0,
        source: '$_id',
        views: 1,
        visitors: {
          $size: {
            $filter: { input: '$sessions', as: 's', cond: { $ne: ['$$s', null] } }
          }
        }
      } },
      { $sort: { views: -1 } }
    ]);

    res.json({
      success: true,
      traffic: {
        today: { views: todayViews, visitors: todayVisitors },
        week: { views: weekViews, visitors: weekVisitors },
        month: { views: monthViews, visitors: monthVisitors }
      },
      apps: appStats,
      sources: sourceAgg,
      social: {
        discord_clicks: discordClicks,
        instagram_clicks: instagramClicks,
        creator_clicks: creatorClicks
      }
    });

  } catch (error) {
    console.error('Analytics stats error:', error);
    res.status(500).json({ error: 'Failed to get analytics stats' });
  }
});

// Nebula creation tracker (admin only)
// Who is creating nebulas (anonymous vs registered) and what they made.
router.get('/nebulas', verifyToken, requireAdmin, async (req, res) => {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(todayStart); weekAgo.setDate(weekAgo.getDate() - 7);
    const monthAgo = new Date(todayStart); monthAgo.setDate(monthAgo.getDate() - 30);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 40));

    const countBy = async (match) => {
      const rows = await NebulaLog.aggregate([
        { $match: match },
        { $group: { _id: '$creatorType', n: { $sum: 1 } } }
      ]);
      const out = { anonymous: 0, registered: 0, total: 0 };
      rows.forEach(r => { out[r._id] = r.n; out.total += r.n; });
      return out;
    };

    const [total, today, week, month, byType, recent] = await Promise.all([
      countBy({}),
      countBy({ createdAt: { $gte: todayStart } }),
      countBy({ createdAt: { $gte: weekAgo } }),
      countBy({ createdAt: { $gte: monthAgo } }),
      NebulaLog.aggregate([
        { $match: { createdAt: { $gte: monthAgo } } },
        { $group: { _id: { $ifNull: ['$classificationType', 'unknown'] }, n: { $sum: 1 } } },
        { $sort: { n: -1 } }
      ]),
      NebulaLog.find({})
        .sort({ createdAt: -1 })
        .limit(limit)
        .populate('ownerId', 'email name')
        .lean()
    ]);

    const recentClean = recent.map(r => ({
      creatorType: r.creatorType,
      who: r.creatorType === 'registered'
        ? (r.ownerId?.email || r.ownerId?.name || 'registered user')
        : 'anonymous',
      title: r.title || r.premise || '(untitled)',
      premise: r.premise || '',
      type: r.classificationType || 'unknown',
      forked: !!r.forked,
      forkedFromTitle: r.forkedFromTitle || null,
      createdAt: r.createdAt
    }));

    res.json({
      success: true,
      summary: { total, today, week, month },
      byType: byType.map(t => ({ type: t._id, count: t.n })),
      recent: recentClean
    });
  } catch (error) {
    console.error('Nebula tracker error:', error);
    res.status(500).json({ error: 'Failed to get nebula tracker' });
  }
});

// Get detailed events (admin only)
router.get('/events', verifyToken, requireAdmin, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
  const skip = (page - 1) * limit;
  const eventType = req.query.event || null;

  try {
    const query = eventType ? { event: eventType } : {};

    const [events, total] = await Promise.all([
      AnalyticsEvent.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AnalyticsEvent.countDocuments(query)
    ]);

    res.json({
      success: true,
      events,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Analytics events error:', error);
    res.status(500).json({ error: 'Failed to get events' });
  }
});

module.exports = router;
