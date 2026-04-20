require('dotenv').config();

const metaGraphApiVersion = process.env.META_GRAPH_API_VERSION || 'v18.0';
const parseBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};
const parseTrustProxy = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  if (['true', 'yes', 'on'].includes(normalized)) return true;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const smtpPort = parseInt(process.env.SMTP_PORT || '465', 10);
const smtpSecure = parseBoolean(process.env.SMTP_SECURE, smtpPort === 465);
const frontendUrls = Array.from(
  new Set(
    String(process.env.FRONTEND_URLS || process.env.FRONTEND_URL || 'http://localhost:5173')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  )
);

module.exports = {
  port: process.env.PORT || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  verboseLogs: (process.env.NODE_ENV || 'development') !== 'production' || parseBoolean(process.env.ENABLE_VERBOSE_LOGS),
  frontendUrl: frontendUrls[0] || 'http://localhost:5173',
  frontendUrls,
  trustProxy: parseTrustProxy(
    process.env.TRUST_PROXY,
    (process.env.NODE_ENV || 'development') === 'production' ? 1 : false
  ),
  mongodbUri: process.env.MONGODB_URI,

  jwt: {
    secret: process.env.JWT_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    accessExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY || '30d',
  },

  encryptionKey: process.env.ENCRYPTION_KEY,

  redis: {
    url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    maxRetriesPerRequest: null, // required by BullMQ
  },

  meta: {
    appId: process.env.META_APP_ID,
    appSecret: process.env.META_APP_SECRET,
    configId: process.env.META_CONFIG_ID,
    webhookVerifyToken: process.env.WEBHOOK_VERIFY_TOKEN,
    graphApiVersion: metaGraphApiVersion,
    graphApiBase: `https://graph.facebook.com/${metaGraphApiVersion}`,
  },

  smtp: {
    host: process.env.SMTP_HOST || 'smtp.zoho.com',
    port: smtpPort,
    secure: smtpSecure,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    fromName: process.env.SMTP_FROM_NAME || 'WBIZ.IN',
    fromEmail: process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER,
  },
};
