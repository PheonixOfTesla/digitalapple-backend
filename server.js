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

// FORCE SEED - bypasses deduplication
app.post('/api/v1/force-seed', async (req, res) => {
  try {
    const crypto = require('crypto');
    const User = require('./models/User');
    const Project = require('./models/Project');
    const Node = require('./models/Node');
    const SharedMap = require('./models/SharedMap');

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

    const topics = [
      { category: 'business', premise: 'A boutique coffee roastery with direct-to-consumer subscriptions' },
      { category: 'career', premise: 'Transition from software engineering to product management in 6 months' },
      { category: 'product', premise: 'A privacy-first habit tracking app that works offline' },
      { category: 'creative', premise: 'A documentary series exploring urban farming pioneers' },
      { category: 'business', premise: 'A mobile car detailing service targeting residential neighborhoods' }
    ];

    const created = [];
    for (const topic of topics) {
      const project = new Project({
        name: topic.premise.substring(0, 100),
        premise: topic.premise,
        ownerId: user._id
      });
      await project.save();

      // Create core node
      const coreId = new require('mongoose').Types.ObjectId();
      await new Node({
        _id: coreId,
        projectId: project._id,
        kind: 'core',
        title: 'CORE',
        statement: topic.premise,
        x: 600, y: 400, depth: 0
      }).save();

      // Create constellation nodes
      const constellations = ['offer', 'demand', 'delivery', 'economy'];
      const nodeIds = [coreId];
      for (let i = 0; i < constellations.length; i++) {
        const angle = (2 * Math.PI * i / constellations.length) - Math.PI/2;
        const nodeId = new require('mongoose').Types.ObjectId();
        nodeIds.push(nodeId);
        await new Node({
          _id: nodeId,
          projectId: project._id,
          parentNodeId: coreId,
          kind: 'constellation',
          constellation: constellations[i],
          title: constellations[i].charAt(0).toUpperCase() + constellations[i].slice(1),
          statement: `${constellations[i]} dimension`,
          status: Math.random() > 0.4 ? 'kept' : 'unexplored',
          x: Math.round(600 + 180 * Math.cos(angle)),
          y: Math.round(400 + 180 * Math.sin(angle)),
          depth: 1
        }).save();
      }

      // Create SharedMap
      const nodes = await Node.find({ projectId: project._id }).lean();
      const coreNode = nodes.find(n => n.kind === 'core');
      const otherNodes = nodes.filter(n => n.kind !== 'core');

      const sharedMap = new SharedMap({
        projectId: project._id,
        ownerId: user._id,
        title: topic.premise.substring(0, 100),
        description: topic.premise,
        category: topic.category,
        visibility: 'public',
        coverage: Math.floor(Math.random() * 40) + 30,
        nodeCount: nodes.length,
        snapshot: {
          core: { _id: coreNode._id, label: coreNode.title, statement: coreNode.statement, x: coreNode.x, y: coreNode.y },
          nodes: otherNodes.map(n => ({ _id: n._id, parentNodeId: n.parentNodeId, label: n.title, statement: n.statement, constellation: n.constellation, status: n.status, depth: n.depth, x: n.x, y: n.y })),
          edges: otherNodes.map(n => ({ _id: new require('mongoose').Types.ObjectId(), sourceId: coreNode._id, targetId: n._id }))
        },
        publishedAt: new Date(),
        ownerName: 'Clockwork',
        ownerHandle: 'clockwork',
        isSeed: true
      });
      await sharedMap.save();
      created.push(topic.premise.substring(0, 50));
    }

    res.json({ success: true, created });
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
