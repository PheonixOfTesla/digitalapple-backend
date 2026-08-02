/**
 * Which employers' applicant tracking systems to read — and how to find more.
 *
 * This list is the single biggest lever on whether the whole thing works.
 * Measured: 23 company boards produced 256 fillable remote engineering roles,
 * about 81% of every remote engineering role found anywhere, with all nine
 * global job boards combined contributing the other 19%. The aggregators are
 * mostly reading these same ATSes and arriving later.
 *
 * The obvious shortcut does NOT work and was tested before this was written:
 * harvesting ATS slugs out of the aggregator feeds returned 1 usable slug from
 * 803 postings, because every board rewrites outbound URLs to its own domain.
 *
 * What does work is cheap guessing plus verification — a company's slug is
 * almost always its own name, and `discover()` below tests candidates against
 * all three vendors and keeps whatever answers. Measured hit rate on a plain
 * list of 100 well-known tech companies: 49 live boards, 5,340 postings.
 *
 * discoverFromBoards() then closes the loop: the aggregators print employer
 * NAMES even though they rewrite the links, so 455 names became 519 candidate
 * slugs and found 88 more live boards carrying ~6,500 postings. Coverage grows
 * by running that, not by anyone maintaining this list by hand.
 *
 * So: every slug below has been verified to return at least one live posting.
 * Nothing is in this file on the strength of a guess. Wrong guesses are free
 * anyway — an unknown slug returns an empty board and is reported by the
 * ingest run, never as a crash — but a list that quietly half-works makes the
 * corpus look thin for no visible reason.
 */
const { get } = require('./sources');

// Verified live. Company boards move between vendors (Plaid and Benchling are
// on Ashby, not Greenhouse, which is why guessing one vendor per company is
// worse than testing all three), so re-run `discover` rather than assuming.
const COMPANIES = {
  greenhouse: [
    'adyen', 'affirm', 'airbnb', 'airtable', 'alloy', 'amplitude', 'amwell',
    'anthropic', 'asana', 'attentive', 'aviatrix', 'bird', 'bybit', 'calm',
    'canonical', 'carta', 'catawiki', 'celonis', 'chime', 'clickhouse',
    'cloudbeds', 'cloudflare', 'clutch', 'coalition', 'cockroachlabs',
    'coinbase', 'collibra', 'connecteam', 'customerio', 'databricks',
    'discord', 'doximity', 'dropbox', 'ebanx', 'faire', 'figma', 'flex',
    'flexport', 'gitlab', 'hrtechx', 'instacart', 'jetbrains',
    'keepersecurity', 'launchdarkly', 'lyft', 'mavenclinic', 'mercury',
    'okta', 'okx', 'peloton', 'pokemoncareers', 'pomelocare', 'postman',
    'reddit', 'riskified', 'robinhood', 'roblox', 'samsara', 'scaleai',
    'smartsheet', 'sofi', 'sparksoftcorporation', 'speechify',
    'sphinxdefense', 'staffbase', 'stripe', 'tailscale', 'tekmetric',
    'testlio', 'tines', 'twilio', 'twitch', 'udemy', 'vercel', 'webflow',
    'wheely', 'zocdoc'
  ],
  lever: [
    'alloy', 'arcadia', 'binance', 'electric-twin', 'findigs', 'levelup',
    'ro', 'toptal', 'wealthfront', 'zoox'
  ],
  ashby: [
    '1password', 'a-team', 'airbyte', 'amo', 'amplitude', 'applied',
    'ashby', 'benchling', 'betterup', 'buffer', 'clera', 'clickhouse',
    'coder', 'colonist', 'confido', 'confluent', 'deliveroo', 'ditto',
    'elevenlabs', 'freshpaint', 'g2i', 'galvany', 'ignition', 'kong',
    'linear', 'livekit', 'lyric', 'miro', 'noda-ai', 'notion', 'nylas',
    'onechronos', 'openai', 'opsmill', 'ostrom', 'phoenix', 'plaid', 'pleo',
    'posthog', 'quora', 'radical-numerics', 'ramp', 'replit', 'rivet',
    'sentry', 'strava', 'superplane', 'tandem-health', 'telus-digital',
    'temporal', 'testgorilla', 'thumbtack', 'tremendous', 'typesafe-ai',
    'vanta', 'whoop', 'zapier', 'zauber'
  ],
  workable: [],
  smartrecruiters: ['Visa']
};

/** Flat [{vendor, slug}] for the ingest loop. */
function atsTargets() {
  const out = [];
  for (const [vendor, slugs] of Object.entries(COMPANIES)) {
    for (const slug of slugs) out.push({ vendor, slug });
  }
  return out;
}

// One probe per vendor. Each answers "does this slug have a live board", and
// nothing else — the real fetch happens in sources.js.
const PROBES = {
  greenhouse: s => [`https://boards-api.greenhouse.io/v1/boards/${s}/jobs`,
    b => (b && b.jobs || []).length],
  lever: s => [`https://api.lever.co/v0/postings/${s}?mode=json`,
    b => (Array.isArray(b) ? b.length : 0)],
  ashby: s => [`https://api.ashbyhq.com/posting-api/job-board/${s}`,
    b => (b && b.jobs || []).length],
  workable: s => [`https://apply.workable.com/api/v1/widget/accounts/${s}`,
    b => (b && b.jobs || []).length],
  smartrecruiters: s => [`https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=1`,
    b => (b && b.totalFound) || 0]
};

/**
 * Test candidate slugs against every vendor and report which are real.
 *
 * A company appears on exactly one vendor but you rarely know which, so each
 * candidate is tried against all of them. Concurrency is capped because five
 * requests per candidate across a few hundred candidates is enough to look
 * like something worth rate-limiting.
 */
async function discover(candidates, { vendors = ['greenhouse', 'lever', 'ashby'], concurrency = 20 } = {}) {
  const found = {}, tried = new Set();
  for (const v of vendors) found[v] = [];

  const queue = candidates.map(c => String(c).trim().toLowerCase()).filter(c => {
    if (!c || tried.has(c)) return false;
    tried.add(c); return true;
  });

  for (let i = 0; i < queue.length; i += concurrency) {
    const batch = queue.slice(i, i + concurrency);
    await Promise.all(batch.flatMap(slug => vendors.map(async v => {
      const probe = PROBES[v];
      if (!probe) return;
      const [url, count] = probe(encodeURIComponent(slug));
      const r = await get(url);
      if (!r.ok) return;
      const n = count(r.body);
      if (n > 0) found[v].push({ slug, jobs: n });
    })));
  }
  for (const v of vendors) found[v].sort((a, b) => b.jobs - a.jobs);
  return found;
}

/**
 * Grow the list without being handed one.
 *
 * The aggregators rewrite outbound URLs, so their links are useless — but they
 * still PRINT the employer's name, and an ATS slug is almost always that name
 * lowercased with the punctuation gone. Reading names instead of links is the
 * difference between 1 slug from 803 postings and this: 519 candidates
 * generated from 455 company names found 88 new live boards carrying roughly
 * 6,500 postings, in a single pass.
 *
 * It compounds. Every new board lists more companies, which become the next
 * round's candidates — so coverage grows by running this, not by someone
 * maintaining a list by hand.
 */
function slugCandidates(companyNames) {
  const out = new Set();
  for (const raw of companyNames) {
    const base = String(raw || '').toLowerCase()
      // Legal and filler words are in the printed name and never in the slug.
      .replace(/\b(inc|llc|ltd|gmbh|corp|co|the|limited|group|holdings|technologies|technology|labs|software|solutions)\b/g, '')
      .replace(/[^a-z0-9 ]/g, ' ')
      .trim();
    if (!base || base.length < 3) continue;
    out.add(base.replace(/\s+/g, ''));    // "Acme Labs" → "acme"
    out.add(base.replace(/\s+/g, '-'));   // some slugs keep the hyphen
  }
  return [...out].filter(c => c.length >= 3 && c.length <= 30);
}

/**
 * One pass: read every global board, turn the employer names into candidate
 * slugs, and report the live boards we did not already have.
 *
 * Returns what is NEW rather than everything, because the useful output is a
 * diff somebody can paste into COMPANIES — or that a scheduled job can log so
 * the list's growth is visible instead of silent.
 */
async function discoverFromBoards({ concurrency = 24 } = {}) {
  const { SOURCES } = require('./sources');
  const names = new Set();
  for (const s of SOURCES.filter(x => !x.perCompany)) {
    try {
      const r = await s.fetchAll();
      for (const j of r.items) if (j.company) names.add(j.company);
    } catch (e) { /* one dead board must not stop discovery */ }
  }
  const found = await discover(slugCandidates(names), { concurrency });
  const have = known(), fresh = {};
  let boards = 0, postings = 0;
  for (const [vendor, arr] of Object.entries(found)) {
    fresh[vendor] = arr.filter(x => !have.has(vendor + ':' + x.slug));
    boards += fresh[vendor].length;
    postings += fresh[vendor].reduce((n, x) => n + x.jobs, 0);
  }
  return { namesSeen: names.size, fresh, newBoards: boards, newPostings: postings };
}

/** Slugs already known, so a discovery run can report only what is new. */
function known() {
  const s = new Set();
  for (const [vendor, slugs] of Object.entries(COMPANIES)) {
    for (const slug of slugs) s.add(vendor + ':' + slug.toLowerCase());
  }
  return s;
}

module.exports = { COMPANIES, atsTargets, discover, discoverFromBoards, slugCandidates, known, PROBES };
