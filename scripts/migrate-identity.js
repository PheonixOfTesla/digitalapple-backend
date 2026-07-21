#!/usr/bin/env node
/**
 * migrate-identity.js - Backfill identity layer for existing projects
 *
 * Idempotent: Safe to re-run. Skips projects whose Core already exists
 * and whose nodes all pass verifyNodeIdentity.
 *
 * Run against live DB AFTER local verification on a copy.
 *
 * Usage:
 *   node scripts/migrate-identity.js [--dry-run] [--verbose]
 *
 * Options:
 *   --dry-run   Preview changes without writing to DB
 *   --verbose   Print detailed progress
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Project = require('../models/Project');
const Node = require('../models/Node');
const Core = require('../models/Core');
const OrphanedNode = require('../models/OrphanedNode');
const identity = require('../services/identity');

// Parse CLI args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose');

// Stats tracking
const stats = {
  projectsProcessed: 0,
  projectsSkipped: 0,
  coresMinted: 0,
  nodesMigrated: 0,
  nodesQuarantined: 0,
  errors: []
};

function log(...args) {
  console.log(`[migrate-identity]`, ...args);
}

function verbose(...args) {
  if (VERBOSE) console.log(`  `, ...args);
}

/**
 * Check if project is already fully migrated
 */
async function isProjectMigrated(projectId) {
  const core = await Core.findOne({ projectId });
  if (!core) return false;

  // Check if all nodes have valid identity
  const nodes = await Node.find({ projectId });
  for (const node of nodes) {
    if (!node.coreId || !node.stableId || !node.path?.length) {
      return false;
    }
  }
  return true;
}

/**
 * Build node tree from flat list
 * Returns: { nodeMap, coreNode, orphans }
 */
function buildNodeTree(nodes) {
  const nodeMap = new Map();
  let coreNode = null;
  const orphans = [];

  // Index all nodes
  for (const node of nodes) {
    nodeMap.set(node._id.toString(), node);
    if (node.kind === 'core') {
      coreNode = node;
    }
  }

  // Check for orphans (missing parent or unreachable root)
  for (const node of nodes) {
    if (node.kind === 'core') continue; // Core is always valid

    if (node.parentNodeId) {
      const parent = nodeMap.get(node.parentNodeId.toString());
      if (!parent) {
        orphans.push({ node, reason: 'missing_parent', details: `Parent ${node.parentNodeId} not found` });
        continue;
      }
    }

    // Check if we can reach core
    let current = node;
    const visited = new Set();
    let reachable = false;

    while (current) {
      if (visited.has(current._id.toString())) {
        orphans.push({ node, reason: 'circular_reference', details: 'Path contains cycle' });
        break;
      }
      visited.add(current._id.toString());

      if (current.kind === 'core') {
        reachable = true;
        break;
      }

      if (!current.parentNodeId) {
        // No parent and not core = orphan
        orphans.push({ node, reason: 'unreachable_root', details: 'Cannot trace to core' });
        break;
      }

      current = nodeMap.get(current.parentNodeId.toString());
      if (!current) {
        orphans.push({ node, reason: 'missing_parent', details: `Parent ${node.parentNodeId} not found in chain` });
        break;
      }
    }
  }

  return { nodeMap, coreNode, orphans };
}

/**
 * Build path from node to core (walking up)
 */
function buildPathToNode(node, nodeMap, coreNode) {
  const path = [];
  let current = node;
  const visited = new Set();

  while (current) {
    if (visited.has(current._id.toString())) {
      return null; // Circular
    }
    visited.add(current._id.toString());

    path.unshift({ nodeId: current._id, title: current.title || current.label || 'Untitled' });

    if (current.kind === 'core' || current._id.toString() === coreNode?._id.toString()) {
      break;
    }

    if (!current.parentNodeId) {
      return null; // Can't reach core
    }

    current = nodeMap.get(current.parentNodeId.toString());
  }

  return path;
}

/**
 * Migrate a single project
 */
async function migrateProject(project) {
  const projectId = project._id;
  verbose(`Processing project ${projectId}: ${project.name}`);

  // Check if already migrated
  if (await isProjectMigrated(projectId)) {
    verbose(`  Skipping - already migrated`);
    stats.projectsSkipped++;
    return { migrated: 0, quarantined: 0 };
  }

  // Get all nodes
  const nodes = await Node.find({ projectId });
  if (nodes.length === 0) {
    verbose(`  No nodes - skipping`);
    stats.projectsSkipped++;
    return { migrated: 0, quarantined: 0 };
  }

  // Build tree and find orphans
  const { nodeMap, coreNode, orphans } = buildNodeTree(nodes);

  // If no core node, we need to create one
  let effectiveCoreNode = coreNode;
  if (!coreNode) {
    // Try to find a root node (no parent)
    const rootNodes = nodes.filter(n => !n.parentNodeId);
    if (rootNodes.length === 0) {
      // All nodes are orphans
      for (const node of nodes) {
        orphans.push({ node, reason: 'unreachable_root', details: 'No core or root node exists' });
      }
    } else {
      // Use first root as pseudo-core
      effectiveCoreNode = rootNodes[0];
      verbose(`  No core node found, using ${effectiveCoreNode._id} as pseudo-core`);
    }
  }

  // Quarantine orphans
  const orphanIds = new Set();
  for (const { node, reason, details } of orphans) {
    orphanIds.add(node._id.toString());

    if (!DRY_RUN) {
      // Move to quarantine
      await OrphanedNode.findOneAndUpdate(
        { originalNodeId: node._id },
        {
          originalNodeId: node._id,
          projectId,
          reason,
          details,
          nodeData: node.toObject(),
          quarantinedAt: new Date()
        },
        { upsert: true }
      );

      // Delete from Node collection
      await Node.deleteOne({ _id: node._id });
    }

    verbose(`  Quarantined: ${node._id} (${reason})`);
    stats.nodesQuarantined++;
  }

  // Filter out quarantined nodes
  const survivingNodes = nodes.filter(n => !orphanIds.has(n._id.toString()));

  if (survivingNodes.length === 0 || !effectiveCoreNode) {
    verbose(`  No surviving nodes or core - skipping`);
    return { migrated: 0, quarantined: orphans.length };
  }

  // Create or get Core document
  let coreDoc = await Core.findOne({ projectId });

  if (!coreDoc && !DRY_RUN) {
    // Build classification with required fields
    const existingClassification = project.blueprint?.classification;
    const classification = {
      type: existingClassification?.type || 'unknown',
      confidence: typeof existingClassification?.confidence === 'number' ? existingClassification.confidence : 0.5,
      alternates: existingClassification?.alternates || [],
      reasoning: existingClassification?.reasoning || 'Migrated - no classification available'
    };

    coreDoc = new Core({
      projectId,
      coreNodeId: effectiveCoreNode._id,
      premise: project.premise || project.name || 'Migrated project',
      classification,
      frameMeta: project.blueprint?.frameMeta || {},
      stagesEnabled: project.blueprint?.stagesEnabled ?? true
    });
    await coreDoc.save();
    stats.coresMinted++;
    verbose(`  Created Core: ${coreDoc._id}`);
  } else if (!coreDoc) {
    // Dry run - fake core ID
    coreDoc = { _id: new mongoose.Types.ObjectId() };
  }

  // Rebuild nodeMap for surviving nodes
  const finalNodeMap = new Map();
  for (const node of survivingNodes) {
    finalNodeMap.set(node._id.toString(), node);
  }

  // Migrate each surviving node
  let migrated = 0;
  for (const node of survivingNodes) {
    // Build path
    const path = buildPathToNode(node, finalNodeMap, effectiveCoreNode);
    if (!path) {
      verbose(`  Warning: Could not build path for ${node._id}`);
      continue;
    }

    // Compute identity fields
    const stableId = identity.computeStableId(coreDoc._id, path);
    const essence = identity.freezeEssence(node);

    // Determine derivation kind based on node kind
    let derivationKind = 'nebula';
    if (node.expansionType) {
      derivationKind = 'expand';
    }

    if (!DRY_RUN) {
      await Node.updateOne(
        { _id: node._id },
        {
          coreId: coreDoc._id,
          path,
          stableId,
          essence,
          derivation: {
            kind: derivationKind,
            sourcePrompt: null,
            usedTrace: false
          },
          // Backfill recursion fields if missing
          expanded: node.expanded ?? false,
          terminal: node.terminal ?? false,
          expansionType: node.expansionType ?? null,
          subFrameType: node.subFrameType ?? null,
          // Backfill scoping fields (scope-ready)
          nodeKind: node.nodeKind ?? 'component',
          scoped: node.scoped ?? false,
          scopedPaths: node.scopedPaths ?? [],
          scopeRecommendation: node.scopeRecommendation ?? null
        }
      );
    }

    migrated++;
    stats.nodesMigrated++;
  }

  verbose(`  Migrated ${migrated} nodes, quarantined ${orphans.length}`);
  return { migrated, quarantined: orphans.length };
}

/**
 * Verify all nodes in a project pass identity verification
 */
async function verifyProject(projectId) {
  const nodes = await Node.find({ projectId });
  const failures = [];

  for (const node of nodes) {
    const result = identity.quickVerifyIdentity(node);
    if (!result.valid) {
      failures.push({ nodeId: node._id, reason: result.reason });
    }
  }

  return failures;
}

/**
 * Main migration function
 */
async function main() {
  log('Starting identity migration...');
  log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE'}`);

  // Connect to DB
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  log('Connected to database');

  // Get all projects
  const projects = await Project.find({});
  log(`Found ${projects.length} projects to process`);

  // Process each project
  for (const project of projects) {
    try {
      stats.projectsProcessed++;
      await migrateProject(project);
    } catch (err) {
      console.error(`Error migrating project ${project._id}:`, err);
      stats.errors.push({ projectId: project._id, error: err.message });
    }
  }

  // Verification pass
  log('Running verification...');
  let verificationFailures = 0;

  for (const project of projects) {
    const failures = await verifyProject(project._id);
    if (failures.length > 0) {
      verificationFailures += failures.length;
      if (VERBOSE) {
        for (const f of failures) {
          console.log(`  VERIFY FAIL: Project ${project._id}, Node ${f.nodeId}: ${f.reason}`);
        }
      }
    }
  }

  // Print summary
  log('');
  log('═══════════════════════════════════════════════');
  log('MIGRATION COMPLETE');
  log('═══════════════════════════════════════════════');
  log(`Projects processed:    ${stats.projectsProcessed}`);
  log(`Projects skipped:      ${stats.projectsSkipped}`);
  log(`Cores minted:          ${stats.coresMinted}`);
  log(`Nodes migrated:        ${stats.nodesMigrated}`);
  log(`Nodes quarantined:     ${stats.nodesQuarantined}`);
  log(`Verification failures: ${verificationFailures}`);
  log(`Errors:                ${stats.errors.length}`);

  if (stats.errors.length > 0) {
    log('');
    log('ERRORS:');
    for (const err of stats.errors) {
      log(`  Project ${err.projectId}: ${err.error}`);
    }
  }

  if (DRY_RUN) {
    log('');
    log('This was a DRY RUN. No changes were made.');
    log('Run without --dry-run to apply changes.');
  }

  await mongoose.disconnect();
  log('Done.');
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
