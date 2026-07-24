const express = require('express');
const mongoose = require('mongoose');
const AnalyticsEvent = require('../models/AnalyticsEvent');
const NebulaLog = require('../models/NebulaLog');
const Project = require('../models/Project');
const Node = require('../models/Node');
const realtime = require('../services/realtime');
const { verifyToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

const oid = (v) => (v && mongoose.Types.ObjectId.isValid(v)) ? new mongoose.Types.ObjectId(v) : null;

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
  const { event, app, path, referrer, standalone, sessionId, cwSessionId, userId, utmSource, utmMedium, utmCampaign } = req.body;

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
    'creator_click',
    // Booking funnel (Chart / consultation page)
    'booking_view',
    'booking_start',
    'booking_submit',
    // Viewing a shared map / nebula
    'map_open'
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
      cwSessionId: cwSessionId || null,
      userId: oid(userId),          // client-reported; analytics linkage only
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
    // Google, etc.) over the last 30 days. We group by the RAW referrer/UTM and
    // classify each group in JS, so EVERY event is bucketed consistently —
    // including ones logged before the `source` field existed (source=null),
    // which would otherwise all pile into "Other" even when their referrer is
    // known (or empty, i.e. "Direct").
    const rawSourceAgg = await AnalyticsEvent.aggregate([
      { $match: { event: 'page_view', createdAt: { $gte: monthAgo } } },
      { $group: {
        _id: { source: '$source', referrer: '$referrer', utmSource: '$utmSource' },
        views: { $sum: 1 },
        sessions: { $addToSet: '$sessionId' }
      } }
    ]);

    const sourceBuckets = {};
    for (const g of rawSourceAgg) {
      // Trust a stored classification; otherwise derive it from the referrer/UTM.
      const src = g._id.source || classifySource(g._id.referrer, g._id.utmSource);
      if (!sourceBuckets[src]) sourceBuckets[src] = { views: 0, sessions: new Set() };
      sourceBuckets[src].views += g.views;
      for (const s of (g.sessions || [])) if (s) sourceBuckets[src].sessions.add(s);
    }
    const sourceAgg = Object.entries(sourceBuckets)
      .map(([source, v]) => ({ source, views: v.views, visitors: v.sessions.size }))
      .sort((a, b) => b.views - a.views);

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
      id: r._id,
      creatorType: r.creatorType,
      who: r.creatorType === 'registered'
        ? (r.ownerId?.email || r.ownerId?.name || 'registered user')
        : 'anonymous',
      title: r.title || r.premise || '(untitled)',
      premise: r.premise || '',
      type: r.classificationType || 'unknown',
      forked: !!r.forked,
      forkedFromTitle: r.forkedFromTitle || null,
      hasProject: !!r.projectId,
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

// ==================== BOOKING FUNNEL ====================
// Reached the booking page → began booking → actually booked, with conversion.
router.get('/funnel', verifyToken, requireAdmin, async (req, res) => {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(todayStart); weekAgo.setDate(weekAgo.getDate() - 7);
    const monthAgo = new Date(todayStart); monthAgo.setDate(monthAgo.getDate() - 30);

    const stageIn = async (since) => {
      const [view, start, book, visitors] = await Promise.all([
        AnalyticsEvent.countDocuments({ event: 'booking_view', createdAt: { $gte: since } }),
        AnalyticsEvent.countDocuments({ event: 'booking_start', createdAt: { $gte: since } }),
        AnalyticsEvent.countDocuments({ event: 'booking_submit', createdAt: { $gte: since } }),
        AnalyticsEvent.distinct('sessionId', { event: 'booking_view', createdAt: { $gte: since }, sessionId: { $ne: null } }).then(r => r.length)
      ]);
      const pct = (a, b) => b > 0 ? +((a / b) * 100).toFixed(1) : 0;
      return {
        reached: view, visitors, started: start, booked: book,
        startRate: pct(start, view),          // reached → started
        bookRate: pct(book, start),           // started → booked
        conversion: pct(book, view)           // reached → booked (overall)
      };
    };

    const [today, week, month] = await Promise.all([stageIn(todayStart), stageIn(weekAgo), stageIn(monthAgo)]);

    // Where booking-page visitors came from (last 30 days)
    const srcAgg = await AnalyticsEvent.aggregate([
      { $match: { event: 'booking_view', createdAt: { $gte: monthAgo } } },
      { $group: { _id: '$source', n: { $sum: 1 } } },
      { $sort: { n: -1 } }
    ]);

    res.json({
      success: true,
      funnel: { today, week, month },
      sources: srcAgg.map(s => ({ source: s._id || 'direct', count: s.n }))
    });
  } catch (error) {
    console.error('Booking funnel error:', error);
    res.status(500).json({ error: 'Failed to get booking funnel' });
  }
});

// ==================== NEBULA DETAIL ("Open") ====================
// What a specific creator MADE (the map) and what they SAW (their activity).
router.get('/nebulas/:id/detail', verifyToken, requireAdmin, async (req, res) => {
  try {
    const log = await NebulaLog.findById(req.params.id).populate('ownerId', 'email name').lean();
    if (!log) return res.status(404).json({ error: 'Nebula not found' });

    // --- What they created: the project + its nodes (may be gone if anon+expired) ---
    let map = { available: false, reason: 'no-project' };
    if (log.projectId) {
      const project = await Project.findById(log.projectId).lean();
      if (project) {
        const nodes = await Node.find({ projectId: project._id })
          .select('title statement kind parentNodeId determination createdAt')
          .sort({ createdAt: 1 })
          .lean();
        map = {
          available: true,
          name: project.name,
          premise: project.premise || log.premise || '',
          classification: project.blueprint?.classification?.type || log.classificationType || 'unknown',
          nodeCount: nodes.length,
          nodes: nodes.map(n => ({
            title: n.title || '(untitled)',
            statement: n.statement || '',
            kind: n.kind || null,
            determination: n.determination || null,
            hasParent: !!n.parentNodeId
          }))
        };
      } else {
        map = { available: false, reason: 'expired' };  // anonymous Project TTL'd
      }
    }

    // --- What they saw: their analytics activity trail ---
    const or = [];
    const ownerId = log.ownerId?._id || log.ownerId;
    if (ownerId) or.push({ userId: ownerId });
    if (log.anonymousSessionId) or.push({ cwSessionId: log.anonymousSessionId });

    let activity = [];
    if (or.length) {
      activity = await AnalyticsEvent.find({ $or: or })
        .sort({ createdAt: -1 })
        .limit(150)
        .select('event path source app createdAt standalone')
        .lean();
    }

    res.json({
      success: true,
      nebula: {
        id: log._id,
        creatorType: log.creatorType,
        who: log.creatorType === 'registered'
          ? (log.ownerId?.email || log.ownerId?.name || 'registered user')
          : 'anonymous',
        title: log.title || log.premise || '(untitled)',
        type: log.classificationType || 'unknown',
        forked: !!log.forked,
        forkedFromTitle: log.forkedFromTitle || null,
        createdAt: log.createdAt
      },
      map,
      activity: activity.map(a => ({
        event: a.event, path: a.path || null, source: a.source || null,
        app: a.app || null, at: a.createdAt
      })),
      activityLinked: or.length > 0
    });
  } catch (error) {
    console.error('Nebula detail error:', error);
    res.status(500).json({ error: 'Failed to get nebula detail' });
  }
});

module.exports = router;
