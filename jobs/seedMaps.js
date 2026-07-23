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

// ============== TOPIC POOL ==============
// Built from curated components across the full college-genius media spectrum:
// tech/startups, money/markets, science, culture/notable people, career/college,
// product, creative. buildTopicPool() combines angles × subjects (deduped) to
// produce 1000+ unique premises so the Atlas rotates for a long time.

const VENTURE_ANGLES = ['How to start', 'How I bootstrapped', 'How to fund', 'How to scale', 'How to market', 'How to validate', 'How I launched', 'The economics of running'];
const VENTURES = [
  'a campus coffee cart', 'a Notion template shop', 'a faceless YouTube channel', 'a print-on-demand clothing brand',
  'a student tutoring collective', 'a micro-SaaS', 'an Etsy handmade shop', 'a paid newsletter', 'a Discord community business',
  'a mobile car-detailing service', 'a dropshipping store', 'a local meal-prep service', 'a photography side business',
  'a mobile app studio', 'an online course', 'a thrift-flipping resale business', 'a freelance web-dev practice',
  'a social-media marketing agency', 'a vending-machine route', 'a pressure-washing business', 'a subscription box brand',
  'a personal-training business', 'a podcast network', 'a digital art store', 'a landscaping company', 'a food truck',
  'a candle brand', 'a sneaker resale business', 'a copywriting agency', 'a dog-walking business', 'a video-editing service',
  'a UGC creator business', 'a Shopify theme shop', 'a boutique gym', 'an AI automation agency', 'a stock-photo business',
  'a wedding-photography business', 'a home-bakery brand', 'a book-summary newsletter', 'a resume-writing service',
  'a house-cleaning company', 'a tutoring marketplace', 'a merch brand for creators', 'a plant nursery', 'a bike-repair shop',
  'a cold-email lead-gen agency', 'a rentable photo-studio space', 'a specialty coffee roastery', 'an indie game studio', 'a niche affiliate site'
];

const CAREER_ANGLES = ['How to break into', 'How I got into', 'How to land a job in', 'How to build a career in', 'What it really takes to succeed in'];
const CAREER_FIELDS = [
  'quant trading', 'venture capital', 'product management', 'data science', 'game development', 'investment banking',
  'UX design', 'AI research', 'management consulting', 'software engineering at big tech', 'biotech', 'aerospace engineering',
  'cybersecurity', 'growth marketing', 'technical writing', 'robotics', 'sports analytics', 'film production', 'journalism',
  'clinical psychology', 'architecture', 'law', 'medicine', 'academia', 'private equity', 'machine learning engineering',
  'devrel', 'hardware engineering', 'nursing', 'physical therapy', 'commercial real estate', 'supply chain', 'brand strategy',
  'animation', 'music production', 'fashion design', 'sports management', 'public policy', 'data engineering', 'sales',
  'startup founding', 'trading', 'accounting', 'civil engineering', 'environmental science', 'graphic design', 'nutrition',
  'esports', 'teaching', 'diplomacy'
];

const MONEY_SUBJECTS = [
  'compound interest', 'options trading', 'index funds', 'ETFs', 'short selling', 'dividend investing', 'a Roth IRA',
  'credit scores', 'inflation', 'the Federal Reserve', 'bond yields', 'startup equity and vesting', 'crypto and blockchain',
  'a 401k', 'mortgages', 'the housing market', 'hedge funds', 'stock buybacks', 'IPOs', 'venture capital returns',
  'the bond market', 'recessions', 'taxes on investments', 'real estate investing', 'dollar-cost averaging', 'market crashes',
  'high-frequency trading', 'private credit', 'commodities', 'currency exchange'
];

const SCIENCE = [
  'How scientists photographed a black hole', 'How mRNA vaccines were developed', 'How CRISPR gene editing works',
  'How the James Webb telescope sees the early universe', 'How nuclear fusion could power the future', 'How quantum computers work',
  'How GPS actually works', 'How the brain forms memories', 'How vaccines train the immune system', 'How SpaceX made rockets reusable',
  'How self-driving cars see the road', 'How the internet actually works', 'How lithium batteries power everything',
  'How weather forecasting got so accurate', 'How DNA ancestry tests work', 'How antibiotics fight infection', 'How solar panels turn light into power',
  'How the human genome was sequenced', 'How airplanes actually stay in the air', 'How encryption keeps data secret',
  'How the LHC discovered the Higgs boson', 'How neural networks learn', 'How the water cycle shapes climate',
  'How anesthesia switches off consciousness', 'How the eye turns light into sight', 'How earthquakes are predicted',
  'How the immune system remembers', 'How 3D printing builds objects layer by layer', 'How black holes bend time',
  'How the periodic table was discovered', 'How photosynthesis feeds the planet', 'How MRI machines see inside the body',
  'How the theory of relativity changed physics', 'How viruses hijack cells', 'How the moon landing was pulled off'
];

const CULTURE_ANGLES = ['How did {x} get famous', 'How did {x} build their empire', 'How did {x} make their money'];
const PEOPLE = [
  'Drake', 'MrBeast', 'Taylor Swift', 'Beyoncé', 'Michael Jordan', 'Elon Musk', 'Steve Jobs', 'Rihanna', 'Kanye West',
  'LeBron James', 'Oprah', 'Jeff Bezos', 'Kim Kardashian', 'Cristiano Ronaldo', 'Travis Scott', 'SZA', 'Bad Bunny',
  'Zendaya', 'Dwayne Johnson', 'Serena Williams', 'Kendrick Lamar', 'Ariana Grande', 'Mark Zuckerberg', 'Rihanna',
  'Post Malone', 'Billie Eilish', 'The Weeknd', 'Lionel Messi', 'Warren Buffett', 'Jay-Z', 'Selena Gomez', 'Tom Brady',
  'Kylie Jenner', 'Ed Sheeran', 'Snoop Dogg', 'Emma Chamberlain', 'Logan Paul', 'Gary Vaynerchuk', 'Alex Hormozi',
  'Naval Ravikant', 'Sam Altman', 'Jensen Huang', 'Bernard Arnault', 'Rihanna', 'Simone Biles'
];

const COMPANIES = [
  'How did NVIDIA become the most valuable company', 'How did Apple become a trillion-dollar company', 'How did Netflix beat Blockbuster',
  'How did TikTok take over the world', 'How did Amazon start in a garage', 'How did Google win search', 'How did Airbnb start',
  'How did Tesla change the car industry', 'How did OpenAI build ChatGPT', 'How did Spotify beat piracy', 'How did Nike build its brand',
  'How did Disney build its empire', 'How did SpaceX undercut the rocket industry', 'How did Uber change transportation',
  'How did Stripe win online payments', 'How did Shopify empower small sellers', 'How did Costco win loyal customers',
  'How did Duolingo make learning addictive', 'How did Robinhood change investing', 'How did Red Bull build a media empire',
  'How did LEGO come back from bankruptcy', 'How did Patagonia build a values-first brand', 'How did Instagram grow so fast',
  'How did Chipotle build a fast-casual empire', 'How did Canva democratize design', 'How did Notion build a cult following',
  'How did Trader Joe’s win grocery', 'How did Rolex hold its value', 'How did Supreme build hype', 'How did Discord win gamers'
];

const COLLEGE = [
  'How to win a full-ride scholarship', 'How I got my doctorate while working part-time', 'What grants I got in Florida as a college student',
  'How to land a Fulbright scholarship', 'How to get into a top MBA program', 'How to get published as an undergraduate researcher',
  'How I paid off my student loans in two years', 'How to get a big-tech internship as a sophomore',
  'How to get into medical school as a non-traditional applicant', 'How to become a research assistant as a freshman',
  'How to get recruited for college sports', 'How to transfer into an Ivy League school', 'How to win a National Merit Scholarship',
  'How to study abroad on a budget', 'How to graduate college debt-free', 'How to ace technical interviews as a student',
  'How to build a standout college application', 'How to land undergraduate research funding', 'How to get a PhD stipend that covers living costs',
  'How to double-major without burning out', 'How to get a first internship with no experience', 'How to network your way into a dream job',
  'How to start a startup while in college', 'How to get a green card through a STEM degree', 'How to get into law school with a low GPA',
  'How to win a hackathon', 'How to get a teaching assistant position', 'How to land a Rhodes Scholarship',
  'How to build a portfolio that gets you hired', 'How to negotiate your first job offer'
];

const PRODUCTS = [
  'a privacy-first study app for students', 'a tool that turns lectures into notes', 'a budgeting app for students on loans',
  'a habit tracker that actually sticks', 'a flashcard app powered by spaced repetition', 'a campus textbook marketplace',
  'a focus timer that blocks distractions', 'a research-paper summarizer', 'a meal-planning app for tight budgets',
  'a scheduling app for group projects', 'an AI tutor for hard classes', 'a job-application tracker', 'a class-notes sharing network',
  'a habit-building app for gym beginners', 'a personal-finance dashboard for Gen Z', 'a dorm-room marketplace app',
  'a resume builder with AI feedback', 'a language-exchange app for students', 'a study-group finder', 'an internship-discovery app',
  'a mental-health check-in app', 'a syllabus-to-calendar tool', 'a citation manager that isn’t painful', 'a campus-events app',
  'a split-the-bill app for roommates', 'a portfolio site builder for creatives', 'a time-blocking planner', 'a reading-tracker for students',
  'a note-taking app that maps ideas', 'a career-path explorer for undecided majors'
];

const CREATIVE = [
  'a documentary about first-gen college students', 'a podcast on how great scientists think', 'a YouTube series explaining big ideas simply',
  'a mystery novel set in a research station', 'a short film about ambition', 'a music album blending genres',
  'a graphic novel about the future of AI', 'a photo essay on a changing neighborhood', 'a video essay channel on culture',
  'an animated explainer series on economics', 'a newsletter that curates the best of the internet', 'a comic about startup life',
  'a docuseries on self-made entrepreneurs', 'a podcast interviewing college dropouts who made it', 'a short-story collection about growing up online',
  'a science-fiction novel about space colonies', 'a TikTok series teaching history', 'an interactive story about hard choices',
  'a coffee-table book on modern architecture', 'a zine about underground music scenes', 'a documentary on the creator economy',
  'a fantasy novel with a magic system based on physics', 'a podcast on the psychology of money', 'a YouTube channel building things from scratch',
  'a video series on how cities work', 'a poetry collection about the digital age', 'a board game about running a startup',
  'a mockumentary about influencers', 'a photo series on late-night study spots', 'a mini-series on the history of hip-hop'
];

// Build a large, deduped flat pool of { premise, category } across all genres.
function buildTopicPool() {
  const out = [];
  const seen = new Set();
  const add = (premise, category) => {
    const key = premise.toLowerCase().trim();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ premise, category });
  };
  VENTURE_ANGLES.forEach(a => VENTURES.forEach(v => add(`${a} ${v}`, 'business')));
  CAREER_ANGLES.forEach(a => CAREER_FIELDS.forEach(f => add(`${a} ${f}`, 'career')));
  MONEY_SUBJECTS.forEach(s => { add(`How ${s} actually works`, 'other'); add(`How to start investing in ${s}`, 'other'); add(`The real risks of ${s}`, 'other'); });
  SCIENCE.forEach(s => add(s, 'other'));
  CULTURE_ANGLES.forEach(a => PEOPLE.forEach(p => add(a.replace('{x}', p), 'other')));
  COMPANIES.forEach(c => add(c, 'other'));
  COLLEGE.forEach(c => add(c, 'career'));
  PRODUCTS.forEach(p => add(`How to build ${p}`, 'product'));
  CREATIVE.forEach(c => add(`How to make ${c}`, 'creative'));
  return out;
}

// Flat pool (built once) — used by both the daily job and the backfill script.
const FLAT_POOL = buildTopicPool();

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

// Pick random topics avoiding duplicates (draws from the large flat pool)
async function pickTopics(count = 5) {
  const topics = [];

  // Try to get some news-based topics first (perpetual freshness)
  const newsTopics = await getNewsTopics(Math.ceil(count / 3));
  topics.push(...newsTopics);

  // Shuffle a copy of the flat pool and take the first `count` not-yet-seen
  const shuffled = [...FLAT_POOL].sort(() => Math.random() - 0.5);
  for (const item of shuffled) {
    if (topics.length >= count) break;
    if (!(await premiseExists(item.premise))) {
      topics.push({ category: item.category, premise: item.premise });
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
      kind: 'core',
      label: savedCoreNode.label || savedCoreNode.title,
      title: savedCoreNode.title,
      statement: savedCoreNode.statement,
      detail: savedCoreNode.detail,
      territory: savedCoreNode.territory,
      x: savedCoreNode.x,
      y: savedCoreNode.y,
      // Identity fields
      coreId: savedCoreNode.coreId,
      path: savedCoreNode.path,
      stableId: savedCoreNode.stableId,
      essence: savedCoreNode.essence,
      derivation: savedCoreNode.derivation,
      liveness: savedCoreNode.liveness,
      terminal: savedCoreNode.terminal,
      scoping: savedCoreNode.scoping
    } : null,
    nodes: savedOtherNodes.map(n => ({
      _id: n._id,
      parentNodeId: n.parentNodeId,
      kind: n.kind || (n.constellation ? 'constellation' : 'star'),
      nodeKind: n.nodeKind,
      label: n.label || n.title,
      title: n.title,
      statement: n.statement,
      detail: n.detail,
      territory: n.territory,
      constellation: n.constellation,
      constellationLabel: n.constellationLabel,
      stage: n.stage,
      scores: n.scores,
      confidence: n.confidence,
      cost: n.cost,
      dependencies: n.dependencies,
      status: n.status,
      sources: n.sources,
      depth: n.depth,
      x: n.x,
      y: n.y,
      // Identity fields
      coreId: n.coreId,
      path: n.path,
      stableId: n.stableId,
      essence: n.essence,
      derivation: n.derivation,
      liveness: n.liveness,
      terminal: n.terminal,
      // Scoping fields
      scoping: n.scoping,
      scoped: n.scoped,
      scopedPaths: n.scopedPaths,
      suggestedSubAspects: n.suggestedSubAspects
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

module.exports = { generateSeedMaps, getClockworkUser, hashPremise, createSeedMap, buildTopicPool, FLAT_POOL };

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
