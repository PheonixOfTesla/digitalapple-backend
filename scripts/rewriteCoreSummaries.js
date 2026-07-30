/**
 * Rewrite every Clockwork map's CORE summary into a true end-to-end read.
 *
 * The old summaries came in two flavours, both of which only ever described
 * the FIRST row of the tree:
 *
 *   • "Requirements: … Steps: … Documents: … Cost & Time: … No steps resolved
 *      yet (50% grounded)."   ← the depth-1 statements pasted together, capped
 *      at four so a five-domain map described four of them, and carrying frozen
 *      arithmetic that contradicted the live meter on the same screen.
 *   • "Here's the honest shape of …"  ← better prose, still only depth 1, and
 *      it never mentioned that the map bottoms out in dozens of actions.
 *
 * services/mapSummary.summarizeMap() walks the whole tree instead. This script
 * regenerates the summary from each map's stored snapshot and writes it to BOTH
 * places it is read from:
 *   • SharedMap.snapshot.core.detail — what map.html actually renders
 *   • the core Node document         — what Blueprint reads when you fork/edit
 *
 * Idempotent: re-running produces the same text. Safe to run repeatedly.
 *
 * Usage:
 *   node scripts/rewriteCoreSummaries.js            # all Clockwork maps
 *   node scripts/rewriteCoreSummaries.js --dry      # print samples, write nothing
 *   node scripts/rewriteCoreSummaries.js --limit=25
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { summarizeMap } = require('../services/mapSummary');

const DRY = process.argv.includes('--dry');
const LIMIT = (() => {
  const a = process.argv.find(x => x.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1], 10) : 0;
})();

async function run() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI not set');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('[cores] connected' + (DRY ? ' — DRY RUN, nothing will be written' : ''));

  const SharedMap = require('../models/SharedMap');
  const Node = require('../models/Node');
  const { getClockworkUser } = require('../jobs/seedMaps');

  // Clockwork-owned only. These summaries are generated; a member's map may
  // have a core they wrote themselves and this must never overwrite it.
  const clockwork = await getClockworkUser();
  const q = { ownerId: clockwork._id, unpublishedAt: null };

  const total = await SharedMap.countDocuments(q);
  console.log(`[cores] ${total} Clockwork maps to consider`);

  let scanned = 0, changed = 0, skipped = 0, shown = 0;
  const cursor = SharedMap.find(q).select('_id title snapshot projectId').lean().cursor();

  for (let m = await cursor.next(); m; m = await cursor.next()) {
    if (LIMIT && scanned >= LIMIT) break;
    scanned++;
    const snap = m.snapshot || {};
    const nodes = snap.nodes || [];
    const core = snap.core;
    if (!core || !nodes.length) { skipped++; continue; }

    const detail = summarizeMap(nodes, core.statement || m.title, core.determination || 'actionable');
    if (!detail || detail === core.detail) { skipped++; continue; }

    if (shown < 3) {
      shown++;
      console.log(`\n─ ${m.title}`);
      console.log(`  OLD: ${String(core.detail || '(empty)').slice(0, 160)}…`);
      console.log(`  NEW: ${detail.slice(0, 160)}…`);
    }

    if (!DRY) {
      await SharedMap.updateOne({ _id: m._id }, { $set: { 'snapshot.core.detail': detail } });
      // Keep the live Node in step, so forking into Blueprint shows the same
      // summary the Atlas card showed.
      if (m.projectId && core._id) {
        await Node.updateOne({ _id: core._id, projectId: m.projectId }, { $set: { detail } });
      }
    }
    changed++;
    if (changed % 250 === 0) console.log(`[cores] ${changed} rewritten…`);
  }

  console.log(`\n[cores] scanned ${scanned} · rewritten ${changed} · unchanged ${skipped}`);
  await mongoose.disconnect();
}

run().catch(e => { console.error('[cores] fatal:', e.message); process.exit(1); });
