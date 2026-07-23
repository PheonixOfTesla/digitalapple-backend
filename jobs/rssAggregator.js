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

  // Science — high-signal, mind-blowing, plain-language
  { url: 'https://www.quantamagazine.org/feed/', source: 'Quanta', category: 'science' },
  { url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', source: 'BBC Science', category: 'science' },

  // Markets / business / stocks (BBC works; CNBC 403s and Politico 404s from
  // servers, so they're dropped — the Wikipedia signal generator covers markets)
  { url: 'https://feeds.bbci.co.uk/news/business/rss.xml', source: 'BBC Business', category: 'business' },

  // World & geopolitics
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', source: 'BBC World', category: 'world' },

  // Culture & notable people (arts, entertainment, public figures — royals, etc.)
  { url: 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml', source: 'BBC Culture', category: 'culture' },

  // Startup / cross-genre high-signal (front page — tech, science, culture)
  { url: 'https://news.ycombinator.com/rss', source: 'Hacker News', category: 'startup' }
];

async function fetchFeed(feedConfig) {
  const { url, source, category } = feedConfig;

  try {
    const feed = await parser.parseURL(url);
    const items = [];

    for (const item of feed.items.slice(0, 20)) { // Max 20 per feed
      // Extract only headline data - never full content
      const newsItem = {
        title: item.title?.trim().substring(0, 500) || 'Untitled',
        source,
        link: item.link || item.guid,
        publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
        category,
        guid: item.guid || item.link
      };

      items.push(newsItem);
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
