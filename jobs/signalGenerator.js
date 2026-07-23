/**
 * signalGenerator.js — high-signal, genre-spanning news items built from our own
 * topic picker + the Wikipedia API, instead of flaky RSS feeds.
 *
 * Each signal is a framed, interesting headline for a "college-genius" reader,
 * carrying a REAL Wikipedia citation (source + canonical link). This spans the
 * fields we care about — science · markets · world · history · culture · ideas ·
 * health · sports · gaming · tech — reliably, and every item is sourced.
 *
 * Legal: Wikipedia is CC BY-SA. We store only a framed headline + attribution +
 * link (no article body), consistent with the NewsItem "headlines only" rule.
 */

const NewsItem = require('../models/NewsItem');
const { retrieveCard } = require('../services/retrieval');

// { h: headline (framed, interesting), s: Wikipedia search subject, c: category }
const SIGNAL_TOPICS = [
  // ── Science ──
  { h: 'How mRNA vaccines were actually developed', s: 'messenger RNA vaccine', c: 'science' },
  { h: 'How CRISPR lets scientists edit genes', s: 'CRISPR gene editing', c: 'science' },
  { h: 'How the James Webb telescope sees the early universe', s: 'James Webb Space Telescope', c: 'science' },
  { h: 'How nuclear fusion could power the future', s: 'nuclear fusion', c: 'science' },
  { h: 'How quantum computers actually work', s: 'quantum computing', c: 'science' },
  { h: 'How black holes bend space and time', s: 'black hole', c: 'science' },
  { h: 'How the LHC found the Higgs boson', s: 'Higgs boson', c: 'science' },
  { h: 'How the human genome was first sequenced', s: 'Human Genome Project', c: 'science' },
  { h: 'How neural networks learn', s: 'artificial neural network', c: 'science' },
  { h: 'How photosynthesis feeds the planet', s: 'photosynthesis', c: 'science' },

  // ── Markets / money ──
  { h: 'How compound interest quietly builds fortunes', s: 'compound interest', c: 'markets' },
  { h: 'What the Federal Reserve actually does', s: 'Federal Reserve', c: 'markets' },
  { h: 'How index funds beat most stock pickers', s: 'index fund', c: 'markets' },
  { h: 'How short selling really works', s: 'short (finance)', c: 'markets' },
  { h: 'What causes inflation', s: 'inflation', c: 'markets' },
  { h: 'How high-frequency trading moves markets', s: 'high-frequency trading', c: 'markets' },
  { h: 'How IPOs turn companies public', s: 'initial public offering', c: 'markets' },
  { h: 'What really caused the 2008 financial crisis', s: 'financial crisis of 2007–2008', c: 'markets' },

  // ── World / geopolitics ──
  { h: 'Why the global chip supply chain is a fault line', s: 'semiconductor industry', c: 'world' },
  { h: 'Why Taiwan matters to the whole world', s: 'Taiwan', c: 'world' },
  { h: 'How economic sanctions actually work', s: 'economic sanctions', c: 'world' },
  { h: 'Why the US dollar is the reserve currency', s: 'reserve currency', c: 'world' },
  { h: 'How OPEC influences oil prices', s: 'OPEC', c: 'world' },
  { h: 'Why rare-earth minerals are strategic', s: 'rare-earth element', c: 'world' },

  // ── History ──
  { h: 'What really caused the fall of the Roman Empire', s: 'fall of the Western Roman Empire', c: 'history' },
  { h: 'How the Industrial Revolution remade the world', s: 'Industrial Revolution', c: 'history' },
  { h: 'How the Space Race was won', s: 'Space Race', c: 'history' },
  { h: 'How the printing press changed everything', s: 'printing press', c: 'history' },
  { h: 'How Silicon Valley was born', s: 'Silicon Valley', c: 'history' },
  { h: 'How the Manhattan Project built the bomb', s: 'Manhattan Project', c: 'history' },

  // ── Culture / arts ──
  { h: 'How hip-hop became the sound of a generation', s: 'hip hop music', c: 'culture' },
  { h: 'How the Renaissance reinvented art', s: 'Renaissance', c: 'culture' },
  { h: 'How film noir shaped modern cinema', s: 'film noir', c: 'culture' },
  { h: 'How jazz rewrote the rules of music', s: 'jazz', c: 'culture' },
  { h: 'How streaming changed how we watch everything', s: 'streaming media', c: 'culture' },

  // ── Ideas: psychology & philosophy ──
  { h: 'Why we procrastinate — and how to stop', s: 'procrastination', c: 'ideas' },
  { h: 'How habits are formed in the brain', s: 'habit', c: 'ideas' },
  { h: 'Why cognitive biases fool us', s: 'cognitive bias', c: 'ideas' },
  { h: 'How flow states supercharge focus', s: 'flow (psychology)', c: 'ideas' },
  { h: 'What Stoicism teaches about a good life', s: 'Stoicism', c: 'ideas' },
  { h: 'Why we fear loss more than we value gains', s: 'loss aversion', c: 'ideas' },

  // ── Health / performance ──
  { h: 'How sleep restores the brain', s: 'sleep', c: 'health' },
  { h: 'How muscles actually grow', s: 'muscle hypertrophy', c: 'health' },
  { h: 'How the gut talks to the brain', s: 'gut–brain axis', c: 'health' },
  { h: 'How VO2 max predicts endurance', s: 'VO2 max', c: 'health' },
  { h: 'How caffeine affects the body', s: 'caffeine', c: 'health' },

  // ── Sports ──
  { h: 'How Moneyball changed baseball forever', s: 'Moneyball', c: 'sports' },
  { h: 'How Formula 1 became a global spectacle', s: 'Formula One', c: 'sports' },
  { h: 'How the Premier League got so rich', s: 'Premier League', c: 'sports' },
  { h: 'How NIL deals pay college athletes', s: 'Name, Image and Likeness', c: 'sports' },

  // ── Gaming / tech culture ──
  { h: 'How Minecraft became the best-selling game ever', s: 'Minecraft', c: 'gaming' },
  { h: 'How speedrunning became a culture', s: 'speedrun', c: 'gaming' },
  { h: 'How game engines like Unreal work', s: 'Unreal Engine', c: 'gaming' },

  // ── Tech ──
  { h: 'How the internet actually routes your data', s: 'Internet', c: 'tech' },
  { h: 'How GPS knows where you are', s: 'Global Positioning System', c: 'tech' },
  { h: 'How encryption keeps data secret', s: 'encryption', c: 'tech' },
  { h: 'How lithium-ion batteries store energy', s: 'lithium-ion battery', c: 'tech' }
];

// Round-robin a shuffled-by-genre selection so a run spans fields.
function pickBalanced(topics, n, offset) {
  const byCat = {};
  for (const t of topics) { (byCat[t.c] = byCat[t.c] || []).push(t); }
  const cats = Object.keys(byCat);
  // rotate category start by offset so repeated runs don't always begin with 'science'
  const rot = cats.slice(offset % cats.length).concat(cats.slice(0, offset % cats.length));
  const out = []; let moved = true;
  while (moved && out.length < n) {
    moved = false;
    for (const c of rot) {
      const arr = byCat[c];
      if (arr && arr.length) { out.push(arr.shift()); moved = true; if (out.length >= n) break; }
    }
  }
  return out;
}

/**
 * Generate genre-spanning, Wikipedia-cited signals into the news feed.
 * @param {object} opts { limit=24, concurrency=3 }
 * @returns {Promise<{created:number, failed:number, skipped:number}>}
 */
async function generateSignals({ limit = 24, concurrency = 3 } = {}) {
  const existing = await NewsItem.find({}).select('title link').lean();
  const seenTitles = new Set(existing.map(n => (n.title || '').toLowerCase()));
  const seenLinks = new Set(existing.map(n => n.link));

  const fresh = SIGNAL_TOPICS.filter(t => !seenTitles.has(t.h.toLowerCase()));
  // Offset by how many signals already exist, so repeat runs cover new ground.
  const offset = existing.length % 11;
  const picks = pickBalanced(fresh, limit, offset);

  let created = 0, failed = 0, skipped = 0, idx = 0;
  const now = new Date();
  async function worker() {
    while (idx < picks.length) {
      const t = picks[idx++];
      try {
        const card = await retrieveCard(t.s);
        if (!card || !card.url) { failed++; continue; }
        if (seenLinks.has(card.url)) { skipped++; continue; }
        seenLinks.add(card.url);
        await NewsItem.create({
          title: t.h,
          source: `Wikipedia — ${card.title}`,
          link: card.url,
          category: t.c,
          publishedAt: now,
          fetchedAt: now
        });
        created++;
      } catch (e) {
        if (e && e.code === 11000) { skipped++; } // duplicate link/guid
        else { failed++; console.error('[signals] fail:', t.s, e.message); }
      }
    }
  }
  const conc = Math.max(1, Math.min(4, concurrency));
  await Promise.all(Array.from({ length: conc }, () => worker()));
  console.log(`[signals] created ${created}, failed ${failed}, skipped ${skipped}`);
  return { created, failed, skipped };
}

module.exports = { generateSignals, SIGNAL_TOPICS };
