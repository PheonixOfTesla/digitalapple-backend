#!/usr/bin/env node
/**
 * reseed-showcase.js - Delete old seed maps and regenerate with real scores
 *
 * Run: node scripts/reseed-showcase.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const SharedMap = require('../models/SharedMap');
const Project = require('../models/Project');
const Node = require('../models/Node');
const Edge = require('../models/Edge');
const Core = require('../models/Core');
const { generateSeedMaps } = require('../jobs/seedMaps');

async function main() {
  console.log('[RESEED] Starting showcase map refresh...');

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('[RESEED] Connected to database');

  // Find all seed maps
  const seedMaps = await SharedMap.find({ isSeed: true });
  console.log(`[RESEED] Found ${seedMaps.length} existing seed maps`);

  // Delete associated data for each
  for (const map of seedMaps) {
    const projectId = map.projectId;
    if (projectId) {
      await Node.deleteMany({ projectId });
      await Edge.deleteMany({ projectId });
      await Core.deleteMany({ projectId });
      await Project.deleteOne({ _id: projectId });
      console.log(`[RESEED] Deleted project data for: ${map.title.substring(0, 40)}...`);
    }
    await SharedMap.deleteOne({ _id: map._id });
    console.log(`[RESEED] Deleted map: ${map.title.substring(0, 40)}...`);
  }

  console.log('[RESEED] Generating fresh showcase maps with scores...');

  // Generate new seed maps
  const result = await generateSeedMaps(5);

  console.log('[RESEED] ═══════════════════════════════════════════════');
  console.log('[RESEED] RESEED COMPLETE');
  console.log('[RESEED] ═══════════════════════════════════════════════');
  console.log(`[RESEED] Deleted: ${seedMaps.length} old maps`);
  console.log(`[RESEED] Created: ${result.created} new maps`);

  await mongoose.disconnect();
  console.log('[RESEED] Done.');
}

main().catch(err => {
  console.error('[RESEED] Failed:', err);
  process.exit(1);
});
