/**
 * ReelController — turn any topic into a Nebula Reel spec.
 *
 * POST /api/v1/reels/generate  { topic }  (admin)
 * Uses the shared aiClient (cost-tracked) to author, in the Clockwork
 * "college-genius" voice and the fixed reel formula, a complete spec the
 * nebula-reel template + render pipeline can consume — plus a copy-ready
 * caption and hashtags for that exact topic.
 */
const express = require('express');
const { client, model } = require('../services/aiClient');
const { verifyToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

const THEMES = ['cyan', 'gold', 'violet', 'ember'];

const SYSTEM = `You are the reel writer for Clockwork Hub (theclockworkhub.com). You write vertical "Nebula Reels" that EXPLAIN a topic in three deepening layers. The goal is to genuinely teach the viewer something — an explainer people save and share because they actually learned it — NOT an ad. The product barely gets mentioned.

VOICE: smart, confident, a little witty — "college genius" explaining something fascinating. Informative first. Never salesy, never a pitch. Tight, vivid, concrete lines with real specifics (names, numbers, mechanisms) true to the topic.

THE STRUCTURE — a THREE-LAYER EXPLANATION (go deeper each layer):
LAYER 1 — THE WHOLE: name the topic, then say what it actually is at its core, in plain language. Set up why it's worth understanding.
LAYER 2 — THE PARTS: break the topic into its real components (5-6 of them), then open the ONE part most people overlook and explain what it really is. This is the "I didn't know that" layer.
LAYER 3 — HOW IT WORKS: go one level deeper into that part's mechanism — how the pieces actually interact, why it behaves the way it does. Then pull back and land the whole picture with a mood-matched closing insight (weighty for money/history, precise and awed for science/tech, reflective for mind/psychology, sharp for edgy). This closer is written for THIS topic alone.
SIGN-OFF: a SINGLE quiet, non-pitchy line — a soft credit, e.g. "Mapped on Clockwork." Do NOT invite, sell, or repeat a call to action. One short line, then stop.

Total length: a substantial explainer — roughly 110–150 words (~40–55 seconds spoken). Depth over brevity. It should feel like a great 45-second explainer, not a 20-second promo.

Return ONLY a JSON object with EXACTLY these fields:
{
  "theme": one of "cyan" | "gold" | "violet" | "ember" (pick by mood: history/money=gold, science/tech=cyan, mind/psychology=violet, edgy=ember),
  "eyebrow": short kicker like "Nebula · Economics" (2-4 words),
  "hook": the TOPIC as a sharp line or question (<= 8 words ideal),
  "premise": one clause describing the idea (<= 12 words),
  "nodes": array of 5-6 SHORT labels (1-3 words each) — the real parts of the topic,
  "gap": integer index into nodes of the ONE most surprising/overlooked part (0-based),
  "zoom": { "crumb": "Topic › <that node>", "children": [3 short sub-parts of the gap node, 1-4 words each], "cap": "a punchy line about opening it up" },
  "reveal": "the CORE caption — the central idea in <= 6 words, e.g. 'It all comes down to trust.'",
  "gapCap": "the surprising insight about the gap node (<= 8 words) — the share-worthy line",
  "summary": { "cap": "caption when the whole map returns (<= 6 words)" },
  "plan": "the MOOD-BASED CLOSING INSIGHT caption (<= 7 words) — tone matched to the topic, may use <em>word</em> for accent. The emotional landing of the explanation, NOT a brand line.",
  "cta": "the quiet SIGN-OFF (<= 4 words), soft credit only, e.g. 'Mapped on <em>Clockwork.</em>' — never a call to action.",
  "url": "theclockworkhub.com",
  "free": "short tag <= 4 words, e.g. 'Free to try'",
  "vo": {
    "text": "ONE continuous ~40–55 second voiceover (roughly 110–150 words) that EXPLAINS the topic in three deepening layers: LAYER 1 the whole (name it, then what it really is), LAYER 2 the parts (list the real components, then open the overlooked one and explain it), LAYER 3 how it works (go deeper into that part's mechanism, then land a mood-matched closing insight). Teach with real specifics. Use ellipses (…) at the two transitions (before opening the part, before layer 3). End with a single quiet sign-off like 'Mapped on Clockwork.' — no pitch, no 'map yours', no call to action.",
    "anchors": { "hook":"", "reveal":"", "gap":"", "zoom":"", "summary":"", "plan":"", "cta":"" }
  },
  "caption": "an Instagram caption in the voice: a strong first line, then 2-3 lines of real substance from the explanation (specifics people learn), then ONE plain informational line (rotate: 'Full breakdown mapped out — the kind of thing you can keep.' / 'Every layer, mapped.' / 'Save it — this is the whole picture in one map.'). Keep it teaching-first, not promotional. Use line breaks (\\n).",
  "hashtags": array of 10-16 relevant hashtags WITHOUT the # (e.g. "economics", "inflation")
}

CRITICAL: every value in vo.anchors MUST be an exact substring copied from vo.text (used to sync the visuals to the spoken words). The anchors mark, in order, where each moment begins in the text: hook=LAYER 1 topic name, reveal=the core/what-it-is line, gap=start of LAYER 2 (the parts), zoom=opening the overlooked part, summary=start of LAYER 3 (how it works / pulling the whole picture together), plan=the mood-matched closing insight, cta=the quiet sign-off. Keep nodes and children factually real for the topic.`;

// ---- validation / repair so an imperfect LLM response still renders ----
function repair(spec, topic) {
  const s = (typeof spec === 'object' && spec) ? spec : {};
  s.theme = THEMES.includes(s.theme) ? s.theme : 'cyan';
  s.eyebrow = String(s.eyebrow || 'Nebula').slice(0, 40);
  s.hook = String(s.hook || topic).slice(0, 90);
  s.premise = String(s.premise || '').slice(0, 120);
  s.nodes = Array.isArray(s.nodes) ? s.nodes.map(n => String(n).slice(0, 22)).filter(Boolean).slice(0, 7) : [];
  if (s.nodes.length < 4) s.nodes = s.nodes.concat(['One', 'Two', 'Three', 'Four']).slice(0, 6);
  s.gap = Number.isInteger(s.gap) && s.gap >= 0 && s.gap < s.nodes.length ? s.gap : s.nodes.length - 1;
  const z = (s.zoom && typeof s.zoom === 'object') ? s.zoom : {};
  z.children = Array.isArray(z.children) ? z.children.map(c => String(c).slice(0, 26)).filter(Boolean).slice(0, 3) : [];
  while (z.children.length < 3) z.children.push('—');
  z.crumb = String(z.crumb || (s.hook.split(/[?.]/)[0].slice(0, 22) + ' › ' + s.nodes[s.gap]));
  z.cap = String(z.cap || 'Open it up — it keeps going.').slice(0, 60);
  s.zoom = z;
  s.reveal = String(s.reveal || 'Here’s what it really is.').slice(0, 60);
  s.gapCap = String(s.gapCap || 'The part most people miss.').slice(0, 80);
  s.summary = { cap: String((s.summary && s.summary.cap) || 'The whole picture.').slice(0, 60) };
  s.plan = String(s.plan || 'And that’s the <em>whole story.</em>').slice(0, 70);
  s.cta = String(s.cta || 'Map <em>yours.</em>').slice(0, 60);
  s.url = String(s.url || 'theclockworkhub.com').slice(0, 60);
  s.free = String(s.free || 'Free to try').slice(0, 40);

  const vo = (s.vo && typeof s.vo === 'object') ? s.vo : {};
  vo.text = String(vo.text || '').trim();
  const a = (vo.anchors && typeof vo.anchors === 'object') ? vo.anchors : {};
  // Every anchor must be a real substring of vo.text; drop invalid ones.
  const keys = ['hook', 'reveal', 'gap', 'zoom', 'summary', 'plan', 'cta'];
  vo.anchorsValid = vo.text.length > 0 && keys.every(k => a[k] && vo.text.indexOf(a[k]) >= 0);
  vo.anchors = a;
  s.vo = vo;

  s.caption = String(s.caption || (s.hook + '\n\nMap yours — link in bio.')).slice(0, 600);
  s.hashtags = Array.isArray(s.hashtags) ? s.hashtags.map(h => String(h).replace(/^#/, '').trim()).filter(Boolean).slice(0, 16) : ['clockwork', 'thinkbigger'];
  s.topic = topic;
  return s;
}

router.post('/generate', verifyToken, requireAdmin, async (req, res) => {
  const topic = String((req.body && req.body.topic) || '').trim();
  if (!topic) return res.status(400).json({ error: 'topic required' });
  if (topic.length > 200) return res.status(400).json({ error: 'topic too long' });

  try {
    const resp = await client.chat.completions.create({
      model,
      temperature: 0.85,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Topic: ${topic}\n\nWrite the Nebula Reel spec as JSON.` }
      ]
    });
    let spec;
    try { spec = JSON.parse(resp.choices[0].message.content); }
    catch (e) { return res.status(502).json({ error: 'model returned invalid JSON' }); }
    spec = repair(spec, topic);
    res.json({ success: true, spec });
  } catch (error) {
    console.error('Reel generate error:', error.message);
    res.status(500).json({ error: 'generation failed' });
  }
});

// ==================== MAP → MP4 EXPORT (user-facing) ====================
// Turn a REAL map into a reel spec deterministically (no LLM) and render it.
// Auth required (signup driver for anonymous users); owners or any logged-in
// user on a published (Atlas) map; 3 exports/day for non-admins.

function mapToSpec(project, roots, kidsByParent) {
  const name = (project.name || project.premise || 'My map').slice(0, 80);
  const labels = roots.slice(0, 7).map(r => String(r.constellationLabel || r.title || '').slice(0, 22)).filter(Boolean);
  // gap = the least-resolved root (pending/needs status), else the last one
  let gap = roots.findIndex(r => /pending|needs|open/i.test(r.status || ''));
  if (gap < 0 || gap >= labels.length) gap = Math.max(0, labels.length - 1);
  const gapRoot = roots[gap];
  const kids = (kidsByParent.get(String(gapRoot && gapRoot._id)) || [])
    .slice(0, 3).map(k => String(k.title || '').slice(0, 26));
  while (kids.length < 3) kids.push('—');
  // Beat structure for a map export: THEIR idea (the core) → the extension
  // (a piece opened deeper) → the conclusion (the whole map) → Clockwork close.
  // Voiceover — one continuous line whose phrases are exact anchors for the beats,
  // so the render worker syncs the visuals to the spoken words (and it's never silent).
  const A = {
    hook: 'Let’s break down ' + name + ', in three layers.',
    reveal: 'First, the whole — what it actually is.',
    gap: 'Then the parts it’s built from' + (labels.length ? ': ' + labels.slice(0, 4).join(', ') + '.' : '.'),
    zoom: 'Open the one most people overlook, and it keeps going.',
    summary: 'Go a layer deeper, and you see how the pieces actually work together.',
    plan: 'That is the whole picture — clear, and yours to keep.',
    cta: 'Mapped on Clockwork.'
  };
  const voText = [A.hook, A.reveal, A.gap, A.zoom, A.summary, A.plan, A.cta].join(' ');

  return {
    theme: 'cyan',
    eyebrow: 'A Clockwork Map',
    hook: name,                                        // their idea, verbatim
    premise: (project.premise || '').slice(0, 120),
    nodes: labels.length >= 4 ? labels : labels.concat(['Parts', 'People', 'Money', 'Time']).slice(0, 6),
    gap,
    zoom: { crumb: `${name.slice(0, 22)} › ${(gapRoot && (gapRoot.constellationLabel || gapRoot.title) || 'Detail').slice(0, 22)}`,
            children: kids, cap: 'The extension — it keeps going.' },
    reveal: 'The idea, mapped.',                       // the core
    gapCap: 'The part that goes deeper.',
    summary: { cap: 'The conclusion — the whole picture.' },
    plan: 'From idea to <em>plan.</em>',
    cta: 'Map <em>yours.</em>',                        // the Clockwork tag close
    url: 'theclockworkhub.com', free: 'Free to try',
    topic: name, title: name,
    vo: { text: voText, anchors: A }
  };
}

// POST /reels/render-map { projectId } — render a real map to MP4
router.post('/render-map', verifyToken, async (req, res) => {
  try {
    const Project = require('../models/Project');
    const Node = require('../models/Node');
    const SharedMap = require('../models/SharedMap');
    const LabAsset = require('../models/LabAsset');
    const reelRender = require('../services/reelRender');

    const projectId = (req.body && req.body.projectId || '').toString();
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    const project = await Project.findById(projectId).lean();
    if (!project) return res.status(404).json({ error: 'Map not found' });

    const isOwner = project.ownerId && String(project.ownerId) === String(req.userId);
    const isAdmin = req.userRole === 'admin';
    if (!isOwner && !isAdmin) {
      const shared = await SharedMap.exists({ projectId: project._id });
      if (!shared) return res.status(403).json({ error: 'You can only export your own or published maps' });
    }

    // Recent render of this map? Reuse it — no queue, no token spend.
    const cached = await LabAsset.findOne({ projectId: project._id, createdAt: { $gte: new Date(Date.now() - 86400e3) } })
      .sort({ createdAt: -1 }).lean();
    if (cached) return res.json({ success: true, cached: true, asset: { url: cached.url, name: cached.name } });

    // TOKEN WALL: a video export costs 1 token. spendToken falls through to
    // the nebula free tier at zero balance, so gate on the REAL balance first
    // — no balance, no render. Admins exempt. Refunded if the render fails.
    const User0 = require('../models/User');
    const wallUser = await User0.findById(req.userId).select('role tokenBalance').lean();
    if (!wallUser) return res.status(401).json({ error: 'User not found' });
    if (wallUser.role !== 'admin' && (wallUser.tokenBalance || 0) < 1) {
      return res.status(402).json({
        error: 'out_of_tokens', needsPurchase: true,
        message: 'Video export costs 1 token — purchase tokens to export.'
      });
    }
    const tokenOps = require('./TokenController');
    const spend = await tokenOps.spendToken(req.userId, null, project._id);
    if (!spend.success) {
      return res.status(402).json({
        error: 'out_of_tokens', needsPurchase: true,
        message: 'Video export costs 1 token — purchase tokens to export.'
      });
    }

    const coreNode = await Node.findOne({ projectId: project._id, kind: 'core' }).lean();
    const roots = await Node.find({ projectId: project._id, parentNodeId: coreNode ? coreNode._id : null })
      .sort({ createdAt: 1 }).lean();
    if (!roots.length) return res.status(400).json({ error: 'Map has no nodes to render' });
    const kids = await Node.find({ projectId: project._id, parentNodeId: { $in: roots.map(r => r._id) } }).lean();
    const kidsByParent = new Map();
    kids.forEach(k => { const p = String(k.parentNodeId); if (!kidsByParent.has(p)) kidsByParent.set(p, []); kidsByParent.get(p).push(k); });

    // Creator signature — baked into the rendered video's end card
    const User = require('../models/User');
    const creator = await User.findById(project.ownerId || req.userId).select('firstName lastName email').lean();
    const sigName = creator
      ? (creator.firstName ? `${creator.firstName}${creator.lastName ? ' ' + creator.lastName.charAt(0) + '.' : ''}` : creator.email.split('@')[0])
      : 'a Clockwork user';

    const spec = mapToSpec(project, roots, kidsByParent);
    spec.sig = `Mapped by ${sigName}`;
    const jobId = reelRender.enqueue(spec, {
      kind: 'map-export', ownerId: req.userId, projectId: project._id,
      refundUserId: spend.exempt ? null : req.userId,  // refund the token if the render fails
      // Creator royalty: when someone ELSE pays to export a published map, the
      // token they spent transfers to the map's creator on success.
      royaltyUserId: (!isOwner && !spend.exempt && project.ownerId) ? project.ownerId : null
    });
    res.json({ success: true, jobId, tokenSpent: !spend.exempt, newBalance: spend.newBalance });
  } catch (error) {
    console.error('render-map error:', error.message);
    res.status(503).json({ error: error.message || 'Render unavailable' });
  }
});

// GET /reels/file/:id — stream a GridFS-stored render (public: ids are
// unguessable ObjectIds and these are shareable deliverables). Range support
// so <video> playback works in Safari/iOS.
router.get('/file/:id', async (req, res) => {
  try {
    const mongoose = require('mongoose');
    let oid;
    try { oid = new mongoose.Types.ObjectId(req.params.id); }
    catch (e) { return res.status(400).json({ error: 'Bad id' }); }
    const db = mongoose.connection.db;
    const file = await db.collection('reels.files').findOne({ _id: oid });
    if (!file) return res.status(404).json({ error: 'Not found' });
    const bucket = new mongoose.mongo.GridFSBucket(db, { bucketName: 'reels' });
    const size = file.length;
    res.setHeader('Content-Type', file.contentType || 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Disposition', `${req.query.dl ? 'attachment' : 'inline'}; filename="${(file.filename || 'reel.mp4').replace(/[^\w.\-]/g, '_')}"`);
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
      if (isNaN(start) || start > end) { start = 0; end = size - 1; }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', end - start + 1);
      bucket.openDownloadStream(oid, { start, end: end + 1 }).pipe(res);
    } else {
      res.setHeader('Content-Length', size);
      bucket.openDownloadStream(oid).pipe(res);
    }
  } catch (e) {
    console.error('reel file stream error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Stream failed' });
  }
});

// GET /reels/render-status?id=… — poll (any signed-in user; ids are unguessable)
router.get('/render-status', verifyToken, async (req, res) => {
  const reelRender = require('../services/reelRender');
  const job = await reelRender.status((req.query.id || '').toString());
  if (!job) return res.status(404).json({ error: 'Unknown job' });
  res.json({ success: true, status: job.status, step: job.step, error: job.error, asset: job.asset });
});

module.exports = router;
