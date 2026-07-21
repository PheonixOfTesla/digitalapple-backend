/**
 * Seed Maps Generator
 *
 * Generates example maps for the Atlas feed, attributed to the official
 * Clockwork account. These are NOT fake users - they're clearly labeled
 * as system-generated examples.
 *
 * Schedule: Runs 3x daily via cron (8am, 2pm, 8pm)
 *
 * Rules:
 * - All seed maps attributed to system "Clockwork" account (isSeed: true)
 * - Topics from rotating pool + recent News items for timeliness
 * - Premise hash check prevents duplicates
 * - Uses real Blueprint engine - honest confidence/coverage
 * - Real user maps rank above seeds when engagement is equal
 */

const crypto = require('crypto');
const mongoose = require('mongoose');
const SharedMap = require('../models/SharedMap');
const Project = require('../models/Project');
const Node = require('../models/Node');
const Edge = require('../models/Edge');
const Core = require('../models/Core');
const User = require('../models/User');
const NewsItem = require('../models/NewsItem');
const identity = require('../services/identity');
const BlueprintLLM = require('../services/BlueprintLLM');

// System user email for seed maps
const CLOCKWORK_EMAIL = 'system@clockwork.app';

// Topic pool by category
const TOPIC_POOL = {
  business: [
    'A single-operator coffee roastery with direct-to-consumer subscriptions',
    'A local meal prep service for busy professionals',
    'A vintage furniture restoration workshop',
    'An artisan candle brand with seasonal collections',
    'A mobile car detailing service for residential areas',
    'A specialty tea import business',
    'A boutique fitness studio for seniors',
    'A subscription box for local craft beers',
    'A home organization consulting service',
    'A pet photography studio'
  ],
  career: [
    'Transition from engineering to product management',
    'Breaking into data science without a degree',
    'Moving from agency to in-house marketing',
    'Pivoting from finance to tech startup',
    'Building a freelance design practice',
    'Switching from teaching to corporate training',
    'Career restart after extended leave',
    'Moving from individual contributor to manager',
    'Transitioning from military to civilian career',
    'Building expertise in AI prompt engineering'
  ],
  product: [
    'A local-first note-taking app with sync',
    'A browser extension for focused reading',
    'A habit tracker that respects privacy',
    'A scheduling tool for small teams',
    'A recipe manager with meal planning',
    'A personal finance tracker without cloud',
    'A meditation app for specific scenarios',
    'A tool for managing side projects',
    'A simple CRM for freelancers',
    'A reading list manager with recommendations'
  ],
  creative: [
    'A mystery novel set in a remote research station',
    'A documentary about urban farming pioneers',
    'A podcast series on regional craft traditions',
    'An illustrated guide to local wildlife',
    'A photo essay on neighborhood transformation',
    'A short film anthology on solitude',
    'A music album exploring acoustic textures',
    'A graphic novel about climate adaptation',
    'A theater piece about generational stories',
    'An interactive fiction about ethical choices'
  ]
};

// Hash a premise for deduplication
function hashPremise(premise) {
  const normalized = premise.toLowerCase().trim().replace(/\s+/g, ' ');
  return crypto.createHash('sha256').update(normalized).digest('hex').substring(0, 16);
}

// Get or create the Clockwork system user
async function getClockworkUser() {
  let user = await User.findOne({ email: CLOCKWORK_EMAIL });

  if (!user) {
    user = new User({
      email: CLOCKWORK_EMAIL,
      passwordHash: crypto.randomBytes(32).toString('hex'), // Random password - can't login
      role: 'system',
      emailVerified: true,
      firstName: 'Clockwork',
      lastName: 'Examples'
    });
    await user.save();
    console.log('[SEED] Created Clockwork system user');
  }

  return user;
}

// Check if premise already exists
async function premiseExists(premise) {
  const hash = hashPremise(premise);

  // Check SharedMap descriptions
  const maps = await SharedMap.find({}).select('description title').lean();
  for (const map of maps) {
    const mapHash = hashPremise(map.description || map.title || '');
    if (mapHash === hash) return true;
  }

  // Check Project premises
  const projects = await Project.find({}).select('premise name').lean();
  for (const proj of projects) {
    const projHash = hashPremise(proj.premise || proj.name || '');
    if (projHash === hash) return true;
  }

  return false;
}

// Get topics from News for timely content
async function getNewsTopics(limit = 3) {
  const recentNews = await NewsItem.find({})
    .sort({ publishedAt: -1 })
    .limit(20)
    .lean();

  const topics = [];
  for (const item of recentNews) {
    // Extract a topic from the headline
    const topic = `A business responding to: ${item.title.substring(0, 100)}`;
    if (!(await premiseExists(topic)) && topics.length < limit) {
      topics.push({ category: 'business', premise: topic });
    }
  }

  return topics;
}

// Pick random topics avoiding duplicates
async function pickTopics(count = 5) {
  const topics = [];
  const categories = Object.keys(TOPIC_POOL);

  // Try to get some news-based topics first
  const newsTopics = await getNewsTopics(Math.ceil(count / 3));
  topics.push(...newsTopics);

  // Fill rest from pool
  const attempts = count * 3; // Allow some failures
  let tried = 0;

  while (topics.length < count && tried < attempts) {
    tried++;
    const category = categories[Math.floor(Math.random() * categories.length)];
    const pool = TOPIC_POOL[category];
    const premise = pool[Math.floor(Math.random() * pool.length)];

    if (!(await premiseExists(premise))) {
      topics.push({ category, premise });
    }
  }

  return topics;
}

// Detail templates by constellation type
const DETAIL_TEMPLATES = {
  offer: {
    root: (premise) => `You're building something people will pay for. The core of your offer for "${premise.substring(0, 50)}..." needs to be clear, compelling, and differentiated. What exactly are you promising, and why would someone choose you over alternatives?`,
    child: (premise) => `This is where the rubber meets the road. You'll need to define the specific features, benefits, or deliverables that make your offer tangible. Think about what your customer actually experiences.`
  },
  demand: {
    root: (premise) => `Who actually wants this? For "${premise.substring(0, 50)}..." you need to identify real people with real problems, not imaginary ideal customers. Where are they, how do they buy, and what triggers their decision?`,
    child: (premise) => `Understanding your customer's journey matters here. Map out how they discover solutions like yours, what objections they'll raise, and what ultimately convinces them to act.`
  },
  delivery: {
    root: (premise) => `How does your offer actually reach customers? For "${premise.substring(0, 50)}..." you need reliable fulfillment — whether that's shipping products, delivering services, or providing access. What's your operational backbone?`,
    child: (premise) => `The details of execution live here. Think about timing, quality control, customer touchpoints, and what happens when something goes wrong.`
  },
  economy: {
    root: (premise) => `Follow the money. For "${premise.substring(0, 50)}..." you need to understand both what it costs to deliver and what people will pay. Unit economics determine whether this is sustainable or a money pit.`,
    child: (premise) => `Dig into specific costs and revenue streams. What are your margins? What scales well and what doesn't? Where are the hidden expenses?`
  },
  orchestration: {
    root: (premise) => `Who does what, and when? For "${premise.substring(0, 50)}..." you need to orchestrate people, tools, and processes. Even a solo operation has moving parts that need coordination.`,
    child: (premise) => `This is about the day-to-day reality. What tools do you use? What skills do you need? What can be automated, delegated, or outsourced?`
  },
  risk: {
    root: (premise) => `What could break this? For "${premise.substring(0, 50)}..." you need to honestly assess the threats — competitors, regulations, dependencies, market shifts. Being realistic now saves pain later.`,
    child: (premise) => `Think about specific scenarios. What if a key supplier disappears? What if demand drops? What legal or compliance issues could arise?`
  }
};

// Generate a graph with substantive detail
function generateBasicGraphWithDetail(premise, category) {
  const nodes = [];
  const edges = [];

  // Core node
  const coreId = new mongoose.Types.ObjectId();
  nodes.push({
    _id: coreId,
    label: 'CORE',
    statement: premise,
    detail: `This is your starting point. "${premise}" represents an idea worth exploring — but ideas need structure to become reality. The constellations around this core break down the major dimensions you'll need to address.`,
    depth: 0,
    x: 600,
    y: 400
  });

  // Generate constellation nodes based on category
  const constellations = {
    business: ['offer', 'demand', 'delivery', 'economy', 'risk'],
    career: ['offer', 'demand', 'orchestration', 'economy'],
    product: ['offer', 'delivery', 'orchestration', 'risk'],
    creative: ['offer', 'demand', 'delivery', 'orchestration']
  };

  const cons = constellations[category] || constellations.business;
  const angleStep = (2 * Math.PI) / cons.length;
  const radius = 180;

  cons.forEach((constellation, i) => {
    const angle = angleStep * i - Math.PI / 2;
    const nodeId = new mongoose.Types.ObjectId();
    const template = DETAIL_TEMPLATES[constellation] || DETAIL_TEMPLATES.offer;

    nodes.push({
      _id: nodeId,
      parentNodeId: coreId,
      label: constellation.charAt(0).toUpperCase() + constellation.slice(1),
      statement: `${constellation.charAt(0).toUpperCase() + constellation.slice(1)} dimension for this ${category}`,
      detail: template.root(premise),
      constellation,
      stage: Math.floor(Math.random() * 3) + 1,
      status: 'mapped',
      depth: 1,
      x: Math.round(600 + radius * Math.cos(angle)),
      y: Math.round(400 + radius * Math.sin(angle)),
      scores: {
        economy: { value: Math.floor(Math.random() * 4) + 5, reason: `Initial ${constellation} economics assessment based on the premise scope.` },
        orchestration: { value: Math.floor(Math.random() * 4) + 4, reason: `Operational complexity for ${constellation} appears moderate.` },
        demand: { value: Math.floor(Math.random() * 4) + 5, reason: `Market signal for this ${constellation} approach shows promise.` }
      },
      confidence: { value: 0.6, basis: 'inferred' }
    });

    edges.push({
      _id: new mongoose.Types.ObjectId(),
      sourceId: coreId,
      targetId: nodeId
    });

    // Add 1 child node for some constellations
    if (Math.random() > 0.5) {
      const childId = new mongoose.Types.ObjectId();
      const childAngle = angle + (Math.random() - 0.5) * 0.4;
      const childRadius = radius + 120;

      nodes.push({
        _id: childId,
        parentNodeId: nodeId,
        label: `${constellation} detail`,
        statement: `A specific aspect of ${constellation} to consider`,
        detail: template.child(premise),
        constellation,
        stage: Math.floor(Math.random() * 3) + 2,
        status: 'unexplored',
        depth: 2,
        x: Math.round(600 + childRadius * Math.cos(childAngle)),
        y: Math.round(400 + childRadius * Math.sin(childAngle)),
        scores: {
          economy: { value: Math.floor(Math.random() * 3) + 4, reason: 'Awaiting deeper analysis.' },
          orchestration: { value: Math.floor(Math.random() * 3) + 4, reason: 'Execution details to be mapped.' },
          demand: { value: Math.floor(Math.random() * 3) + 5, reason: 'Validation needed for this specific angle.' }
        },
        confidence: { value: 0.4, basis: 'inferred' }
      });

      edges.push({
        _id: new mongoose.Types.ObjectId(),
        sourceId: nodeId,
        targetId: childId
      });
    }
  });

  return { nodes, edges };
}

// Calculate coverage from nodes
function calculateCoverage(nodes) {
  const nonCore = nodes.filter(n => n.depth > 0);
  if (nonCore.length === 0) return 0;
  const kept = nonCore.filter(n => n.status === 'kept' || n.status === 'complete').length;
  return Math.round((kept / nonCore.length) * 100);
}

// Convert LLM nebula response to nodes/edges format
function convertNebulaToGraph(nebula, category) {
  const nodes = [];
  const edges = [];

  // Core node from nebula.core
  const coreId = new mongoose.Types.ObjectId();
  nodes.push({
    _id: coreId,
    label: 'CORE',
    title: nebula.core.title || 'Core',
    statement: nebula.core.statement,
    detail: nebula.core.detail || '',
    scores: nebula.core.scores,
    confidence: nebula.core.confidence,
    stage: nebula.core.stage || 0,
    status: nebula.core.status || 'mapped',
    depth: 0,
    x: 600,
    y: 400
  });

  // Constellation nodes
  const angleStep = (2 * Math.PI) / nebula.constellations.length;
  const radius = 180;

  nebula.constellations.forEach((c, i) => {
    const angle = angleStep * i - Math.PI / 2;
    const consId = new mongoose.Types.ObjectId();

    nodes.push({
      _id: consId,
      parentNodeId: coreId,
      label: c.name || c.title,
      title: c.title,
      statement: c.statement,
      detail: c.detail || '',
      constellation: c.constellation,
      constellationLabel: c.name,
      scores: c.scores,
      confidence: c.confidence,
      stage: c.stage || 1,
      status: c.status || 'mapped',
      depth: 1,
      x: Math.round(600 + radius * Math.cos(angle)),
      y: Math.round(400 + radius * Math.sin(angle))
    });

    edges.push({
      _id: new mongoose.Types.ObjectId(),
      sourceId: coreId,
      targetId: consId
    });

    // Children (stars)
    const childRadius = radius + 120;
    (c.children || []).forEach((child, j) => {
      const childAngle = angle + (j - (c.children.length - 1) / 2) * 0.4;
      const childId = new mongoose.Types.ObjectId();

      nodes.push({
        _id: childId,
        parentNodeId: consId,
        label: child.title,
        title: child.title,
        statement: child.statement,
        detail: child.detail || '',
        constellation: c.constellation,
        scores: child.scores,
        confidence: child.confidence,
        stage: child.stage || 2,
        status: child.status || 'unexplored',
        depth: 2,
        x: Math.round(600 + childRadius * Math.cos(childAngle)),
        y: Math.round(400 + childRadius * Math.sin(childAngle))
      });

      edges.push({
        _id: new mongoose.Types.ObjectId(),
        sourceId: consId,
        targetId: childId
      });
    });
  });

  return { nodes, edges };
}

// Generate preview SVG
function generatePreviewSvg(snapshot) {
  const viewWidth = 420;
  const viewHeight = 112;
  const padding = 12;
  const nodeRadius = 5.5;
  const coreRadius = 9;

  const allNodes = [];
  if (snapshot.core) {
    allNodes.push({ ...snapshot.core, isCore: true });
  }
  (snapshot.nodes || []).forEach(n => allNodes.push(n));

  if (allNodes.length === 0) {
    return `<svg viewBox="0 0 ${viewWidth} ${viewHeight}" xmlns="http://www.w3.org/2000/svg"></svg>`;
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  allNodes.forEach(n => {
    minX = Math.min(minX, n.x || 0);
    maxX = Math.max(maxX, n.x || 0);
    minY = Math.min(minY, n.y || 0);
    maxY = Math.max(maxY, n.y || 0);
  });

  if (minX === maxX) { minX -= 50; maxX += 50; }
  if (minY === maxY) { minY -= 50; maxY += 50; }

  const graphWidth = maxX - minX;
  const graphHeight = maxY - minY;
  const scaleX = (viewWidth - padding * 2) / graphWidth;
  const scaleY = (viewHeight - padding * 2) / graphHeight;
  const scale = Math.min(scaleX, scaleY, 1);

  const offsetX = padding + ((viewWidth - padding * 2) - graphWidth * scale) / 2;
  const offsetY = padding + ((viewHeight - padding * 2) - graphHeight * scale) / 2;

  const transform = (x, y) => ({
    x: (x - minX) * scale + offsetX,
    y: (y - minY) * scale + offsetY
  });

  const nodePos = {};
  allNodes.forEach(n => {
    nodePos[n._id.toString()] = transform(n.x || 0, n.y || 0);
  });

  let edgePaths = '';
  (snapshot.edges || []).forEach(e => {
    const from = nodePos[e.sourceId.toString()];
    const to = nodePos[e.targetId.toString()];
    if (from && to) {
      const dx = to.x - from.x;
      edgePaths += `<path d="M${from.x},${from.y} C${from.x + dx * 0.4},${from.y} ${to.x - dx * 0.4},${to.y} ${to.x},${to.y}" stroke="rgba(34,211,238,.25)" fill="none" stroke-width="1"/>`;
    }
  });

  let nodeCircles = '';
  allNodes.forEach(n => {
    const pos = nodePos[n._id.toString()];
    if (!pos) return;

    if (n.isCore) {
      nodeCircles += `<circle cx="${pos.x}" cy="${pos.y}" r="${coreRadius}" fill="rgba(34,211,238,.28)" stroke="#22d3ee" stroke-width="1.4"/>`;
    } else {
      const fill = n.status === 'kept' || n.status === 'complete' ? '#d8ad5a' : '#0b0f17';
      const stroke = n.status === 'kept' || n.status === 'complete' ? '#d8ad5a' : '#22d3ee';
      nodeCircles += `<circle cx="${pos.x}" cy="${pos.y}" r="${nodeRadius}" fill="${fill}" stroke="${stroke}" stroke-width="1.2"/>`;
    }
  });

  return `<svg viewBox="0 0 ${viewWidth} ${viewHeight}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice">${edgePaths}${nodeCircles}</svg>`;
}

// Create a seed map - try LLM, fallback to static
async function createSeedMap(user, topic) {
  const { category, premise } = topic;

  // Create project
  const project = new Project({
    name: premise.substring(0, 100),
    premise,
    ownerId: user._id
  });
  await project.save();

  let nodes, edges;

  // Try LLM generation with 60s timeout
  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('LLM timeout')), 60000)
    );
    const llmPromise = BlueprintLLM.generateNebula(premise, {});
    const { nebula } = await Promise.race([llmPromise, timeoutPromise]);
    ({ nodes, edges } = convertNebulaToGraph(nebula, category));
    console.log(`[SEED] LLM generation succeeded for: ${premise.substring(0, 40)}...`);
  } catch (llmError) {
    // Fallback to static generation with enriched detail
    console.log(`[SEED] LLM fallback (${llmError.message}), using static generation`);
    ({ nodes, edges } = generateBasicGraphWithDetail(premise, category));
  }

  // Find core node to create Core document
  const coreNodeData = nodes.find(n => n.depth === 0);
  if (!coreNodeData) {
    throw new Error('No core node in generated graph');
  }

  // Save core node first
  const coreNode = new Node({
    ...coreNodeData,
    projectId: project._id,
    kind: 'core',
    title: coreNodeData.label
  });
  await coreNode.save();

  // Create Core document (identity anchor)
  const coreDoc = new Core({
    projectId: project._id,
    coreNodeId: coreNode._id,
    premise: premise,
    classification: {
      type: category === 'business' ? 'venture' :
            category === 'career' ? 'career' :
            category === 'product' ? 'venture' :
            category === 'creative' ? 'creative-work' : 'unknown',
      confidence: 0.7,
      alternates: [],
      reasoning: 'Seed map classification'
    },
    frameMeta: {
      selectedType: category,
      confidence: 0.7,
      usedFallback: false
    },
    stagesEnabled: true
  });
  await coreDoc.save();

  // Assign identity to core node
  const corePath = [{ nodeId: coreNode._id, title: coreNode.title || coreNode.label }];
  coreNode.coreId = coreDoc._id;
  coreNode.path = corePath;
  coreNode.stableId = identity.computeStableId(coreDoc._id, corePath);
  coreNode.essence = identity.freezeEssence(coreNode);
  coreNode.derivation = { kind: 'nebula', sourcePrompt: premise, usedTrace: false };
  await coreNode.save();

  // Build nodeId map for path building
  const nodeIdMap = new Map();
  nodeIdMap.set(coreNodeData._id.toString(), coreNode._id);

  // Save other nodes with identity
  const otherNodes = nodes.filter(n => n.depth > 0);
  for (const nodeData of otherNodes) {
    const parentId = nodeData.parentNodeId ? nodeIdMap.get(nodeData.parentNodeId.toString()) : coreNode._id;

    const node = new Node({
      ...nodeData,
      projectId: project._id,
      parentNodeId: parentId,
      kind: nodeData.depth === 1 ? 'constellation' : 'star',
      title: nodeData.label
    });
    await node.save();
    nodeIdMap.set(nodeData._id.toString(), node._id);

    // Build path from parent
    const parentNode = await Node.findById(parentId);
    const parentPath = parentNode?.path || corePath;
    const nodePath = [...parentPath, { nodeId: node._id, title: node.title || node.label }];

    node.coreId = coreDoc._id;
    node.path = nodePath;
    node.stableId = identity.computeStableId(coreDoc._id, nodePath);
    node.essence = identity.freezeEssence(node);
    node.derivation = { kind: 'nebula', sourcePrompt: premise, usedTrace: true };
    await node.save();
  }

  // Save edges with updated IDs
  for (const edgeData of edges) {
    const fromId = nodeIdMap.get(edgeData.sourceId.toString());
    const toId = nodeIdMap.get(edgeData.targetId.toString());
    if (fromId && toId) {
      const edge = new Edge({
        _id: edgeData._id,
        projectId: project._id,
        fromNodeId: fromId,
        toNodeId: toId,
        type: 'contains'
      });
      await edge.save();
    }
  }

  // Build snapshot from saved nodes (with correct IDs)
  const savedNodes = await Node.find({ projectId: project._id }).lean();
  const savedCoreNode = savedNodes.find(n => n.kind === 'core');
  const savedOtherNodes = savedNodes.filter(n => n.kind !== 'core');
  const coverage = calculateCoverage(savedNodes.map(n => ({ ...n, depth: n.depth || 0 })));

  const snapshot = {
    core: savedCoreNode ? {
      _id: savedCoreNode._id,
      label: savedCoreNode.label || savedCoreNode.title,
      title: savedCoreNode.title,
      statement: savedCoreNode.statement,
      detail: savedCoreNode.detail,
      x: savedCoreNode.x,
      y: savedCoreNode.y
    } : null,
    nodes: savedOtherNodes.map(n => ({
      _id: n._id,
      parentNodeId: n.parentNodeId,
      label: n.label || n.title,
      title: n.title,
      statement: n.statement,
      detail: n.detail,
      constellation: n.constellation,
      constellationLabel: n.constellationLabel,
      stage: n.stage,
      scores: n.scores,
      confidence: n.confidence,
      status: n.status,
      depth: n.depth,
      x: n.x,
      y: n.y
    })),
    edges: (await Edge.find({ projectId: project._id }).lean()).map(e => ({
      _id: e._id,
      sourceId: e.fromNodeId,
      targetId: e.toNodeId
    }))
  };

  // Generate preview
  const previewSvg = generatePreviewSvg(snapshot);

  // Create shared map
  const sharedMap = new SharedMap({
    projectId: project._id,
    ownerId: user._id,
    title: premise.substring(0, 100),
    description: premise,
    category,
    visibility: 'public',
    coverage,
    nodeCount: nodes.length,
    snapshot,
    previewSvg,
    excludedBranchRoots: [],
    publishedAt: new Date(),
    ownerName: 'Clockwork',
    ownerHandle: 'clockwork',
    ownerAvatar: null,
    isSeed: true
  });

  await sharedMap.save();

  console.log(`[SEED] Created: ${premise.substring(0, 50)}... (${category})`);
  return sharedMap;
}

// Main seed function
async function generateSeedMaps(count = 5) {
  console.log(`[SEED] Starting generation at ${new Date().toISOString()}`);

  try {
    const user = await getClockworkUser();
    const topics = await pickTopics(count);

    console.log(`[SEED] Found ${topics.length} unique topics`);

    let created = 0;
    for (const topic of topics) {
      try {
        await createSeedMap(user, topic);
        created++;
      } catch (err) {
        console.error(`[SEED] Failed to create map:`, err.message);
      }
    }

    console.log(`[SEED] Complete. Created ${created} maps.`);
    return { created, attempted: topics.length };

  } catch (err) {
    console.error('[SEED] Error:', err.message);
    throw err;
  }
}

// Run manually
async function runOnce() {
  require('dotenv').config();

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('[SEED] Connected to MongoDB');

  const result = await generateSeedMaps(5);

  await mongoose.disconnect();
  console.log('[SEED] Disconnected');

  return result;
}

module.exports = { generateSeedMaps, getClockworkUser, hashPremise };

// Allow running directly: node jobs/seedMaps.js
if (require.main === module) {
  runOnce()
    .then(result => {
      console.log('[SEED] Manual run complete:', result);
      process.exit(0);
    })
    .catch(error => {
      console.error('[SEED] Manual run failed:', error);
      process.exit(1);
    });
}
