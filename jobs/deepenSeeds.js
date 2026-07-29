/**
 * Deepen seeds — upgrade shallow fast-seeded Atlas maps to COMPLETE atlases:
 * five layers (core → constellation → aspect → sub-aspect → ACTION terminal),
 * every node kept, coverage ~100.
 *
 * Targets isSeed maps with nodeCount < 20 (the old 2-layer fast graphs) and
 * regenerates their graphs in place with generateDeepGraph — same premise,
 * same SharedMap id, same URL; only the graph underneath gets real depth.
 * Bulk operations per map; idempotent (deepened maps stop matching).
 */
const mongoose = require('mongoose');
const SharedMap = require('../models/SharedMap');
const Node = require('../models/Node');
const Edge = require('../models/Edge');
const Core = require('../models/Core');
const identity = require('../services/identity');
const { generateDeepGraph, generatePreviewSvg, calculateCoverage } = require('./seedMaps');

async function deepenOne(m) {
  const premise = m.description || m.title || '';
  const category = m.category || 'other';
  const projectId = m.projectId;
  if (!projectId || !premise) return false;

  const { nodes, edges } = generateDeepGraph(premise, category);
  const coreData = nodes.find(n => n.depth === 0);
  const coreDoc = await Core.findOne({ projectId }).lean();

  // Build all Node docs in memory: paths chain parent→child, so identity
  // fields can be computed without any per-node DB lookups.
  const byId = new Map();
  const docs = [];
  const corePath = [{ nodeId: coreData._id, title: 'CORE' }];
  const coreNodeDoc = {
    _id: coreData._id, projectId, kind: 'core', label: 'CORE', title: 'CORE',
    statement: coreData.statement, detail: coreData.detail, depth: 0,
    x: coreData.x, y: coreData.y,
    coreId: coreDoc ? coreDoc._id : undefined,
    path: corePath,
    stableId: coreDoc ? identity.computeStableId(coreDoc._id, corePath) : undefined,
    derivation: { kind: 'nebula', sourcePrompt: premise, usedTrace: true }
  };
  byId.set(String(coreData._id), coreNodeDoc);
  docs.push(coreNodeDoc);

  for (const n of nodes.filter(n => n.depth > 0).sort((a, b) => a.depth - b.depth)) {
    const parent = byId.get(String(n.parentNodeId));
    const path = [...(parent ? parent.path : corePath), { nodeId: n._id, title: n.label }];
    const doc = {
      _id: n._id, projectId, parentNodeId: n.parentNodeId,
      kind: n.depth === 1 ? 'constellation' : 'star',
      label: n.label, title: n.label, statement: n.statement, detail: n.detail,
      constellation: n.constellation, stage: n.stage, status: n.status,
      depth: n.depth, x: n.x, y: n.y, scores: n.scores,
      terminal: !!n.terminal, determination: n.determination || 'actionable',
      action: n.action || null,
      coreId: coreDoc ? coreDoc._id : undefined,
      path,
      stableId: coreDoc ? identity.computeStableId(coreDoc._id, path) : undefined,
      derivation: { kind: 'nebula', sourcePrompt: premise, usedTrace: true }
    };
    try { doc.essence = identity.freezeEssence(doc); } catch (e) { /* optional */ }
    byId.set(String(n._id), doc);
    docs.push(doc);
  }

  await Node.deleteMany({ projectId });
  await Edge.deleteMany({ projectId });
  await Node.insertMany(docs, { ordered: false });
  await Edge.insertMany(edges.map(e => ({
    _id: e._id, projectId, fromNodeId: e.sourceId, toNodeId: e.targetId, type: 'contains'
  })), { ordered: false });
  if (coreDoc) await Core.updateOne({ _id: coreDoc._id }, { $set: { coreNodeId: coreData._id } });

  const others = docs.filter(d => d.kind !== 'core');
  const snapshot = {
    core: {
      _id: coreNodeDoc._id, kind: 'core', label: 'CORE', title: 'CORE',
      statement: coreNodeDoc.statement, detail: coreNodeDoc.detail,
      x: coreNodeDoc.x, y: coreNodeDoc.y,
      coreId: coreNodeDoc.coreId, path: coreNodeDoc.path, stableId: coreNodeDoc.stableId,
      derivation: coreNodeDoc.derivation, terminal: false
    },
    nodes: others.map(n => ({
      _id: n._id, parentNodeId: n.parentNodeId, kind: n.kind,
      label: n.label, title: n.title, statement: n.statement, detail: n.detail,
      constellation: n.constellation, stage: n.stage, status: n.status,
      depth: n.depth, x: n.x, y: n.y, scores: n.scores,
      terminal: n.terminal, determination: n.determination, action: n.action,
      coreId: n.coreId, path: n.path, stableId: n.stableId, essence: n.essence,
      derivation: n.derivation
    })),
    edges: edges.map(e => ({ _id: e._id, sourceId: e.sourceId, targetId: e.targetId }))
  };
  const coverage = calculateCoverage(docs.map(d => ({ ...d, depth: d.depth || 0 })));
  await SharedMap.updateOne({ _id: m._id }, {
    $set: { snapshot, previewSvg: generatePreviewSvg(snapshot), nodeCount: docs.length, coverage }
  });
  return true;
}

async function deepenSeeds({ batchSize = 100, onProgress = () => {} } = {}) {
  let done = 0, failed = 0;
  for (;;) {
    const maps = await SharedMap.find({ isSeed: true, unpublishedAt: null, nodeCount: { $lt: 20 } })
      .select('projectId title description category nodeCount').limit(batchSize).lean();
    if (!maps.length) break;
    let batchDone = 0;
    for (const m of maps) {
      try { (await deepenOne(m)) ? (done++, batchDone++) : failed++; }
      catch (e) { failed++; console.error('[deepen] fail:', m.title, e.message); }
    }
    onProgress({ done, failed });
    // Failed maps still match the query — bail when a whole batch makes zero
    // progress so a poison doc can't loop forever.
    if (batchDone === 0) break;
  }
  return { done, failed };
}

module.exports = { deepenSeeds, deepenOne };
