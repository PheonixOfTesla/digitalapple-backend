/**
 * Backfill the Atlas to ~1000 maps.
 *
 * One-time (resumable) batch that generates cross-genre maps with the real
 * Blueprint engine and publishes them to Atlas under the Clockwork system
 * account (same path the daily seed job uses, so structure is identical).
 *
 * Requires env: MONGODB_URI (+ the LLM keys the engine already uses:
 *   MOONSHOT_API_KEY / OPENAI_API_KEY per your AI_PROVIDER).
 * Optional env:
 *   BACKFILL_TARGET   how many total public maps to reach (default 3000)
 *   BACKFILL_CONC     concurrent generations (default 3 — Moonshot's max)
 *
 * Run:  node scripts/backfillAtlas.js
 * Resumable: dedupes against existing maps, so re-running continues where it
 * left off. Expect ~1–2 hours for 1000 (LLM-bound); safe to run detached.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const TARGET = parseInt(process.env.BACKFILL_TARGET || '3000', 10);
const CONC = Math.max(1, Math.min(3, parseInt(process.env.BACKFILL_CONC || '3', 10)));

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI not set');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`[backfill] connected. target=${TARGET} concurrency=${CONC}`);

  const SharedMap = require('../models/SharedMap');
  const Project = require('../models/Project');
  const { getClockworkUser, createSeedMap, hashPremise, FLAT_POOL } = require('../jobs/seedMaps');

  const user = await getClockworkUser();

  // Current public map count
  const currentTotal = await SharedMap.countDocuments({ unpublishedAt: null });
  console.log(`[backfill] Atlas currently has ${currentTotal} published maps`);
  const need = Math.max(0, TARGET - currentTotal);
  if (need === 0) { console.log('[backfill] target already met.'); await mongoose.disconnect(); return; }

  // Preload existing premise hashes for O(1) dedup
  const seen = new Set();
  for (const m of await SharedMap.find({}).select('description title').lean()) {
    seen.add(hashPremise(m.description || m.title || ''));
  }
  for (const p of await Project.find({}).select('premise name').lean()) {
    seen.add(hashPremise(p.premise || p.name || ''));
  }

  // Candidate premises not already used
  const candidates = FLAT_POOL.filter(t => !seen.has(hashPremise(t.premise)))
    .sort(() => Math.random() - 0.5);
  console.log(`[backfill] ${candidates.length} unused premises available; need ${need}`);
  if (candidates.length < need) {
    console.warn(`[backfill] pool smaller than target — will create ${candidates.length} (widen the pool in jobs/seedMaps.js for more).`);
  }

  const work = candidates.slice(0, need);
  let created = 0, failed = 0, idx = 0;
  const t0 = Date.now();

  async function worker(wid) {
    while (true) {
      const i = idx++;
      if (i >= work.length) return;
      const topic = work[i];
      try {
        await createSeedMap(user, topic);
        created++;
        if (created % 10 === 0 || created === 1) {
          const rate = created / ((Date.now() - t0) / 60000);
          const eta = rate > 0 ? Math.round((work.length - created) / rate) : '?';
          console.log(`[backfill] ${created}/${work.length} created (${rate.toFixed(1)}/min, ~${eta} min left)`);
        }
      } catch (err) {
        failed++;
        console.error(`[backfill] fail "${topic.premise.slice(0, 50)}": ${err.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONC }, (_, w) => worker(w)));

  const finalTotal = await SharedMap.countDocuments({ unpublishedAt: null });
  console.log(`\n[backfill] done. created=${created} failed=${failed} | Atlas now has ${finalTotal} maps`);
  await mongoose.disconnect();
  process.exit(0);
}

main().catch(err => { console.error('[backfill] fatal:', err.message); process.exit(1); });
