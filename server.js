require('dotenv').config();
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const realtime = require('./services/realtime');
const { connectDB } = require('./config/database');
const { aggregateNews } = require('./jobs/rssAggregator');
const { generateSeedMaps } = require('./jobs/seedMaps');

const AuthController = require('./controllers/AuthController');
const UserController = require('./controllers/UserController');
const FeedController = require('./controllers/FeedController');
const AdminController = require('./controllers/AdminController');
const AnalyticsController = require('./controllers/AnalyticsController');
const NewsController = require('./controllers/NewsController');
const ApplicationController = require('./controllers/ApplicationController');
const BlueprintController = require('./controllers/BlueprintController');
const EngagementController = require('./controllers/EngagementController');
const CommentController = require('./controllers/CommentController');
const ShareController = require('./controllers/ShareController');
const TokenController = require('./controllers/TokenController');
const ReelController = require('./controllers/ReelController');

const app = express();

// Stripe webhook needs raw body - MUST be before express.json()
app.use('/api/v1/tokens/webhook', express.raw({ type: 'application/json' }));

// Trust proxy for Railway deployment
app.set('trust proxy', 1);

// Security headers + NoSQL-injection sanitizing. Guarded so a missing module can
// never block boot. CSP is off (this is a cross-origin API that also serves the
// socket.io client to the Vercel frontend — the frontend sets its own CSP).
try {
  const helmet = require('helmet');
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: false,
    crossOriginEmbedderPolicy: false
  }));
  app.disable('x-powered-by');
  console.log('Security: helmet enabled');
} catch (e) { console.error('Security: helmet unavailable —', e.message); }

// Connect to MongoDB
connectDB();

// CORS Configuration
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:8080',
  'http://127.0.0.1:3000',
  'https://theclockworkhub.com',
  'https://www.theclockworkhub.com',
  process.env.FRONTEND_URL
].filter(Boolean);

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.log('Blocked CORS request from:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-session-id']
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Strip Mongo operators ($, .) from user input — blocks NoSQL injection.
try {
  const mongoSanitize = require('express-mongo-sanitize');
  app.use(mongoSanitize({ replaceWith: '_' }));
  console.log('Security: mongo-sanitize enabled');
} catch (e) { console.error('Security: mongo-sanitize unavailable —', e.message); }

// Rate limiting
// Global API limiter. A content-rich SPA legitimately fires many calls per page
// (feed + stories + discover + notifications poll + …), so this ceiling is high
// and exists only to stop abuse — auth endpoints have their own tighter limiters
// below. Read-only GETs and pure telemetry don't consume the budget.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1200, // per IP per 15 min
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'GET' || req.method === 'OPTIONS' ||
                 (req.originalUrl || '').indexOf('/analytics/track') !== -1,
});

// Separate limiters for signup vs login (don't share budget)
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30, // 30 signups per hour per IP (shared offices/NAT-friendly, still abuse-safe)
  message: { error: 'Too many signup attempts. Please try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // 50 login attempts per 15 min per IP
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 reset requests per hour
  message: { error: 'Too many password reset attempts. Please try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', apiLimiter);
// Apply specific limiters to auth routes (not a blanket limiter)
app.use('/api/v1/auth/register', signupLimiter);
app.use('/api/v1/auth/login', loginLimiter);
app.use('/api/v1/auth/forgot-password', passwordResetLimiter);
app.use('/api/v1/auth/reset-password', passwordResetLimiter);

// Request logging (development)
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    console.log(`${req.method} ${req.path}`, {
      origin: req.headers.origin,
      auth: req.headers.authorization ? 'Present' : 'None'
    });
    next();
  });
}

// Routes
app.use('/api/v1/auth', AuthController);
app.use('/api/v1/user', UserController);
app.use('/api/v1/feed', FeedController);
app.use('/api/v1/admin', AdminController);
app.use('/api/v1/analytics', AnalyticsController);
app.use('/api/v1/news', NewsController);
app.use('/api/v1/applications', ApplicationController);
app.use('/api/v1/blueprint', BlueprintController);
app.use('/api/v1/engage', EngagementController);
app.use('/api/v1/comments', CommentController);
app.use('/api/v1/share', ShareController);
app.use('/api/v1/tokens', TokenController);
app.use('/api/v1/reels', ReelController);
app.use('/api/v1/shop', require('./controllers/ShopController'));
app.use('/api/v1/directory', require('./controllers/DirectoryController'));
app.use('/api/v1/hub', require('./controllers/HubController'));
app.use('/api/v1/messages', require('./controllers/MessageController'));
app.use('/api/v1/studios', require('./controllers/StudioController'));

// ONE-TIME SETUP - REMOVE AFTER USE
app.post('/api/v1/setup-once', async (req, res) => {
  try {
    const bcrypt = require('bcryptjs');
    const User = require('./models/User');

    // Seed admin
    let admin = await User.findOne({ email: 'digitalappleco@gmail.com' });
    if (!admin) {
      admin = new User({
        email: 'digitalappleco@gmail.com',
        passwordHash: await bcrypt.hash('Daf97!FN123', 10),
        role: 'admin',
        emailVerified: true,
        firstName: 'DigitalApple',
        lastName: 'Admin'
      });
      await admin.save();
    }

    // Seed maps
    const { generateSeedMaps } = require('./jobs/seedMaps');
    const result = await generateSeedMaps(5);

    res.json({ success: true, admin: admin.email, maps: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// FORCE SEED - comprehensive showcase maps with depth
app.post('/api/v1/force-seed', async (req, res) => {
  try {
    const crypto = require('crypto');
    const mongoose = require('mongoose');
    const User = require('./models/User');
    const Project = require('./models/Project');
    const Node = require('./models/Node');
    const SharedMap = require('./models/SharedMap');

    // Delete existing seed maps first
    await SharedMap.deleteMany({ isSeed: true });

    // Get or create Clockwork user
    let user = await User.findOne({ email: 'system@clockwork.app' });
    if (!user) {
      user = new User({
        email: 'system@clockwork.app',
        passwordHash: crypto.randomBytes(32).toString('hex'),
        role: 'system',
        emailVerified: true,
        firstName: 'Clockwork',
        lastName: 'Examples'
      });
      await user.save();
    }

    // Comprehensive seed data with domain-specific labels and deep structure
    const seedMaps = [
      {
        category: 'business',
        title: 'Mobile Detailing Service',
        description: 'A mobile car detailing business targeting residential neighborhoods with premium packages.',
        coverage: 72,
        roots: [
          { constellation: 'offer', label: 'The Service', statement: 'What you deliver to customers', stars: [
            { label: 'Interior Detail', statement: 'Deep cleaning of seats, carpets, and surfaces', status: 'kept', children: [
              { label: 'Leather Care', statement: 'Conditioning and protection for leather surfaces', status: 'kept' },
              { label: 'Odor Removal', statement: 'Enzyme treatment for stubborn smells', status: 'unexplored' }
            ]},
            { label: 'Exterior Polish', statement: 'Multi-stage paint correction and ceramic coating', status: 'kept' }
          ]},
          { constellation: 'demand', label: 'Your Clients', statement: 'Who pays and why they need you', stars: [
            { label: 'Busy Professionals', statement: 'No time to visit a car wash, value convenience', status: 'kept', children: [
              { label: 'Recurring Schedule', statement: 'Monthly subscription for hassle-free maintenance', status: 'kept' }
            ]},
            { label: 'Car Enthusiasts', statement: 'Want showroom quality at home', status: 'unexplored' }
          ]},
          { constellation: 'delivery', label: 'How You Reach Them', statement: 'Marketing and customer acquisition', stars: [
            { label: 'Neighborhood Blitz', statement: 'Door hangers when you finish a job nearby', status: 'kept' },
            { label: 'Referral Bonus', statement: '$25 credit for each new customer referred', status: 'kept' }
          ]},
          { constellation: 'economy', label: 'The Numbers', statement: 'Revenue, costs, and margins', stars: [
            { label: 'Package Pricing', statement: '$150 basic, $250 premium, $400 full detail', status: 'kept', children: [
              { label: 'Upsell Path', statement: 'Ceramic coating add-on at $200 margin', status: 'kept' }
            ]},
            { label: 'Supply Costs', statement: '$30-50 in products per full detail', status: 'kept' }
          ]},
          { constellation: 'orchestration', label: 'Operations', statement: 'How the work actually gets done', stars: [
            { label: 'Equipment Setup', statement: 'Van with water tank, generator, and tools', status: 'kept' },
            { label: 'Booking System', statement: 'Square appointments with automated reminders', status: 'unexplored' }
          ]},
          { constellation: 'risk', label: 'What Could Break', statement: 'Threats to the business model', stars: [
            { label: 'Weather Dependency', statement: 'Rain cancels outdoor work', status: 'unexplored' },
            { label: 'Insurance Gap', statement: 'Damage liability while on customer property', status: 'kept' }
          ]}
        ]
      },
      {
        category: 'career',
        title: 'Engineer to PM Pivot',
        description: 'A structured 6-month transition from software engineering to product management.',
        coverage: 58,
        roots: [
          { constellation: 'offer', label: 'Skills to Build', statement: 'What makes you hirable as a PM', stars: [
            { label: 'Product Sense', statement: 'Developing intuition for what users need', status: 'kept', children: [
              { label: 'User Interviews', statement: 'Practice running 10 discovery calls', status: 'kept' },
              { label: 'Competitive Analysis', statement: 'Deep-dive 3 products in target industry', status: 'unexplored' }
            ]},
            { label: 'Stakeholder Communication', statement: 'Translating tech to business outcomes', status: 'kept' }
          ]},
          { constellation: 'demand', label: 'Target Roles', statement: 'Which companies and positions to pursue', stars: [
            { label: 'Technical PM Roles', statement: 'Leverage engineering background as advantage', status: 'kept' },
            { label: 'Growth Stage Startups', statement: 'More flexibility, faster learning curve', status: 'kept' }
          ]},
          { constellation: 'delivery', label: 'How to Get Noticed', statement: 'Building visibility and credibility', stars: [
            { label: 'Side Project', statement: 'Ship something small, write about decisions', status: 'kept', children: [
              { label: 'Product Teardown Blog', statement: 'Weekly analysis of real product decisions', status: 'kept' }
            ]},
            { label: 'Internal Transfer', statement: 'Shadow PM team at current company', status: 'unexplored' }
          ]},
          { constellation: 'economy', label: 'Financial Bridge', statement: 'Managing income during transition', stars: [
            { label: 'Salary Expectations', statement: 'May take 10-20% cut for first PM role', status: 'kept' },
            { label: 'Runway Needed', statement: '3 months expenses for interview period', status: 'kept' }
          ]},
          { constellation: 'orchestration', label: 'The Timeline', statement: 'Week-by-week execution plan', stars: [
            { label: 'Months 1-2', statement: 'Skill building and portfolio creation', status: 'kept' },
            { label: 'Months 3-4', statement: 'Networking and informational interviews', status: 'unexplored' },
            { label: 'Months 5-6', statement: 'Active applications and interview prep', status: 'unexplored' }
          ]},
          { constellation: 'risk', label: 'Blockers', statement: 'What could derail the transition', stars: [
            { label: 'Imposter Syndrome', statement: 'Feeling unqualified without PM title', status: 'kept' },
            { label: 'Golden Handcuffs', statement: 'Hard to leave comfortable engineering salary', status: 'unexplored' }
          ]}
        ]
      },
      {
        category: 'product',
        title: 'Offline Habit Tracker',
        description: 'A privacy-first habit tracking app that works entirely offline with optional encrypted sync.',
        coverage: 45,
        roots: [
          { constellation: 'offer', label: 'Core Features', statement: 'What the app actually does', stars: [
            { label: 'Habit Streaks', statement: 'Visual tracking with break forgiveness', status: 'kept', children: [
              { label: 'Streak Shields', statement: 'Bank 2 skip days per month for emergencies', status: 'kept' }
            ]},
            { label: 'Local-First Storage', statement: 'SQLite database on device, never cloud-required', status: 'kept' }
          ]},
          { constellation: 'demand', label: 'Who Wants This', statement: 'Target users and their motivations', stars: [
            { label: 'Privacy Advocates', statement: 'Tired of apps selling their behavior data', status: 'kept' },
            { label: 'Offline Workers', statement: 'Field work, travel, unreliable connectivity', status: 'unexplored' }
          ]},
          { constellation: 'delivery', label: 'Distribution', statement: 'How people find and download it', stars: [
            { label: 'Privacy Communities', statement: 'Reddit, HN, privacy-focused newsletters', status: 'kept', children: [
              { label: 'Open Source Core', statement: 'Audit-friendly codebase builds trust', status: 'unexplored' }
            ]},
            { label: 'App Store SEO', statement: 'Target "offline habit tracker" keywords', status: 'unexplored' }
          ]},
          { constellation: 'economy', label: 'Revenue Model', statement: 'How the app makes money', stars: [
            { label: 'One-Time Purchase', statement: '$9.99 unlock, no subscriptions ever', status: 'kept' },
            { label: 'Optional Sync Add-on', statement: '$2.99/month for encrypted cross-device sync', status: 'unexplored' }
          ]},
          { constellation: 'orchestration', label: 'Build Plan', statement: 'Technical and launch execution', stars: [
            { label: 'React Native', statement: 'Single codebase for iOS and Android', status: 'kept' },
            { label: 'MVP Scope', statement: '3 habits, streaks, reminders — ship in 6 weeks', status: 'kept' }
          ]},
          { constellation: 'risk', label: 'Failure Modes', statement: 'What could kill the product', stars: [
            { label: 'Feature Creep', statement: 'Adding too much defeats simplicity promise', status: 'kept' },
            { label: 'Platform Lock-out', statement: 'Apple/Google policy changes', status: 'unexplored' }
          ]}
        ]
      },
      {
        category: 'creative',
        title: 'Urban Farming Documentary',
        description: 'A 6-part documentary series profiling pioneers transforming city rooftops into productive farms.',
        coverage: 38,
        roots: [
          { constellation: 'offer', label: 'The Story', statement: 'What makes this compelling to watch', stars: [
            { label: 'Character Arcs', statement: 'Follow 4 farmers across growing season', status: 'kept', children: [
              { label: 'The Rooftop Pioneer', statement: 'Former chef converting Brooklyn rooftops', status: 'kept' },
              { label: 'The Policy Fighter', statement: 'Activist changing zoning laws in Detroit', status: 'kept' }
            ]},
            { label: 'Visual Contrast', statement: 'Lush green against concrete jungle', status: 'kept' }
          ]},
          { constellation: 'demand', label: 'The Audience', statement: 'Who watches and why they care', stars: [
            { label: 'Sustainability Curious', statement: 'Mainstream viewers exploring green living', status: 'kept' },
            { label: 'Urban Planners', statement: 'Professional interest in livable cities', status: 'unexplored' }
          ]},
          { constellation: 'delivery', label: 'Distribution Path', statement: 'How it reaches viewers', stars: [
            { label: 'Streaming Pitch', statement: 'Netflix, Hulu, or Amazon original', status: 'unexplored', children: [
              { label: 'Festival Circuit First', statement: 'Tribeca or SXSW for credibility', status: 'unexplored' }
            ]},
            { label: 'PBS Partnership', statement: 'Educational angle for broadcast', status: 'kept' }
          ]},
          { constellation: 'economy', label: 'The Budget', statement: 'Funding and financial structure', stars: [
            { label: 'Production Costs', statement: '$400K for 6 episodes, lean crew', status: 'kept' },
            { label: 'Grant Funding', statement: 'Environmental foundations, arts councils', status: 'kept' }
          ]},
          { constellation: 'orchestration', label: 'Production Plan', statement: 'How the work gets done', stars: [
            { label: 'Shooting Schedule', statement: 'March-October to capture full season', status: 'kept' },
            { label: 'Crew Size', statement: 'Director, DP, sound, 2 producers', status: 'unexplored' }
          ]},
          { constellation: 'risk', label: 'What Could Fail', statement: 'Production and market risks', stars: [
            { label: 'Subject Burnout', statement: 'Farmers tired of cameras after month 4', status: 'unexplored' },
            { label: 'Market Saturation', statement: 'Too many food/farming docs already', status: 'kept' }
          ]}
        ]
      },
      {
        category: 'business',
        title: 'Specialty Tea Import',
        description: 'Direct-trade tea importing from small Asian farms to specialty cafes and subscription customers.',
        coverage: 65,
        roots: [
          { constellation: 'offer', label: 'The Product', statement: 'What you sell and why it is special', stars: [
            { label: 'Single-Origin Lots', statement: 'Traceable to specific farm and harvest', status: 'kept', children: [
              { label: 'Tasting Notes', statement: 'Detailed flavor profiles like specialty coffee', status: 'kept' }
            ]},
            { label: 'Direct Relationships', statement: 'Skip brokers, pay farmers 40% more', status: 'kept' }
          ]},
          { constellation: 'demand', label: 'Customer Segments', statement: 'Who buys and at what volume', stars: [
            { label: 'Specialty Cafes', statement: 'B2B wholesale for tea-forward menus', status: 'kept', children: [
              { label: 'Staff Training', statement: 'Teach baristas to brew and sell premium tea', status: 'unexplored' }
            ]},
            { label: 'Home Enthusiasts', statement: 'D2C subscriptions and one-time purchases', status: 'kept' }
          ]},
          { constellation: 'delivery', label: 'Go-to-Market', statement: 'How you build the customer base', stars: [
            { label: 'Trade Shows', statement: 'World Tea Expo, specialty coffee events', status: 'kept' },
            { label: 'Content Marketing', statement: 'YouTube brewing guides, origin stories', status: 'unexplored' }
          ]},
          { constellation: 'economy', label: 'Unit Economics', statement: 'Margins and pricing structure', stars: [
            { label: 'Wholesale Margin', statement: '35% on $15-30/100g to cafes', status: 'kept' },
            { label: 'D2C Margin', statement: '60% on $20-45/100g retail', status: 'kept' }
          ]},
          { constellation: 'orchestration', label: 'Supply Chain', statement: 'Sourcing, importing, fulfillment', stars: [
            { label: 'Sourcing Trips', statement: 'Annual visits to Taiwan, Japan, Yunnan', status: 'kept' },
            { label: '3PL Fulfillment', statement: 'ShipBob for D2C, self-ship wholesale', status: 'unexplored' }
          ]},
          { constellation: 'risk', label: 'Vulnerabilities', statement: 'What threatens the business', stars: [
            { label: 'Import Regulations', statement: 'FDA compliance, country-specific rules', status: 'kept' },
            { label: 'Climate Volatility', statement: 'Bad harvest years disrupt supply', status: 'unexplored' }
          ]}
        ]
      }
    ];

    const created = [];
    for (const seed of seedMaps) {
      const project = new Project({ name: seed.title, premise: seed.description, ownerId: user._id });
      await project.save();

      const allNodes = [];
      const allEdges = [];

      // Core node
      const coreId = new mongoose.Types.ObjectId();
      allNodes.push({ _id: coreId, label: 'CORE', statement: seed.description, x: 500, y: 400, depth: 0, kind: 'core' });

      // Generate constellation roots and their children
      const angleStep = (2 * Math.PI) / seed.roots.length;
      seed.roots.forEach((root, i) => {
        const angle = angleStep * i - Math.PI / 2;
        const rootId = new mongoose.Types.ObjectId();
        const rootX = Math.round(500 + 200 * Math.cos(angle));
        const rootY = Math.round(400 + 200 * Math.sin(angle));

        allNodes.push({
          _id: rootId, parentNodeId: coreId, label: root.label, statement: root.statement,
          constellation: root.constellation, constellationLabel: root.label,
          x: rootX, y: rootY, depth: 1, status: 'kept', kind: 'constellation'
        });
        allEdges.push({ _id: new mongoose.Types.ObjectId(), sourceId: coreId, targetId: rootId });

        // Stars under this root - horizontal fan to avoid overlap
        root.stars.forEach((star, j) => {
          const starId = new mongoose.Types.ObjectId();
          // Position stars in a horizontal row above/below the root based on angle
          const hOffset = (j - (root.stars.length - 1) / 2) * 200; // 200px apart horizontally
          const vOffset = 140; // Fixed distance from root
          // Direction based on root's angle
          const isUpper = angle < 0; // upper half of circle
          const starX = Math.round(rootX + hOffset);
          const starY = Math.round(rootY + (isUpper ? -vOffset : vOffset));

          allNodes.push({
            _id: starId, parentNodeId: rootId, label: star.label, statement: star.statement,
            constellation: root.constellation, constellationLabel: root.label,
            x: starX, y: starY, depth: 2, status: star.status || 'unexplored', kind: 'star'
          });
          allEdges.push({ _id: new mongoose.Types.ObjectId(), sourceId: rootId, targetId: starId });

          // Sub-stars (depth 3) - horizontal offset from parent star
          if (star.children) {
            star.children.forEach((child, k) => {
              const childId = new mongoose.Types.ObjectId();
              const childHOffset = (k - (star.children.length - 1) / 2) * 200;
              const childVOffset = isUpper ? -120 : 120;
              allNodes.push({
                _id: childId, parentNodeId: starId, label: child.label, statement: child.statement,
                constellation: root.constellation, constellationLabel: root.label,
                x: Math.round(starX + childHOffset),
                y: Math.round(starY + childVOffset),
                depth: 3, status: child.status || 'unexplored', kind: 'star'
              });
              allEdges.push({ _id: new mongoose.Types.ObjectId(), sourceId: starId, targetId: childId });
            });
          }
        });
      });

      // Save to DB
      for (const n of allNodes) {
        await new Node({ ...n, projectId: project._id, title: n.label }).save();
      }

      // Create SharedMap snapshot
      const coreNode = allNodes.find(n => n.kind === 'core');
      const childNodes = allNodes.filter(n => n.kind !== 'core');

      const sharedMap = new SharedMap({
        projectId: project._id,
        ownerId: user._id,
        title: seed.title,
        description: seed.description,
        category: seed.category,
        visibility: 'public',
        coverage: seed.coverage,
        nodeCount: allNodes.length,
        snapshot: {
          core: { _id: coreNode._id, label: coreNode.label, statement: coreNode.statement, x: coreNode.x, y: coreNode.y },
          nodes: childNodes.map(n => ({
            _id: n._id, parentNodeId: n.parentNodeId, label: n.label, statement: n.statement,
            constellation: n.constellation, constellationLabel: n.constellationLabel,
            status: n.status, depth: n.depth, x: n.x, y: n.y
          })),
          edges: allEdges.map(e => ({ _id: e._id, sourceId: e.sourceId, targetId: e.targetId }))
        },
        publishedAt: new Date(),
        ownerName: 'Clockwork',
        ownerHandle: 'clockwork',
        isSeed: true
      });
      await sharedMap.save();
      created.push(seed.title);
    }

    res.json({ success: true, created, count: created.length });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Root
app.get('/', (req, res) => {
  res.json({
    status: 'alive',
    message: 'DigitalApple API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    endpoints: {
      auth: {
        register: 'POST /api/v1/auth/register',
        login: 'POST /api/v1/auth/login',
        logout: 'POST /api/v1/auth/logout',
        me: 'GET /api/v1/auth/me',
        verifyEmail: 'POST /api/v1/auth/verify-email',
        forgotPassword: 'POST /api/v1/auth/forgot-password',
        resetPassword: 'POST /api/v1/auth/reset-password'
      },
      user: {
        profile: 'GET /api/v1/user/profile',
        updateProfile: 'PUT /api/v1/user/profile',
        uploadPhoto: 'POST /api/v1/user/profile/photo',
        changeEmail: 'POST /api/v1/user/profile/email'
      },
      feed: {
        list: 'GET /api/v1/feed',
        product: 'GET /api/v1/feed/product/:id',
        postReview: 'POST /api/v1/feed/product/:id/review',
        editReview: 'PUT /api/v1/feed/review/:id',
        deleteReview: 'DELETE /api/v1/feed/review/:id'
      },
      news: {
        feed: 'GET /api/v1/news',
        signal: 'GET /api/v1/news/signal/:id',
        categories: 'GET /api/v1/news/categories'
      },
      applications: {
        submit: 'POST /api/v1/applications',
        mine: 'GET /api/v1/applications/mine',
        single: 'GET /api/v1/applications/:id'
      },
      blueprint: {
        projects: 'GET /api/v1/blueprint/projects',
        createProject: 'POST /api/v1/blueprint/projects',
        getProject: 'GET /api/v1/blueprint/projects/:id',
        updateProject: 'PUT /api/v1/blueprint/projects/:id',
        deleteProject: 'DELETE /api/v1/blueprint/projects/:id',
        claimProject: 'POST /api/v1/blueprint/projects/:id/claim',
        createNode: 'POST /api/v1/blueprint/projects/:projectId/nodes',
        updateNode: 'PUT /api/v1/blueprint/nodes/:id',
        deleteNode: 'DELETE /api/v1/blueprint/nodes/:id',
        createEdge: 'POST /api/v1/blueprint/projects/:projectId/edges',
        deleteEdge: 'DELETE /api/v1/blueprint/edges/:id',
        chat: 'POST /api/v1/blueprint/projects/:projectId/chat',
        chatHistory: 'GET /api/v1/blueprint/projects/:projectId/chat',
        quota: 'GET /api/v1/blueprint/quota'
      },
      sharedMaps: {
        publicFeed: 'GET /api/v1/feed/maps/public',
        followingFeed: 'GET /api/v1/feed/maps/following',
        singleMap: 'GET /api/v1/feed/maps/:mapId',
        userMaps: 'GET /api/v1/feed/maps/user/:userId'
      },
      engage: {
        star: 'POST /api/v1/engage/star/:mapId',
        repost: 'POST /api/v1/engage/repost/:mapId',
        fork: 'POST /api/v1/engage/fork/:mapId',
        follow: 'POST /api/v1/engage/follow/:userId',
        following: 'GET /api/v1/engage/following',
        followers: 'GET /api/v1/engage/followers'
      },
      comments: {
        list: 'GET /api/v1/comments/:mapId',
        create: 'POST /api/v1/comments/:mapId',
        edit: 'PUT /api/v1/comments/:commentId',
        delete: 'DELETE /api/v1/comments/:commentId',
        hide: 'POST /api/v1/comments/:commentId/hide'
      },
      share: {
        publish: 'POST /api/v1/share/publish/:projectId',
        unpublish: 'POST /api/v1/share/unpublish/:mapId',
        update: 'PUT /api/v1/share/:mapId',
        myMaps: 'GET /api/v1/share/my-maps',
        branches: 'GET /api/v1/share/branches/:projectId'
      },
      admin: 'All admin endpoints require admin role'
    }
  });
});

// Health check
app.get('/health', (req, res) => {
  const mongoose = require('mongoose');
  const { isCloudinaryConfigured } = require('./config/cloudinary');
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    cloudinary: isCloudinaryConfigured,
    google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    ai: !!(process.env.OPENAI_API_KEY || process.env.MOONSHOT_API_KEY),
    environment: process.env.NODE_ENV || 'production'
  });
});

// 404 handler
app.use((req, res, next) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.path}`
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err.message);

  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({
      error: 'CORS Error',
      message: 'Origin not allowed'
    });
  }

  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Validation Error',
      message: err.message
    });
  }

  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      error: 'Authentication Error',
      message: 'Invalid token'
    });
  }

  if (err.message && err.message.includes('Invalid file type')) {
    return res.status(400).json({
      error: 'Upload Error',
      message: err.message
    });
  }

  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error'
  });
});

// Start server
const PORT = process.env.PORT || 3000;

// ==================== REAL-TIME (Socket.IO) ====================
// Wrap the Express app in an HTTP server so Socket.IO can share the port.
const server = http.createServer(app);

// Socket.IO is a progressive enhancement (live admin dashboard). It must NEVER
// be able to crash the API on boot — if the module is missing or init throws,
// the server still starts and everything else keeps working; the admin just
// falls back to polling. This also prevents a socket issue from blocking deploys.
try {
  const { Server } = require('socket.io');
  const io = new Server(server, {
    cors: {
      origin: allowedOrigins,
      credentials: true,
      methods: ['GET', 'POST']
    },
    // Long-polling fallback for hosts/proxies that don't allow raw WS upgrades.
    transports: ['websocket', 'polling']
  });

  // Admin dashboard channel — gated to admins only. Analytics can include
  // premises and emails, so a valid admin JWT is required to join.
  const adminNs = io.of('/admin');
  adminNs.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token ||
                    (socket.handshake.headers?.authorization || '').replace(/^Bearer\s+/i, '');
      if (!token) return next(new Error('unauthorized'));
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded.role !== 'admin') return next(new Error('forbidden'));
      socket.userEmail = decoded.email;
      next();
    } catch (e) {
      next(new Error('unauthorized'));
    }
  });
  adminNs.on('connection', (socket) => {
    socket.emit('ready', { ok: true });
  });

  // Hub channel — every signed-in member joins a personal `user:<id>` room so
  // controllers can live-push events to just them (new messages, bell
  // notifications) via realtime.userEmit(). Nothing sensitive is broadcast:
  // events only ever go to the one user they belong to.
  const hubNs = io.of('/hub');
  hubNs.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token ||
                    (socket.handshake.headers?.authorization || '').replace(/^Bearer\s+/i, '');
      if (!token) return next(new Error('unauthorized'));
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.userId || decoded.id || decoded._id;
      if (!socket.userId) return next(new Error('unauthorized'));
      next();
    } catch (e) { next(new Error('unauthorized')); }
  });
  hubNs.on('connection', (socket) => {
    socket.join('user:' + String(socket.userId));
    socket.emit('ready', { ok: true });
  });

  // Studios channel — live connect rooms. Any authenticated member can connect;
  // this namespace only relays presence, WebRTC signaling, live chat, and the
  // "blueprint attached" event between peers in the same studio room. Media never
  // touches the server (peer-to-peer, DTLS-SRTP encrypted).
  const studioNs = io.of('/studio');
  // Per-room sharing policy: 'host' (default — host + granted people only) or
  // 'open' (everyone, guests included). Lives with the live room, host-set.
  const sharePolicy = new Map();
  // Policy is PER STAGE SCREEN: {1:'host'|'open', 2:'host'|'open'}. A plain
  // string (pre-slot deploys) reads as both screens set the same way.
  const policyOf = (room) => {
    const p = sharePolicy.get(room);
    if (!p) return { 1: 'host', 2: 'host' };
    if (typeof p === 'string') return { 1: p, 2: p };
    return { 1: p[1] === 'open' ? 'open' : 'host', 2: p[2] === 'open' ? 'open' : 'host' };
  };
  const slotOpen = (room, slot) => policyOf(room)[slot === 2 ? 2 : 1] === 'open';
  studioNs.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token ||
                    (socket.handshake.headers?.authorization || '').replace(/^Bearer\s+/i, '');
      if (!token) return next(new Error('unauthorized'));
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded.guest === true) {
        // Guest pass: name-only entry, valid for ONE public studio.
        socket.isGuest = true;
        socket.guestStudioId = String(decoded.studioId || '');
        socket.userId = null;
        socket.userName = (String(decoded.name || 'Guest').slice(0, 60)) + ' (guest)';
        if (!socket.guestStudioId) return next(new Error('unauthorized'));
      } else {
        socket.userId = decoded.userId || decoded.id || decoded._id;
        socket.userName = decoded.name || decoded.email || 'Member';
      }
      next();
    } catch (e) { next(new Error('unauthorized')); }
  });
  studioNs.on('connection', (socket) => {
    let joined = null;

    socket.on('join', (payload) => {
      const studioId = payload && payload.studioId;
      const name = (payload && payload.name) || socket.userName;
      if (!studioId) return;
      if (socket.isGuest && String(studioId) !== socket.guestStudioId) return; // pass is scoped
      joined = String(studioId);
      socket.studioName = String(name).slice(0, 80);
      socket.join(joined);
      // Screen share is permission-based, checked HERE not in the client:
      // the host always; members only with a share-granting role. Rights are
      // read once on join; role-set events update them live.
      socket.isHost = false; socket.canShare = false;
      if (!socket.isGuest && socket.userId) {
        const Conversation = require('./models/Conversation');
        Conversation.findOne({ _id: joined, closedAt: null }).select('ownerId memberRoles').lean().then((c) => {
          if (!c) return;
          const host = c.ownerId && String(c.ownerId) === String(socket.userId);
          let role = '';
          (c.memberRoles || []).forEach((r) => { if (String(r.userId) === String(socket.userId)) role = r.role || ''; });
          socket.isHost = !!host;
          socket.canShare = !!host || /host|speaker|presenter/i.test(role);
          // Rights may have resolved after the first presence — ask for a fresh one.
          socket.emit('presence-sync');
        }).catch(() => {});
      }
      // Tell the newcomer who's already here.
      const peers = [];
      const room = studioNs.adapter.rooms.get(joined);
      if (room) room.forEach((sid) => {
        if (sid === socket.id) return;
        const s = studioNs.sockets.get(sid);
        if (s) peers.push({ socketId: sid, userId: s.userId, name: s.studioName || s.userName });
      });
      socket.emit('peers', { peers });
      // Newcomers learn the room's sharing policy right away.
      const np = policyOf(joined);
      socket.emit('share-policy', { policy: np, open: np[1] === 'open' || np[2] === 'open' });
      // Announce this peer to everyone else.
      socket.to(joined).emit('peer-joined', { socketId: socket.id, userId: socket.userId, name: socket.studioName });
    });

    // Generic WebRTC signaling passthrough (offer / answer / ICE) to one peer.
    socket.on('signal', (payload) => {
      if (!payload || !payload.to) return;
      studioNs.to(payload.to).emit('signal', { from: socket.id, userId: socket.userId, data: payload.data });
    });

    // Ephemeral live chat within the room (persistent chat uses the REST API).
    // Members who AREN'T in the room right now get a bell notification.
    socket.on('chat', (payload) => {
      if (!joined || !payload || (!payload.body && !payload.attachment)) return;
      const chatBody = String(payload.body || '').slice(0, 1000);
      // Attachment rides along verbatim IF it's our Cloudinary asset — the REST
      // send path is what persists it; this is just the live relay.
      let att = null;
      const a = payload.attachment;
      if (a && typeof a === 'object' && /^https:\/\/res\.cloudinary\.com\//.test(String(a.url || '')) && ['image', 'gif', 'pdf', 'doc'].includes(a.type)) {
        att = { url: String(a.url).slice(0, 500), type: a.type, name: String(a.name || '').slice(0, 160) };
      }
      if (!chatBody && !att) return;
      studioNs.to(joined).emit('chat', {
        from: socket.id, userId: socket.userId, name: socket.studioName,
        body: chatBody, attachment: att
      });
      notifyStudioChat(joined, socket, chatBody || (att ? (att.type === 'pdf' ? 'Sent a PDF' : att.type === 'gif' ? 'Sent a GIF' : 'Sent a photo') : ''));
    });

    // Presence flags (mic / camera / screen). camId & screenId are the sender's
    // MediaStream ids so receivers can route camera video to the person's tile
    // and screen video to the stage.
    socket.on('presence', (payload) => {
      if (!joined || !payload) return;
      // Screen claims from sockets without share rights are stripped server-side
      // — PER SLOT: the host can open Screen 1, Screen 2, both, or neither.
      const ok1 = !!socket.canShare || slotOpen(joined, payload.screenSlot === 2 ? 2 : 1);
      const ok2 = !!socket.canShare || slotOpen(joined, payload.screen2Slot === 2 ? 2 : 1);
      const screenOk = !!payload.screen && (ok1 || ok2);
      socket.to(joined).emit('presence', {
        socketId: socket.id, userId: socket.userId,
        mic: !!payload.mic, screen: screenOk, cam: !!payload.cam,
        camId: payload.camId ? String(payload.camId).slice(0, 80) : null,
        screenId: ok1 && payload.screenId ? String(payload.screenId).slice(0, 80) : null,
        // Which stage slot the share targets — the stage has two screens, and
        // one person may drive both (screen on one, a browser tab on the other).
        screenSlot: payload.screenSlot === 2 ? 2 : 1,
        screen2Id: ok2 && payload.screen2Id ? String(payload.screen2Id).slice(0, 80) : null,
        screen2Slot: payload.screen2Slot === 2 ? 2 : 1
      });
    });

    // Anyone without share rights — members AND guests — asks the host for
    // the floor. Guests are flagged so the host grants per-socket, not per-role.
    socket.on('share-req', () => {
      if (!joined) return;
      studioNs.to(joined).emit('share-req', { socketId: socket.id, userId: socket.userId, name: socket.studioName || socket.userName, guest: !!socket.isGuest });
    });

    // Host flips a STAGE SCREEN's sharing policy: host-managed or open to
    // everyone. No slot in the payload = both screens (older clients).
    socket.on('share-policy', (payload) => {
      if (!joined || !socket.isHost || !payload) return;
      const mode = (payload.open === true || payload.mode === 'open') ? 'open' : 'host';
      const cur = policyOf(joined);
      const slot = payload.slot === 2 ? 2 : payload.slot === 1 ? 1 : null;
      if (slot) cur[slot] = mode; else { cur[1] = mode; cur[2] = mode; }
      sharePolicy.set(joined, cur);
      studioNs.to(joined).emit('share-policy', { policy: cur, open: cur[1] === 'open' || cur[2] === 'open', by: socket.studioName || 'The host' });
    });

    // Host grants (or revokes) share rights for one SOCKET — the only way a
    // guest gets the floor, and it dies with their connection.
    socket.on('grant-share', (payload) => {
      if (!joined || !socket.isHost || !payload || !payload.socketId) return;
      const s = studioNs.sockets.get(String(payload.socketId));
      if (!s) return;
      const room = studioNs.adapter.rooms.get(joined);
      if (!room || !room.has(s.id)) return;   // only people in THIS room
      s.canShare = payload.allow === true ? true : (s.isHost || false);
      studioNs.to(s.id).emit('share-granted', { allow: !!s.canShare, by: socket.studioName || 'The host' });
    });

    // An image placed on a stage screen — share-rights gated like screen
    // share. Images only for now (PDF/Word live in chat + Resources until a
    // proper page renderer exists). doc:null clears the slot.
    socket.on('doc-slot', (payload) => {
      if (!joined || !payload) return;
      const slot = payload.slot === 2 ? 2 : 1;
      if (!(socket.canShare || slotOpen(joined, slot))) return;
      let doc = null;
      const d = payload.doc;
      if (d && typeof d === 'object' && /^https:\/\/res\.cloudinary\.com\//.test(String(d.url || '')) && ['image', 'gif'].includes(d.type)) {
        doc = { url: String(d.url).slice(0, 500), type: d.type, name: String(d.name || '').slice(0, 160) };
      }
      studioNs.to(joined).emit('doc-slot', { slot, doc, by: socket.studioName || 'Someone', from: socket.id });
    });

    // Host mutes a member (Zoom-style: they can unmute themselves). Host-only,
    // checked against the rights resolved at join — not a client claim.
    socket.on('force-mute', (payload) => {
      if (!joined || !socket.isHost || !payload || !payload.socketId) return;
      studioNs.to(String(payload.socketId)).emit('force-muted', { by: socket.studioName || 'The host' });
    });

    // Host turns a member's camera off (they can turn it back on) — host-only,
    // same contract as force-mute.
    socket.on('force-cam-off', (payload) => {
      if (!joined || !socket.isHost || !payload || !payload.socketId) return;
      studioNs.to(String(payload.socketId)).emit('force-cam-off', { by: socket.studioName || 'The host' });
    });

    // Host announces a role change — every client updates, and the affected
    // member's live share rights flip without a rejoin.
    socket.on('role-set', (payload) => {
      if (!joined || !socket.isHost || !payload || !payload.userId) return;
      const uid = String(payload.userId).slice(0, 40), role = String(payload.role || '').slice(0, 24);
      const room = studioNs.adapter.rooms.get(joined);
      if (room) room.forEach((sid) => {
        const s = studioNs.sockets.get(sid);
        if (s && String(s.userId) === uid) s.canShare = s.isHost || /host|speaker|presenter/i.test(role);
      });
      studioNs.to(joined).emit('role-set', { userId: uid, role });
    });

    // Who's looking at whose node — relays "I expanded X's node" so every node
    // can show its viewer count. target = a socketId, or null when collapsed.
    socket.on('viewing', (payload) => {
      if (!joined) return;
      socket.to(joined).emit('viewing', {
        socketId: socket.id,
        target: payload && payload.target ? String(payload.target).slice(0, 64) : null
      });
    });

    // "<name> is typing…" in the room chat — pure relay, nothing persisted.
    socket.on('typing', (payload) => {
      if (!joined) return;
      socket.to(joined).emit('typing', {
        socketId: socket.id,
        name: payload && payload.name ? String(payload.name).slice(0, 60) : 'Someone',
        on: !!(payload && payload.on)
      });
    });

    // Host attached / opened a blueprint — everyone refreshes the canvas panel.
    socket.on('blueprint', (payload) => {
      if (!joined || !payload) return;
      studioNs.to(joined).emit('blueprint', { projectId: payload.projectId, name: payload.name || '' });
    });

    socket.on('disconnect', () => {
      if (joined) {
        socket.to(joined).emit('peer-left', { socketId: socket.id, userId: socket.userId });
        // Last one out: the room's live policy goes with them.
        if (!studioNs.adapter.rooms.get(joined)) sharePolicy.delete(joined);
      }
    });
  });

  // A studio message notifies members who aren't in the room right now —
  // deduped to one unread notification per studio until they read it, exactly
  // like thread messages. Fire-and-forget: never blocks the socket path.
  async function notifyStudioChat(studioId, socket, chatBody) {
    try {
      const Conversation = require('./models/Conversation');
      const Notification = require('./models/Notification');
      const convo = await Conversation.findOne({ _id: studioId, closedAt: null })
        .select('participants name').lean();
      if (!convo) return;
      const present = new Set();
      const room = studioNs.adapter.rooms.get(String(studioId));
      if (room) room.forEach((sid) => {
        const s = studioNs.sockets.get(sid);
        if (s && s.userId) present.add(String(s.userId));
      });
      const from = String(socket.studioName || socket.userName || 'Member').slice(0, 80);
      const link = 'studio.html?id=' + String(studioId);
      const text = from + ' in ' + (convo.name || 'Studio') + ': ' + chatBody.slice(0, 70);
      for (const uid of (convo.participants || []).map(String)) {
        if (uid === String(socket.userId) || present.has(uid)) continue;
        const already = await Notification.findOne({ userId: uid, type: 'message', read: false, link }).select('_id').lean();
        if (already) await Notification.updateOne({ _id: already._id }, { $set: { text, actorName: from, createdAt: new Date() } });
        else await Notification.push({ userId: uid, channel: 'personal', type: 'message', actorName: from, text, link });
        realtime.userEmit(uid, 'notify', { type: 'message', text, link });
      }
    } catch (e) { /* non-fatal — chat itself already went through */ }
  }

  // Hand the io instance to the realtime service for controllers to use.
  realtime.setIO(io);
  console.log('Socket.IO: enabled (/admin, /studio namespaces)');
} catch (e) {
  console.error('Socket.IO disabled — continuing without live features:', e.message);
}

server.listen(PORT, () => {
  console.log('');
  console.log('='.repeat(50));
  console.log('DigitalApple API Started');
  console.log('='.repeat(50));
  console.log('');
  console.log(`Server:      http://localhost:${PORT}`);
  console.log(`Health:      http://localhost:${PORT}/health`);
  console.log(`Environment: ${process.env.NODE_ENV || 'production'}`);
  console.log('');
  console.log('CORS Origins:', allowedOrigins);
  console.log('');

  // Schedule RSS aggregation - every hour at minute 0
  cron.schedule('0 * * * *', async () => {
    console.log('[CRON] Running RSS aggregation...');
    try {
      await aggregateNews();
    } catch (error) {
      console.error('[CRON] RSS aggregation failed:', error.message);
    }
  });
  console.log('RSS Aggregation: Scheduled (hourly)');

  // Schedule Wikipedia-sourced signal generation - 2x daily (spans genres reliably)
  cron.schedule('0 9,21 * * *', async () => {
    console.log('[CRON] Generating Wikipedia signals...');
    try {
      const { generateSignals } = require('./jobs/signalGenerator');
      await generateSignals({ limit: 24 });
    } catch (error) {
      console.error('[CRON] Signal generation failed:', error.message);
    }
  });
  console.log('Signal Generation: Scheduled (9am, 9pm UTC)');

  // Weekly company aggregation — refresh the directory from Wikidata (Mon 04:00 UTC)
  cron.schedule('0 4 * * 1', async () => {
    console.log('[CRON] Aggregating companies into the directory...');
    try {
      const { aggregateCompanies } = require('./jobs/aggregateCompanies');
      await aggregateCompanies({});
    } catch (error) {
      console.error('[CRON] Company aggregation failed:', error.message);
    }
  });
  console.log('Company Aggregation: Scheduled (Mondays 04:00 UTC)');

  // System health watch — every 5 min. Notify admins only on a transition INTO
  // 'down' (not every cycle), so the admin bell flags real outages without spam.
  const _healthLast = {};
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { runHealthChecks } = require('./services/healthChecks');
      const Notification = require('./models/Notification');
      const { checks } = await runHealthChecks();
      for (const [name, c] of Object.entries(checks)) {
        const was = _healthLast[name];
        if (c.status === 'down' && was !== 'down') {
          await Notification.pushAdmins({
            type: 'system', text: `${name} is DOWN — ${c.detail || 'check failed'}`, link: 'admin.html#status'
          });
          console.error(`[HEALTH] ${name} DOWN: ${c.detail}`);
        } else if (c.status === 'up' && was === 'down') {
          await Notification.pushAdmins({ type: 'system', text: `${name} recovered — back up`, link: 'admin.html#status' });
          console.log(`[HEALTH] ${name} recovered`);
        }
        _healthLast[name] = c.status;
      }
    } catch (e) { console.error('[HEALTH] check failed:', e.message); }
  });
  console.log('System Health Watch: Scheduled (every 5 min)');

  // One-time populate: if the directory has never been aggregated, do it now
  // (in the background) so it isn't empty. Idempotent — skips once seeded.
  setTimeout(async () => {
    try {
      const Company = require('./models/Company');
      const have = await Company.countDocuments({ source: 'wikidata' });
      if (have === 0) {
        console.log('[BOOT] Directory has no aggregated companies — running first aggregation...');
        const { aggregateCompanies } = require('./jobs/aggregateCompanies');
        await aggregateCompanies({});
      }
    } catch (e) { console.error('[BOOT] Initial company aggregation skipped:', e.message); }
  }, 8000);

  // Schedule seed map generation - 3x daily at 8am, 2pm, 8pm UTC
  cron.schedule('0 8,14,20 * * *', async () => {
    console.log('[CRON] Running seed map generation...');
    try {
      await generateSeedMaps(5);
    } catch (error) {
      console.error('[CRON] Seed map generation failed:', error.message);
    }
  });
  console.log('Seed Maps: Scheduled (8am, 2pm, 8pm UTC)');

  // Run initial aggregation after 30 seconds on startup
  setTimeout(async () => {
    console.log('[STARTUP] Running initial RSS aggregation...');
    try {
      await aggregateNews();
    } catch (error) {
      console.error('[STARTUP] Initial RSS aggregation failed:', error.message);
    }
  }, 30000);

  console.log('');
  console.log('='.repeat(50));
  console.log('');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  process.exit(0);
});
