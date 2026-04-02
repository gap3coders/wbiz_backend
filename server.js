const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const connectDB = require('./config/db');
const { authLimiter, apiLimiter } = require('./middleware/rateLimiter');

const authRoutes = require('./routes/auth');
const metaRoutes = require('./routes/meta');
const webhookRoutes = require('./routes/webhook');
const contactsRoutes = require('./routes/contacts');
const conversationsRoutes = require('./routes/conversations');
const campaignsRoutes = require('./routes/campaigns');
const analyticsRoutes = require('./routes/analytics');
const billingRoutes = require('./routes/billing');
const notificationsRoutes = require('./routes/notifications');
const logsRoutes = require('./routes/logs');
const mediaRoutes = require('./routes/media');
const autoResponsesRoutes = require('./routes/autoResponses');
const Message = require('./models/Message');
const Conversation = require('./models/Conversation');
const Contact = require('./models/Contact');

const app = express();
const storageRoot = path.join(__dirname, 'storage');
let bootstrapped = false;
let bootstrapPromise = null;
let bootstrapError = null;
let keepAliveTimer = null;
let healthSample = { ok: 0, error: 0, last: null };

fs.mkdirSync(path.join(storageRoot, 'media'), { recursive: true });

app.set('trust proxy', config.trustProxy);

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    const allowed = new Set([config.frontendUrl, ...(config.frontendUrls || [])]);
    if (allowed.has(origin)) return cb(null, true);
    return cb(new Error('CORS: origin not allowed'));
  },
  credentials: true,
  methods: ['GET','POST','PUT','DELETE','PATCH','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
};

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors(corsOptions));
app.use(express.json({
  limit: '50mb',
  verify: (req, res, buffer) => {
    if (req.originalUrl.startsWith('/api/v1/webhook/meta')) {
      req.rawBody = buffer.toString('utf8');
    }
  },
}));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use('/uploads', express.static(storageRoot, { maxAge: '1h' }));
app.options('*', cors(corsOptions));

app.get('/health', (req, res) => {
  res.json({
    status: bootstrapped ? 'ok' : bootstrapError ? 'error' : 'starting',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    ready: bootstrapped,
    bootstrap_error: bootstrapError ? bootstrapError.message : null,
    samples: healthSample,
  });
});

app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    service: 'whatsapp-saas-backend',
    status: bootstrapped ? 'ok' : bootstrapError ? 'error' : 'starting',
    health: '/health',
  });
});

const readinessGuard = (req, res, next) => {
  if (bootstrapped) return next();
  if (bootstrapError) {
    return res.status(503).json({ success: false, error: 'Service initialization failed', detail: bootstrapError.message });
  }
  return res.status(503).json({ success: false, error: 'Service is starting. Please retry shortly.' });
};

app.use('/api/v1/auth', readinessGuard, authLimiter, authRoutes);
app.use('/api/v1/meta', readinessGuard, apiLimiter, metaRoutes);
app.use('/api/v1/webhook', readinessGuard, webhookRoutes);
app.use('/api/v1/contacts', readinessGuard, apiLimiter, contactsRoutes);
app.use('/api/v1/conversations', readinessGuard, apiLimiter, conversationsRoutes);
app.use('/api/v1/campaigns', readinessGuard, apiLimiter, campaignsRoutes);
app.use('/api/v1/analytics', readinessGuard, apiLimiter, analyticsRoutes);
app.use('/api/v1/billing', readinessGuard, apiLimiter, billingRoutes);
app.use('/api/v1/notifications', readinessGuard, apiLimiter, notificationsRoutes);
app.use('/api/v1/logs', readinessGuard, apiLimiter, logsRoutes);
app.use('/api/v1/media', readinessGuard, apiLimiter, mediaRoutes);
app.use('/api/v1/auto-responses', readinessGuard, apiLimiter, autoResponsesRoutes);

app.use((req, res) => res.status(404).json({ success:false, error:`Route ${req.method} ${req.originalUrl} not found` }));
app.use((err, req, res, next) => { console.error('Unhandled error:', err); res.status(500).json({ success:false, error: config.nodeEnv==='development'?err.message:'Internal server error' }); });

const bootstrapApp = async () => {
  if (bootstrapped) return;
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    bootstrapError = null;
    await connectDB();
    await Contact.migrateToSinglePhoneField();
    await Message.migrateLegacyIndexesAndIds();
    await Conversation.migrateIndexesForSinglePhone();
    bootstrapped = true;
  })().catch((error) => {
    bootstrapError = error;
    throw error;
  }).finally(() => {
    bootstrapPromise = null;
  });

  return bootstrapPromise;
};

const startServer = async () => {
  const server = app.listen(config.port, () => {
    if (!config.verboseLogs) return;
    console.log(`
╔══════════════════════════════════════════════╗
║  WhatsApp SaaS Platform — Advanced Backend   ║
╠══════════════════════════════════════════════╣
║  Environment : ${config.nodeEnv.padEnd(29)}║
║  Port        : ${String(config.port).padEnd(29)}║
║  Frontend    : ${config.frontendUrl.padEnd(29)}║
║  Meta App ID : ${config.meta.appId.padEnd(29)}║
╚══════════════════════════════════════════════╝
    `);
  });
  bootstrapApp().catch((error) => console.error(error));

  // Initialize socket server (if available) and keep-alive
  try {
    const { initializeSocketServer } = require('./services/socketService');
    initializeSocketServer(server);
  } catch {}

  const runHealthProbe = async () => {
    try {
      await bootstrapApp();
      healthSample.ok += 1;
      healthSample.last = new Date().toISOString();
    } catch (error) {
      healthSample.error += 1;
      healthSample.last = new Date().toISOString();
      console.error('[KeepAlive] Bootstrap/health failed:', error.message);
    }
  };
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = setInterval(runHealthProbe, 30_000);
  runHealthProbe().catch(() => {});
};

if (process.env.VERCEL !== '1') {
  startServer().catch((error) => console.error(error));
}

module.exports = { app, bootstrapApp };
