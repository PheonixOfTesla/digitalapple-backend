/**
 * Rewrite existing maps' CORE summaries into the expert, node-suggesting voice.
 *
 * The old seed core read like a manual ("Five layers: the domains..."). This
 * walks every core node, reads the domains its map actually carries, and
 * regenerates the summary with coreDetail() — an advisor's take that points at
 * the two nodes worth opening. Idempotent; safe to re-run.
 *
 * Usage: node scripts/rewriteCoreSummaries.js   (needs MONGODB_URI)
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { coreDetail } = require('../jobs/seedMaps');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');
  const Node = require('../models/Node');

  // Old boilerplate marker — only rewrite cores that still carry it.
  const cores = await Node.find({
    depth: 0,
    detail: { $regex: 'mapped to the floor|Five layers' }
  }).select('_id statement projectId').lean();
  console.log(`Found ${cores.length} core nodes to rewrite`);

  let done = 0;
  for (const core of cores) {
    const domains = await Node.find({ parentNodeId: core._id, depth: 1 })
      .select('constellation').sort({ _id: 1 }).lean();
    const cons = domains.map(d => d.constellation).filter(Boolean);
    if (!cons.length) continue;
    const detail = coreDetail(core.statement || 'this map', cons);
    await Node.updateOne({ _id: core._id }, { $set: { detail } });
    done++;
    if (done % 250 === 0) console.log(`  ${done}/${cores.length}`);
  }
  console.log(`Rewrote ${done} core summaries`);
  await mongoose.disconnect();
}

run().catch(e => { console.error(e); process.exit(1); });
