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
  "caption": "an Instagram caption in the voice: a strong first line, 1-2 lines of substance, then 'Map yours — link in bio.' Use line breaks (\\n).",
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

module.exports = router;
