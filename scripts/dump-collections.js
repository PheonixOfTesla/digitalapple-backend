#!/usr/bin/env node
/**
 * dump-collections.js - Export Blueprint collections for backup
 *
 * Creates a JSON dump of all Blueprint collections before migration.
 * This is the safety snapshot required before identity migration.
 *
 * Usage: node scripts/dump-collections.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const Project = require('../models/Project');
const Node = require('../models/Node');
const Edge = require('../models/Edge');
const Core = require('../models/Core');
const UserQuota = require('../models/UserQuota');

async function main() {
  console.log('[dump] Starting collection dump...');

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log('[dump] Connected to database');

  // Create dump directory
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dumpDir = path.join(__dirname, '..', 'backups', `dump-${timestamp}`);
  fs.mkdirSync(dumpDir, { recursive: true });

  console.log(`[dump] Dump directory: ${dumpDir}`);

  // Dump each collection
  const collections = [
    { name: 'projects', model: Project },
    { name: 'nodes', model: Node },
    { name: 'edges', model: Edge },
    { name: 'cores', model: Core },
    { name: 'userquotas', model: UserQuota }
  ];

  const stats = {};

  for (const { name, model } of collections) {
    try {
      const docs = await model.find({}).lean();
      const filePath = path.join(dumpDir, `${name}.json`);
      fs.writeFileSync(filePath, JSON.stringify(docs, null, 2));
      stats[name] = docs.length;
      console.log(`[dump] ${name}: ${docs.length} documents`);
    } catch (err) {
      console.error(`[dump] Error dumping ${name}:`, err.message);
      stats[name] = 'ERROR';
    }
  }

  // Write summary
  const summary = {
    timestamp: new Date().toISOString(),
    collections: stats,
    totalDocuments: Object.values(stats).filter(v => typeof v === 'number').reduce((a, b) => a + b, 0)
  };

  fs.writeFileSync(path.join(dumpDir, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log('[dump]');
  console.log('[dump] ═══════════════════════════════════════════════');
  console.log('[dump] DUMP COMPLETE');
  console.log('[dump] ═══════════════════════════════════════════════');
  console.log(`[dump] Path: ${dumpDir}`);
  console.log(`[dump] Projects: ${stats.projects}`);
  console.log(`[dump] Nodes: ${stats.nodes}`);
  console.log(`[dump] Edges: ${stats.edges}`);
  console.log(`[dump] Cores: ${stats.cores}`);
  console.log(`[dump] UserQuotas: ${stats.userquotas}`);
  console.log(`[dump] Total: ${summary.totalDocuments} documents`);

  await mongoose.disconnect();
  console.log('[dump] Done.');

  return dumpDir;
}

main().catch(err => {
  console.error('[dump] Failed:', err);
  process.exit(1);
});
