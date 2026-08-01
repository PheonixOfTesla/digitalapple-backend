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
app.use('/api/v1/drive', require('./controllers/DriveController'));
// Ticketing. Mounted twice on purpose: /events for the host and browse
// routes, and /api/v1 as well so the ticket recovery URL is a short
// /tickets/:code — that link goes on posters and into inboxes.
app.use('/api/v1/events', require('./controllers/EventController'));
app.use('/api/v1', require('./controllers/EventController'));
app.use('/api/v1/directory', require('./controllers/DirectoryController'));
app.use('/api/v1/hub', require('./controllers/HubController'));
app.use('/api/v1/messages', require('./controllers/MessageController'));
app.use('/api/v1/studios', require('./controllers/StudioController'));

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

    // Typing relay for message threads. Membership is checked once per thread
    // per socket (cached 60s) so a keystroke stream costs one DB read, not many.
    socket.on('thread-typing', async (p) => {
      try {
        const cid = String((p && p.conversationId) || '');
        if (!/^[a-f0-9]{24}$/i.test(cid)) return;
        socket._typeOk = socket._typeOk || {};
        let entry = socket._typeOk[cid];
        if (!entry || entry.exp < Date.now()) {
          const Conversation = require('./models/Conversation');
          const c = await Conversation.findOne({ _id: cid, participants: socket.userId })
            .select('participants').lean();
          if (!c) return;
          entry = {
            others: (c.participants || []).map(String).filter(id => id !== String(socket.userId)),
            exp: Date.now() + 60000
          };
          socket._typeOk[cid] = entry;
        }
        if (!socket._typeName) {
          const User = require('./models/User');
          const u = await User.findById(socket.userId).select('firstName lastName email').lean();
          const nm = u ? [u.firstName, u.lastName].filter(Boolean).join(' ').trim() : '';
          socket._typeName = (nm || (u && u.email ? u.email.split('@')[0] : 'Someone')).slice(0, 80);
        }
        for (const uid of entry.others) {
          hubNs.to('user:' + uid).emit('typing', { conversationId: cid, name: socket._typeName });
        }
      } catch (e) { /* relay is best-effort */ }
    });
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
  // The host's stage layout (auto / single / split) — pushed to the room so
  // everyone sees the same stage, held for late joiners.
  const stageLayout = new Map();
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
      // Newcomers learn the room's sharing policy and stage layout right away.
      const np = policyOf(joined);
      socket.emit('share-policy', { policy: np, open: np[1] === 'open' || np[2] === 'open' });
      if (stageLayout.get(joined)) socket.emit('stage-layout', { layout: stageLayout.get(joined) });
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

    // Host kicks someone — they're told, then thrown out server-side (a client
    // that ignores the message is out of the room regardless).
    socket.on('kick', (payload) => {
      if (!joined || !socket.isHost || !payload || !payload.socketId) return;
      const s = studioNs.sockets.get(String(payload.socketId));
      if (!s || s.id === socket.id) return;
      const room = studioNs.adapter.rooms.get(joined);
      if (!room || !room.has(s.id)) return;
      studioNs.to(s.id).emit('kicked', { by: socket.studioName || 'The host' });
      try { s.leave(joined); } catch (e) {}
      socket.to(joined).emit('peer-left', { socketId: s.id, userId: s.userId });
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

    // Host sets the stage layout — the whole room follows it live.
    socket.on('stage-layout', (payload) => {
      if (!joined || !socket.isHost || !payload) return;
      const layout = ['auto', 'single', 'split'].includes(payload.layout) ? payload.layout : 'auto';
      stageLayout.set(joined, layout);
      socket.to(joined).emit('stage-layout', { layout, by: socket.studioName || 'The host' });
    });

    // Host attached / opened a blueprint — everyone refreshes the canvas panel.
    socket.on('blueprint', (payload) => {
      if (!joined || !payload) return;
      studioNs.to(joined).emit('blueprint', { projectId: payload.projectId, name: payload.name || '' });
    });

    socket.on('disconnect', () => {
      if (joined) {
        socket.to(joined).emit('peer-left', { socketId: socket.id, userId: socket.userId });
        // Last one out: the room's live policy and layout go with them.
        if (!studioNs.adapter.rooms.get(joined)) { sharePolicy.delete(joined); stageLayout.delete(joined); }
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

  // Atlas search corpus: top the public Atlas up to ATLAS_SEED_TARGET maps
  // (default 3000) in fast no-LLM mode so Maps search behaves like a real
  // engine. Idempotent — backfillTo counts the Atlas first and no-ops once
  // it's at target, so restarts and redeploys just top it up.
  const atlasTarget = Math.min(6000, parseInt(process.env.ATLAS_SEED_TARGET || '4000', 10) || 0);
  if (atlasTarget > 0) {
    setTimeout(() => {
      const { backfillTo } = require('./jobs/seedMaps');
      backfillTo(atlasTarget, {
        fast: true, concurrency: 4,
        onProgress: (p) => { if ((p.created + p.failed) % 250 === 0) console.log(`[atlas-seed] ${p.created}/${p.need} (${p.failed} failed)`); }
      })
        .then(r => { if (r.created || r.failed) console.log('[atlas-seed] done:', JSON.stringify(r)); })
        .catch(e => console.error('[atlas-seed]', e.message));
    }, 20000);
  }

  // Deepen shallow seeds: upgrade 2-layer fast seeds to complete five-layer
  // atlases (action terminals, coverage ~100). Idempotent — deepened maps
  // stop matching. Runs after the backfill window.
  setTimeout(() => {
    require('./jobs/deepenSeeds').deepenSeeds({
      onProgress: (p) => console.log(`[deepen] ${p.done} deepened, ${p.failed} failed`)
    })
      .then(r => { if (r.done || r.failed) console.log('[deepen] done:', JSON.stringify(r)); })
      .catch(e => console.error('[deepen]', e.message));
  }, 90000);

  // Editorial takes for the best-known directory companies — idempotent,
  // only fills empty editorials. See jobs/editorialTakes.js for the rules
  // (attributed house voice, never counted as a review).
  setTimeout(() => {
    require('./jobs/editorialTakes').applyEditorialTakes()
      .then(r => { if (r.applied) console.log('[editorial] applied', r.applied, 'takes'); })
      .catch(e => console.error('[editorial]', e.message));
  }, 30000);

  // RSS aggregation — every 10 min. The feed rotates visibly all day: a
  // headline that arrived at 9:00 is off the top of the rail by 9:30.
  cron.schedule('*/10 * * * *', async () => {
    console.log('[CRON] Running RSS aggregation...');
    try {
      await aggregateNews();
    } catch (error) {
      console.error('[CRON] RSS aggregation failed:', error.message);
    }
  });
  console.log('RSS Aggregation: Scheduled (every 10 min)');

  // Self-heal on boot + tight backstop. node-cron only fires while the process
  // is alive, so a Railway restart at (say) 14:12 leaves the feed frozen until
  // 14:20. On startup (and every 10 min as a backstop) we check the newest
  // item and refresh whatever has gone stale — the feed is never more than
  // ~30 min behind regardless of when the container last came up.
  const NewsItem = require('./models/NewsItem');
  const RSS_STALE_MS = 30 * 60 * 1000;    // headlines: refresh if >30 min old
  const SIGNAL_STALE_MS = 4 * 60 * 60 * 1000; // Wikipedia signals: >4h old
  async function ensureFreshNews(reason) {
    try {
      const newest = await NewsItem.findOne().sort({ fetchedAt: -1 }).select('fetchedAt').lean();
      const age = newest ? Date.now() - new Date(newest.fetchedAt).getTime() : Infinity;
      if (age > RSS_STALE_MS) {
        console.log(`[NEWS] Feed stale (${Math.round(age / 60000)} min) — ${reason}; aggregating…`);
        aggregateNews().catch(e => console.error('[NEWS] RSS refresh failed:', e.message));
      }
      // Wikipedia signals — refresh when the newest is >4h old so the top of
      // the feed keeps turning over between the scheduled generations.
      const newestSig = await NewsItem.findOne({ source: /^Wikipedia/ }).sort({ fetchedAt: -1 }).select('fetchedAt').lean();
      const sigAge = newestSig ? Date.now() - new Date(newestSig.fetchedAt).getTime() : Infinity;
      if (sigAge > SIGNAL_STALE_MS) {
        console.log(`[NEWS] Signals stale (${Math.round(sigAge / 60000)} min) — ${reason}; generating…`);
        require('./jobs/signalGenerator').generateSignals({ limit: 24 })
          .catch(e => console.error('[NEWS] Signal refresh failed:', e.message));
      }
    } catch (e) { console.error('[NEWS] Freshness check failed:', e.message); }
  }
  setTimeout(() => ensureFreshNews('boot'), 12000);
  cron.schedule('*/10 * * * *', () => ensureFreshNews('backstop'));
  console.log('News Freshness: Boot check + 10-min backstop');

  // Wikipedia-sourced signal generation — every 2 hours so the Signals rail
  // rotates 12x a day, not just twice.
  cron.schedule('0 */2 * * *', async () => {
    console.log('[CRON] Generating Wikipedia signals...');
    try {
      const { generateSignals } = require('./jobs/signalGenerator');
      await generateSignals({ limit: 24 });
    } catch (error) {
      console.error('[CRON] Signal generation failed:', error.message);
    }
  });
  console.log('Signal Generation: Scheduled (every 2h)');

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

  // Ratings enrichment — pull REAL Google Places / Yelp ratings onto companies
  // that don't yet have them. Runs every 6h; silently skips when no keys are
  // configured (so we don't spam logs). When a key IS present, the numbers
  // start showing up in the Companies rank within a cycle.
  cron.schedule('17 */6 * * *', async () => {
    if (!process.env.GOOGLE_PLACES_API_KEY && !process.env.YELP_API_KEY) return;
    try {
      const { enrichRatings } = require('./jobs/enrichRatings');
      const r = await enrichRatings({ limit: 80 });
      console.log(`[CRON] Ratings enrichment — scanned ${r.scanned}, enriched ${r.enriched}, unmatched ${r.unmatched}, errors ${r.errors}`);
    } catch (e) { console.error('[CRON] Ratings enrichment failed:', e.message); }
  });
  console.log('Ratings Enrichment: Scheduled (every 6h; requires GOOGLE_PLACES_API_KEY or YELP_API_KEY)');

  // First-boot ratings pull — 45s after start, so a freshly-set API key on
  // Railway lights up the Companies rank without waiting for the 6h cadence.
  setTimeout(async () => {
    if (!process.env.GOOGLE_PLACES_API_KEY && !process.env.YELP_API_KEY) return;
    try {
      const { enrichRatings } = require('./jobs/enrichRatings');
      const r = await enrichRatings({ limit: 40 });
      console.log(`[BOOT] Ratings enrichment — scanned ${r.scanned}, enriched ${r.enriched}`);
    } catch (e) { console.error('[BOOT] Ratings enrichment skipped:', e.message); }
  }, 45000);

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

  // Seed map generation — every 2 hours so the Atlas keeps growing through
  // the day and the Hub's "Signals / maps" rail rotates through fresh maps.
  cron.schedule('0 */2 * * *', async () => {
    console.log('[CRON] Running seed map generation...');
    try {
      await generateSeedMaps(5);
    } catch (error) {
      console.error('[CRON] Seed map generation failed:', error.message);
    }
  });
  console.log('Seed Maps: Scheduled (every 2h)');

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
