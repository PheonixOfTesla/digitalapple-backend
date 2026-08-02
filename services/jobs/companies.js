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
    'affirm', 'airbnb', 'airtable', 'amplitude', 'anthropic', 'asana', 'attentive',
    'bird', 'calm', 'carta', 'chime', 'cloudflare', 'cockroachlabs', 'coinbase',
    'databricks', 'discord', 'doximity', 'faire', 'figma', 'gitlab', 'instacart',
    'lyft', 'okta', 'peloton', 'postman', 'reddit', 'robinhood', 'roblox',
    'samsara', 'scaleai', 'sofi', 'stripe', 'twilio', 'udemy', 'webflow',
    'alloy', 'zocdoc'
  ],
  lever: [
    'zoox', 'wealthfront', 'arcadia', 'alloy', 'ro'
  ],
  ashby: [
    '1password', 'airbyte', 'amplitude', 'benchling', 'betterup', 'confluent',
    'deliveroo', 'linear', 'miro', 'notion', 'nylas', 'openai', 'plaid',
    'posthog', 'quora', 'ramp', 'replit', 'sentry', 'strava', 'thumbtack',
    'vanta', 'whoop', 'zapier'
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

/** Slugs already known, so a discovery run can report only what is new. */
function known() {
  const s = new Set();
  for (const [vendor, slugs] of Object.entries(COMPANIES)) {
    for (const slug of slugs) s.add(vendor + ':' + slug.toLowerCase());
  }
  return s;
}

module.exports = { COMPANIES, atsTargets, discover, known, PROBES };
