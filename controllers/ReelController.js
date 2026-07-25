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

const SYSTEM = `You are the reel writer for Clockwork Hub (theclockworkhub.com), a tool that maps any idea into a complete plan. You write short vertical "Nebula Reels": a topic gets mapped into its parts, then one hidden part is opened up, then the whole thing is shown — ending on "map yours".

VOICE: smart, confident, a little witty — "college genius". Informative and genuinely interesting, the kind of thing people share to look smart. Never cheesy or salesy. Tight, punchy lines.

THE FORMULA (five beats):
1. TOPIC — an intriguing question people actually want answered.
2. BREAKDOWN — the real parts it takes (the nodes).
3. THE TURN — open the ONE part most people miss/underestimate; this is the shareable "whoa".
4. SUMMARY — the whole thing, mapped and keepable (Export).
5. CLOSE — by contrast, the viewer wants their OWN idea mapped this clearly.

Return ONLY a JSON object with EXACTLY these fields:
{
  "theme": one of "cyan" | "gold" | "violet" | "ember" (pick by mood: history/money=gold, science/tech=cyan, mind/psychology=violet, edgy=ember),
  "eyebrow": short kicker like "Nebula · Economics" (2-4 words),
  "hook": the topic as a sharp question (<= 8 words ideal),
  "premise": one clause describing the idea (<= 12 words),
  "nodes": array of 5-6 SHORT labels (1-3 words each) — the real parts of the topic,
  "gap": integer index into nodes of the ONE most surprising/overlooked part (0-based),
  "zoom": { "crumb": "Topic › <that node>", "children": [3 short sub-parts of the gap node, 1-4 words each], "cap": "a punchy line about opening it up" },
  "reveal": "caption for the breakdown (<= 6 words), e.g. 'Every part it takes.'",
  "gapCap": "the surprising insight about the gap node (<= 8 words) — the share-worthy line",
  "summary": { "cap": "caption when the whole map returns (<= 6 words)" },
  "plan": "the payoff/punchline caption (<= 7 words), may use <em>word</em> for accent",
  "cta": "close line, may use <em>word</em>, e.g. 'Map <em>yours.</em>'",
  "url": "theclockworkhub.com",
  "free": "short tag <= 4 words, e.g. 'Free to try'",
  "vo": {
    "text": "ONE continuous ~20-second voiceover following the five beats. Use ellipses (…) at the two big transitions (before opening the part, before the summary) so the motion has room. End with 'Map yours, on Clockwork.'",
    "anchors": { "hook":"", "reveal":"", "gap":"", "zoom":"", "summary":"", "plan":"", "cta":"" }
  },
  "caption": "an Instagram caption in the voice: a strong first line, 1-2 lines of substance, then ONE platform line in plain user language (rotate between: 'Get as specific or general as you need — export the plan as a PDF.' / 'The Atlas is where people share how they actually did things — fork a map and edit it for yourself.' / 'A whole atlas of how people actually did things.'), then 'Map yours — link in bio.' Use line breaks (\\n).",
  "hashtags": array of 10-16 relevant hashtags WITHOUT the # (e.g. "economics", "inflation")
}

CRITICAL: every value in vo.anchors MUST be an exact substring copied from vo.text (used to sync the visuals to the spoken words). The anchors mark, in order, where the hook / breakdown / gap / zoom / summary / plan / close each begin in the text. Keep nodes and children factually real for the topic.`;

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
  s.reveal = String(s.reveal || 'Every part it takes.').slice(0, 60);
  s.gapCap = String(s.gapCap || 'The part most people miss.').slice(0, 80);
  s.summary = { cap: String((s.summary && s.summary.cap) || 'The whole picture.').slice(0, 60) };
  s.plan = String(s.plan || 'Now it’s <em>a plan.</em>').slice(0, 70);
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
    topic: name, title: name
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
      refundUserId: spend.exempt ? null : req.userId   // refund the token if the render fails
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
