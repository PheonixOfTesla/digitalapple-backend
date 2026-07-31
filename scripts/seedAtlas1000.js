/**
 * Seed 1000 five-layer Atlas maps — balanced across all five topics, no dupes.
 *
 * WHAT EACH MAP IS
 * generateDeepGraph builds five layers: CORE → domain → aspect → sub-aspect →
 * ACTION terminal. 76 nodes, 40 of them concrete actions. The core carries an
 * end-to-end summary written by services/mapSummary, which walks the whole tree
 * rather than restating the first row. No LLM is involved, so this costs
 * nothing and runs at DB speed.
 *
 * WHY NOT backfillTo()
 * backfillTo fills to a TOTAL and picks from the pool at random, so on a pool
 * that is 32% business and 7% creative it returns roughly that mix. Asking for
 * 1000 "across five topics" that way would produce ~360 business and ~74
 * creative. This fills an explicit quota per category instead.
 *
 * DEDUPLICATION, three layers deep:
 *   1. the pool itself is built through a Set — no duplicate premises exist
 *   2. every existing SharedMap and Project premise is hashed and excluded, so
 *      re-running never produces a second copy of a map you already have
 *   3. a per-run Set, because two workers must never claim the same premise
 *
 * Usage:
 *   MONGODB_URI=… node scripts/seedAtlas1000.js
 *   MONGODB_URI=… node scripts/seedAtlas1000.js --total=1000 --per=200
 *   MONGODB_URI=… node scripts/seedAtlas1000.js --dry     # plan only, no writes
 *
 * Resumable: it skips whatever already exists, so an interrupted run can simply
 * be started again.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const arg = (n, d) => {
  const a = process.argv.find(x => x.startsWith(`--${n}=`));
  return a ? a.split('=')[1] : d;
};
const DRY = process.argv.includes('--dry');
const TOTAL = parseInt(arg('total', '1000'), 10);
const CATEGORIES = ['business', 'career', 'product', 'creative', 'other'];
const PER = parseInt(arg('per', String(Math.floor(TOTAL / CATEGORIES.length))), 10);
const CONCURRENCY = Math.max(1, Math.min(8, parseInt(arg('concurrency', '6'), 10)));
const MAP_TIMEOUT_MS = 180000;

(async () => {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set. Copy it from Railway → your service → Variables.');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);

  const SharedMap = require('../models/SharedMap');
  const Project = require('../models/Project');
  const { FLAT_POOL, hashPremise, createSeedMap, getClockworkUser } = require('../jobs/seedMaps');

  // Layer 2 of dedup: everything that already exists, by premise hash.
  const seen = new Set();
  for (const m of await SharedMap.find({}).select('description title').lean()) {
    seen.add(hashPremise(m.description || m.title || ''));
  }
  for (const p of await Project.find({}).select('premise name').lean()) {
    seen.add(hashPremise(p.premise || p.name || ''));
  }
  const before = await SharedMap.countDocuments({ unpublishedAt: null });
  console.log(`\nAtlas holds ${before} published map(s); ${seen.size} premise(s) already taken.`);

  // Pick the quota per category from what is still unused. Shuffled so repeat
  // runs don't march down the pool in the same order.
  const plan = [];
  const shortfalls = [];
  for (const cat of CATEGORIES) {
    const free = FLAT_POOL.filter(t => t.category === cat && !seen.has(hashPremise(t.premise)));
    for (let i = free.length - 1; i > 0; i--) {                 // Fisher-Yates
      const j = Math.floor(Math.random() * (i + 1));
      [free[i], free[j]] = [free[j], free[i]];
    }
    const take = free.slice(0, PER);
    take.forEach(t => { seen.add(hashPremise(t.premise)); plan.push(t); });  // layer 3
    console.log(`  ${cat.padEnd(9)} ${String(take.length).padStart(4)} of ${PER} requested   (${free.length} unused in pool)`);
    if (take.length < PER) shortfalls.push(`${cat}: ${PER - take.length} short`);
  }

  if (shortfalls.length) {
    console.log(`\n  NOTE: ${shortfalls.join(', ')}. The pool has no more unused premises there.`);
    console.log('  Add subjects or angles in jobs/seedMaps.js rather than letting it repeat itself.');
  }
  console.log(`\nPlanned: ${plan.length} new map(s), five layers each, ~76 nodes per map.`);

  if (DRY) {
    console.log('\nDRY RUN — nothing written. Sample of what would be created:\n');
    for (const cat of CATEGORIES) {
      const s = plan.filter(p => p.category === cat).slice(0, 3);
      s.forEach(p => console.log(`  [${cat}] ${p.premise}`));
    }
    await mongoose.disconnect();
    return;
  }

  const user = await getClockworkUser();
  let created = 0, failed = 0, idx = 0, lastError = null;
  const started = Date.now();

  async function worker() {
    while (idx < plan.length) {
      const topic = plan[idx++];
      try {
        // Hard ceiling per map: one stalled DB write must not freeze a worker
        // and, through Promise.all, the entire run.
        await Promise.race([
          createSeedMap(user, topic, { fast: true }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('map timeout (>180s)')), MAP_TIMEOUT_MS))
        ]);
        created++;
      } catch (e) {
        failed++; lastError = e.message;
        console.error(`  fail: ${topic.premise.slice(0, 60)} — ${e.message}`);
      }
      if ((created + failed) % 50 === 0) {
        const rate = (created + failed) / ((Date.now() - started) / 1000);
        const left = Math.round((plan.length - created - failed) / Math.max(rate, 0.01));
        console.log(`  ${created + failed}/${plan.length}  (${created} ok, ${failed} failed)  ~${Math.floor(left / 60)}m ${left % 60}s left`);
      }
    }
  }

  console.log(`Seeding with ${CONCURRENCY} workers…\n`);
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const after = await SharedMap.countDocuments({ unpublishedAt: null });
  console.log(`\nDone in ${Math.round((Date.now() - started) / 1000)}s — created ${created}, failed ${failed}.`);
  console.log(`Atlas: ${before} → ${after} published maps.`);
  if (lastError) console.log(`Last error: ${lastError}`);
  await mongoose.disconnect();
})().catch(e => { console.error('seed failed:', e.message); process.exit(1); });
