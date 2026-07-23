/**
 * Seed Atlas with example maps.
 *
 * Generates real nebula maps (same pipeline users hit) and publishes them to
 * Atlas under the admin account, so the public feed has content that renders
 * in the current map.html / blueprint.html design.
 *
 * Requires env: MONGODB_URI, JWT_SECRET  (present on Railway).
 * Optional env:
 *   SEED_BASE   API base, default https://digitalapple-backend-production.up.railway.app/api/v1
 *               (on Railway you can set SEED_BASE=http://localhost:$PORT/api/v1)
 *   ADMIN_EMAIL default digitalappleco@gmail.com
 *   SEED_FORCE  set to "1" to publish even if a map with the same title exists
 *
 * Run:  node scripts/seedAtlas.js
 * Node 18+ (uses global fetch). Idempotent unless SEED_FORCE=1.
 */

const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const BASE = process.env.SEED_BASE || 'https://digitalapple-backend-production.up.railway.app/api/v1';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'digitalappleco@gmail.com';
const FORCE = process.env.SEED_FORCE === '1';

// Example premises → Atlas. Categories use the SharedMap enum
// (business | career | product | creative | other).
const SEEDS = [
  { premise: 'How I got my doctorate while a part-time student', category: 'career' },
  { premise: 'How I funded my ecom store',                        category: 'business' },
  { premise: 'How did Drake start getting famous',                category: 'other' },
  { premise: 'What grants I got in Florida as a college student', category: 'career' }
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI not set');
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET not set');

  await mongoose.connect(process.env.MONGODB_URI);
  const User = require('../models/User');
  const SharedMap = require('../models/SharedMap');

  const admin = await User.findOne({ email: ADMIN_EMAIL });
  if (!admin) throw new Error(`Admin user ${ADMIN_EMAIL} not found — run seedAdmin.js first`);
  if (admin.role !== 'admin') console.warn(`[seedAtlas] ${ADMIN_EMAIL} is not admin (role=${admin.role}); quota may apply`);

  // Mint a token matching middleware/auth.js ({ id, email, role })
  const token = jwt.sign({ id: admin._id.toString(), email: admin.email, role: admin.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const H = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };

  console.log(`[seedAtlas] base=${BASE} owner=${ADMIN_EMAIL} force=${FORCE}`);
  const results = [];

  for (const { premise, category } of SEEDS) {
    try {
      if (!FORCE) {
        const existing = await SharedMap.findOne({ title: premise, unpublishedAt: null });
        if (existing) { console.log(`↷ skip (exists): ${premise} → ${existing._id}`); results.push({ premise, mapId: existing._id.toString(), skipped: true }); continue; }
      }

      process.stdout.write(`• generating: ${premise} … `);
      const genRes = await fetch(`${BASE}/blueprint/nebula`, { method: 'POST', headers: H, body: JSON.stringify({ premise }) });
      const gen = await genRes.json();
      if (!genRes.ok || !gen.success) throw new Error(`nebula ${genRes.status}: ${gen.error || gen.message || 'failed'}`);
      const projectId = gen.project && (gen.project.id || gen.project._id);
      if (!projectId) throw new Error('no projectId returned');
      process.stdout.write('published: ');

      const pubRes = await fetch(`${BASE}/share/publish/${projectId}`, {
        method: 'POST', headers: H,
        body: JSON.stringify({ title: premise, description: premise, category, visibility: 'public' })
      });
      const pub = await pubRes.json();
      if (!pubRes.ok || !pub.success) throw new Error(`publish ${pubRes.status}: ${pub.error || pub.message || 'failed'}`);
      const mapId = pub.map && pub.map._id;
      console.log(mapId);
      results.push({ premise, projectId, mapId });
      await sleep(1500); // gentle pacing between LLM generations
    } catch (err) {
      console.log(`\n  ✗ ${premise}: ${err.message}`);
      results.push({ premise, error: err.message });
    }
  }

  console.log('\n=== Atlas seed complete ===');
  for (const r of results) {
    if (r.mapId) console.log(`  ✓ ${r.premise}\n      https://theclockworkhub.com/map.html?id=${r.mapId}`);
    else console.log(`  ✗ ${r.premise} — ${r.error}`);
  }

  await mongoose.disconnect();
  const failed = results.filter(r => r.error).length;
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error('[seedAtlas] fatal:', err.message); process.exit(1); });
