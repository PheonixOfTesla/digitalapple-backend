/**
 * enrichRatings — attach REAL review data to directory companies.
 *
 * Sources (each behind its own key, set as Railway masked env vars):
 *   • Google Places  — GOOGLE_PLACES_API_KEY  (rating + user_ratings_total)
 *   • Yelp Fusion    — YELP_API_KEY           (rating + review_count)
 *
 * Honest by design: no keys → loud error, never invented numbers. A company
 * only gets a source's line when that source actually returned a rated match,
 * and a loose name-overlap guard drops wild mismatches. recomputeScores()
 * (pre-save) folds new sources into aggregateScore / sortScore automatically.
 */
const Company = require('../models/Company');

const G_KEY = () => process.env.GOOGLE_PLACES_API_KEY || '';
const Y_KEY = () => process.env.YELP_API_KEY || '';

function nameOverlap(a, b) {
  a = String(a || '').toLowerCase().trim(); b = String(b || '').toLowerCase().trim();
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a) || a.split(/\s+/)[0] === b.split(/\s+/)[0];
}

async function googleFor(c) {
  const q = encodeURIComponent(c.name + (c.location && c.location.city ? ' ' + c.location.city : ''));
  const r = await fetch(`https://maps.googleapis.com/maps/api/place/textsearch/json?query=${q}&key=${G_KEY()}`);
  if (!r.ok) return null;
  const d = await r.json();
  const hit = d.results && d.results[0];
  if (!hit || hit.rating == null || !hit.user_ratings_total) return null;
  if (!nameOverlap(c.name, hit.name)) return null;
  return { score: hit.rating, count: hit.user_ratings_total, url: 'https://www.google.com/maps/place/?q=place_id:' + hit.place_id };
}

async function yelpFor(c) {
  const p = new URLSearchParams({
    term: c.name, limit: '1',
    location: (c.location && (c.location.city || c.location.region)) || 'United States'
  });
  const r = await fetch('https://api.yelp.com/v3/businesses/search?' + p, { headers: { Authorization: 'Bearer ' + Y_KEY() } });
  if (!r.ok) return null;
  const d = await r.json();
  const hit = d.businesses && d.businesses[0];
  if (!hit || hit.rating == null || !hit.review_count) return null;
  if (!nameOverlap(c.name, hit.name)) return null;
  return { score: hit.rating, count: hit.review_count, url: hit.url };
}

/**
 * @param {object} opts { limit?: number } companies to scan this run
 */
async function enrichRatings({ limit = 60 } = {}) {
  if (!G_KEY() && !Y_KEY()) {
    throw new Error('No review sources configured — set GOOGLE_PLACES_API_KEY and/or YELP_API_KEY in Railway env vars.');
  }
  const companies = await Company.find({
    status: 'approved',
    $or: [
      { 'ratings.google.count': { $in: [null, 0] } },
      { 'ratings.yelp.count': { $in: [null, 0] } }
    ]
  }).sort({ updatedAt: 1 }).limit(Math.min(200, Math.max(1, limit)));

  let enriched = 0, unmatched = 0, errors = 0;
  for (const c of companies) {
    try {
      let got = false;
      if (G_KEY() && !(c.ratings && c.ratings.google && c.ratings.google.count)) {
        const g = await googleFor(c);
        if (g) { c.set('ratings.google', g); got = true; }
      }
      if (Y_KEY() && !(c.ratings && c.ratings.yelp && c.ratings.yelp.count)) {
        const y = await yelpFor(c);
        if (y) { c.set('ratings.yelp', y); got = true; }
      }
      if (got) { await c.save(); enriched++; } else { c.updatedAt = new Date(); await c.save(); unmatched++; }
      await new Promise(r => setTimeout(r, 150)); // stay well under source rate limits
    } catch (e) { errors++; }
  }
  return { scanned: companies.length, enriched, unmatched, errors };
}

module.exports = { enrichRatings };
