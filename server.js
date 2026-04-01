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

fs.mkdirSync(path.join(storageRoot, 'media'), { recursive: true });

app.set('trust proxy', config.trustProxy);

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: config.frontendUrl, credentials: true, methods: ['GET','POST','PUT','DELETE','PATCH'], allowedHeaders: ['Content-Type','Authorization'] }));
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

app.get('/health', (req, res) => res.json({ status:'ok', timestamp:new Date().toISOString(), uptime:process.uptime() }));

app.use('/api/v1/auth', authLimiter, authRoutes);
app.use('/api/v1/meta', apiLimiter, metaRoutes);
app.use('/api/v1/webhook', webhookRoutes);
app.use('/api/v1/contacts', apiLimiter, contactsRoutes);
app.use('/api/v1/conversations', apiLimiter, conversationsRoutes);
app.use('/api/v1/campaigns', apiLimiter, campaignsRoutes);
app.use('/api/v1/analytics', apiLimiter, analyticsRoutes);
app.use('/api/v1/billing', apiLimiter, billingRoutes);
app.use('/api/v1/notifications', apiLimiter, notificationsRoutes);
app.use('/api/v1/logs', apiLimiter, logsRoutes);
app.use('/api/v1/media', apiLimiter, mediaRoutes);
app.use('/api/v1/auto-responses', apiLimiter, autoResponsesRoutes);

app.use((req, res) => res.status(404).json({ success:false, error:`Route ${req.method} ${req.originalUrl} not found` }));
app.use((err, req, res, next) => { console.error('Unhandled error:', err); res.status(500).json({ success:false, error: config.nodeEnv==='development'?err.message:'Internal server error' }); });

const startServer = async () => {
  await connectDB();
  await Contact.migrateToSinglePhoneField();
  await Message.migrateLegacyIndexesAndIds();
  await Conversation.migrateIndexesForSinglePhone();
  app.listen(config.port, () => {
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
};
startServer().catch((error) => console.error(error));
module.exports = app;
