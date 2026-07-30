/**
 * RSS Aggregator Job
 *
 * Fetches headlines from configured RSS feeds hourly.
 * IMPORTANT: Only stores title, source, timestamp, link - NEVER full text.
 */

const Parser = require('rss-parser');
const NewsItem = require('../models/NewsItem');

const parser = new Parser({
  timeout: 10000,
  headers: {
    'User-Agent': 'DigitalApple-NewsBot/1.0'
  }
});

// RSS feed sources - headlines only for legal compliance
const { anyBlocked } = require('../services/contentFilter');

const RSS_FEEDS = [
  // AI/Tech news sources
  { url: 'https://techcrunch.com/category/artificial-intelligence/feed/', source: 'TechCrunch', category: 'ai' },
  { url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', source: 'The Verge', category: 'ai' },
  { url: 'https://feeds.arstechnica.com/arstechnica/technology-lab', source: 'Ars Technica', category: 'tech' },
  { url: 'https://www.wired.com/feed/category/artificial-intelligence/latest/rss', source: 'Wired', category: 'ai' },
  { url: 'https://venturebeat.com/category/ai/feed/', source: 'VentureBeat', category: 'ai' },
  { url: 'https://www.technologyreview.com/feed/', source: 'MIT Tech Review', category: 'ai' },

  // NOTE: arXiv (cs.AI / cs.LG) feeds removed — raw paper titles read as dense
  // academic jargon ("nonsense") in a general Signal feed. Curated,
  // reader-friendly outlets only.

  // Science / research — high-signal, tech-adjacent only. General-news feeds
  // (BBC World/Business/Culture, Guardian World) were REMOVED: they surfaced
  // off-topic human-interest headlines ("Volunteer scheme credited with
  // changing man's life") that have nothing to do with an AI & tech Signal.
  { url: 'https://www.quantamagazine.org/feed/', source: 'Quanta', category: 'science' },
  { url: 'https://www.sciencedaily.com/rss/computers_math/artificial_intelligence.xml', source: 'ScienceDaily AI', category: 'ai' },
  { url: 'https://www.nasa.gov/news-release/feed/', source: 'NASA', category: 'science' },

  // Space — one NASA press feed was the whole of it, and it publishes a few
  // times a week, so 'space' news went stale between releases. These add daily
  // volume from the agencies and the beat press.
  { url: 'https://www.esa.int/rssfeed/Our_Activities/Space_News', source: 'ESA', category: 'space' },
  { url: 'https://phys.org/rss-feed/space-news/', source: 'Phys.org Space', category: 'space' },
  { url: 'https://www.space.com/feeds.xml', source: 'Space.com', category: 'space' },
  { url: 'https://spacenews.com/feed/', source: 'SpaceNews', category: 'space' },

  // Startup / tech front page (relevance-filtered below)
  { url: 'https://news.ycombinator.com/rss', source: 'Hacker News', category: 'startup' }
];

// Signal = "what's changing in AI & tech". Feeds tagged 'ai'/'tech' are already
// on-topic and pass as-is; everything else (science, startup, HN) must match a
// tech/innovation keyword so general/human-interest headlines are dropped.
const ON_TOPIC = new Set(['ai', 'tech', 'space']);
const TECH_RE = /\b(a\.?i\.?|artificial intelligence|machine learning|\bml\b|llm|gpt|openai|anthropic|claude|gemini|deepmind|mistral|meta|google|microsoft|apple|amazon|neural|model|robot|chip|semiconductor|gpu|nvidia|quantum|algorithm|automat|agent|software|hardware|\bapp\b|platform|startup|fund(ing|ed)|raise|series [a-e]|venture|\bipo\b|acqui|launch|releas|data|privacy|cyber|security|breach|encrypt|crypto|blockchain|space|rocket|satellite|spacex|biotech|genom|\bdna\b|energy|batter|fusion|solar|research|breakthrough|physics|\bmath|comput|cloud|\bapi\b|open source|patent|protein|fossil|telescope|climate)\b/i;

async function fetchFeed(feedConfig) {
  const { url, source, category } = feedConfig;

  try {
    const feed = await parser.parseURL(url);
    const items = [];

    for (const item of feed.items.slice(0, 20)) { // Max 20 per feed
      const title = item.title?.trim().substring(0, 500) || 'Untitled';
      // Brand safety first — sexual-violence / child-abuse headlines never
      // enter the store, whatever feed they arrive on.
      if (anyBlocked(title, item.contentSnippet)) continue;
      // Drop off-topic headlines from broad feeds (science/startup/HN): a Signal
      // must be about AI/tech/innovation, not general human-interest news.
      if (!ON_TOPIC.has(category) && !TECH_RE.test(title)) continue;
      // Extract only headline data - never full content
      items.push({
        title,
        source,
        link: item.link || item.guid,
        publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
        category,
        guid: item.guid || item.link
      });
    }

    return items;
  } catch (error) {
    console.error(`Failed to fetch ${source}:`, error.message);
    return [];
  }
}

async function aggregateNews() {
  console.log(`[RSS] Starting aggregation at ${new Date().toISOString()}`);

  let totalNew = 0;
  let totalSkipped = 0;

  for (const feedConfig of RSS_FEEDS) {
    const items = await fetchFeed(feedConfig);

    for (const item of items) {
      try {
        // Check if already exists (by guid or link)
        const exists = await NewsItem.findOne({
          $or: [
            { guid: item.guid },
            { link: item.link }
          ]
        });

        if (!exists) {
          await NewsItem.create(item);
          totalNew++;
        } else {
          totalSkipped++;
        }
      } catch (error) {
        // Duplicate key error is expected, ignore
        if (error.code !== 11000) {
          console.error(`[RSS] Error saving item:`, error.message);
        }
        totalSkipped++;
      }
    }

    console.log(`[RSS] ${feedConfig.source}: fetched ${items.length} items`);
  }

  console.log(`[RSS] Complete. New: ${totalNew}, Skipped: ${totalSkipped}`);

  return { newItems: totalNew, skipped: totalSkipped };
}

// Run manually
async function runOnce() {
  const mongoose = require('mongoose');
  require('dotenv').config();

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('[RSS] Connected to MongoDB');

  const result = await aggregateNews();

  await mongoose.disconnect();
  console.log('[RSS] Disconnected');

  return result;
}

module.exports = { aggregateNews, runOnce, RSS_FEEDS };

// Allow running directly: node jobs/rssAggregator.js
if (require.main === module) {
  runOnce()
    .then(result => {
      console.log('[RSS] Manual run complete:', result);
      process.exit(0);
    })
    .catch(error => {
      console.error('[RSS] Manual run failed:', error);
      process.exit(1);
    });
}
