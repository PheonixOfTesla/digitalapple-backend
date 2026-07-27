/**
 * aggregateCompanies — populate the Directory with real companies across every
 * industry, sourced from Wikidata (free, keyless, public knowledge base).
 *
 * Honest by design:
 *   • Only real, named entities that have an official website are imported.
 *   • They land as `status: 'approved'` so they show in the directory, but
 *     `legal.verified` stays FALSE (we didn't confirm registration) and NO reviews
 *     are invented — rankScore is just the Bayesian prior until real reviews arrive.
 *   • Idempotent: upsert by wikidataId, so re-runs refresh rather than duplicate.
 *
 * Per-industry caps keep the mix balanced (retail alone has 4,000+ on Wikidata).
 */
const Company = require('../models/Company');

const SPARQL = 'https://query.wikidata.org/sparql';
const UA = 'ClockworkHub/1.0 (https://theclockworkhub.com; directory aggregation)';

// Industry (P452) QID → our clean category slug. Only QIDs verified to return
// companies-with-websites are listed; add more freely (a dud QID just yields none).
const INDUSTRIES = [
  { qid: 'Q126793', category: 'retail' },
  { qid: 'Q11661',  category: 'technology' },
  { qid: 'Q507443', category: 'fashion' },
  { qid: 'Q385378', category: 'construction' },
  { qid: 'Q43183',  category: 'insurance' },
  { qid: 'Q11451',  category: 'agriculture' },
  { qid: 'Q39809',  category: 'marketing' },
  { qid: 'Q43015',  category: 'finance' },
  { qid: 'Q11633',  category: 'photography' },
  { qid: 'Q170201', category: 'pharmaceutical' },
  { qid: 'Q1326624', category: 'energy' },
  { qid: 'Q11633',  category: 'media' },
  { qid: 'Q83405',  category: 'manufacturing' },
  { qid: 'Q37383',  category: 'advertising' },
  { qid: 'Q641226', category: 'hospitality' }
];

function clean(s, max) { return String(s == null ? '' : s).trim().slice(0, max); }

async function fetchIndustry(qid, limit) {
  const query = `SELECT ?item ?itemLabel ?website ?countryLabel ?desc WHERE {
    ?item wdt:P452 wd:${qid} ; wdt:P856 ?website .
    MINUS { ?item wdt:P576 ?dissolved . }
    OPTIONAL { ?item wdt:P17 ?country. }
    OPTIONAL { ?item schema:description ?desc FILTER(LANG(?desc)="en") }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
  } LIMIT ${limit}`;
  const url = SPARQL + '?format=json&query=' + encodeURIComponent(query);
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(url, { headers: { 'Accept': 'application/sparql-results+json', 'User-Agent': UA }, signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    return (d.results && d.results.bindings) || [];
  } finally { clearTimeout(to); }
}

/**
 * @param {object} opts { perIndustry?: number }
 * @returns {Promise<{imported:number, updated:number, industries:number, total:number}>}
 */
async function aggregateCompanies(opts = {}) {
  const perIndustry = Math.min(120, Math.max(10, opts.perIndustry || 45));
  let imported = 0, updated = 0, industriesHit = 0;

  for (const ind of INDUSTRIES) {
    let rows = [];
    try { rows = await fetchIndustry(ind.qid, perIndustry); }
    catch (e) { console.error(`[Companies] ${ind.category} (${ind.qid}) fetch failed:`, e.message); continue; }
    if (!rows.length) continue;
    industriesHit++;

    // Dedupe by QID within the batch (multiple websites → one row).
    const seen = new Set();
    for (const row of rows) {
      const uri = row.item && row.item.value;               // http://www.wikidata.org/entity/Q95
      const qid = uri ? uri.split('/').pop() : null;
      const name = clean(row.itemLabel && row.itemLabel.value, 120);
      const website = clean(row.website && row.website.value, 300);
      if (!qid || !name || !website || seen.has(qid)) continue;
      if (/^Q\d+$/.test(name)) continue;                    // unlabeled item — skip
      seen.add(qid);

      const country = clean(row.countryLabel && row.countryLabel.value, 60);
      const desc = clean(row.desc && row.desc.value, 2000);
      try {
        const existing = await Company.findOne({ wikidataId: qid });
        if (existing) {
          existing.website = website || existing.website;
          if (desc && !existing.description) existing.description = desc;
          if (!existing.category || existing.category === 'other') existing.category = ind.category;
          existing.recomputeScores();
          await existing.save();
          updated++;
        } else {
          const c = new Company({
            name, website, description: desc, category: ind.category,
            source: 'wikidata', wikidataId: qid, status: 'approved', approvedAt: new Date(),
            location: country ? { country } : undefined
          });
          c.recomputeScores(); // no reviews yet → rankScore = prior
          await c.save();
          imported++;
        }
      } catch (e) {
        if (e.code === 11000) continue; // raced duplicate — fine
        console.error('[Companies] save failed for', name, e.message);
      }
    }
    // Be polite to the public endpoint.
    await new Promise(res => setTimeout(res, 400));
  }

  const total = await Company.countDocuments({ status: 'approved' });
  console.log(`[Companies] aggregation done — imported ${imported}, updated ${updated}, ${industriesHit} industries, ${total} approved total`);
  return { imported, updated, industries: industriesHit, total };
}

module.exports = { aggregateCompanies, INDUSTRIES };
