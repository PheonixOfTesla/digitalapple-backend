require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
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

const app = express();

// Trust proxy for Railway deployment
app.set('trust proxy', true);

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

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', apiLimiter);
app.use('/api/v1/auth/', authLimiter);

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
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
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

app.listen(PORT, () => {
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
