const express = require('express');
const AnalyticsEvent = require('../models/AnalyticsEvent');
const { verifyToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ==================== PUBLIC TRACKING ====================

// Track an event (no auth required)
router.post('/track', async (req, res) => {
  const { event, app, path, referrer, standalone, sessionId } = req.body;

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
    const analyticsEvent = new AnalyticsEvent({
      event,
      app: app || null,
      path: path || req.headers.referer || null,
      referrer: referrer || req.headers.referer || null,
      userAgent: req.headers['user-agent'] || null,
      sessionId: sessionId || null,
      standalone: standalone === true
    });

    await analyticsEvent.save();

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

    res.json({
      success: true,
      traffic: {
        today: { views: todayViews, visitors: todayVisitors },
        week: { views: weekViews, visitors: weekVisitors },
        month: { views: monthViews, visitors: monthVisitors }
      },
      apps: appStats,
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
