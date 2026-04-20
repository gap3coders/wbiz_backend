const crypto = require('crypto');
const ApiKey = require('../models/ApiKey');
const Tenant = require('../models/Tenant');

/**
 * API Key authentication middleware.
 * Checks for X-API-Key header. If present, validates the key and attaches
 * tenant info + synthetic user to req. If no header, falls through to next()
 * so JWT auth can handle the request.
 */
const apiKeyAuth = async (req, res, next) => {
  const apiKey = req.headers['x-api-key'];

  // No API key header — fall through to JWT auth
  if (!apiKey) return next();

  try {
    // Hash the provided key
    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

    // Find matching active key
    const apiKeyDoc = await ApiKey.findOne({ key_hash: keyHash, active: true });
    if (!apiKeyDoc) {
      return res.status(401).json({
        success: false,
        error: 'Invalid API key',
      });
    }

    // Check expiry
    if (apiKeyDoc.expires_at && apiKeyDoc.expires_at < new Date()) {
      return res.status(401).json({
        success: false,
        error: 'API key has expired',
      });
    }

    // Update usage stats (fire-and-forget)
    const clientIp = req.ip || req.connection?.remoteAddress || null;
    ApiKey.updateOne(
      { _id: apiKeyDoc._id },
      {
        $set: { last_used_at: new Date(), last_used_ip: clientIp },
        $inc: { request_count: 1 },
      }
    ).exec().catch(() => {});

    // Load tenant
    const tenant = await Tenant.findById(apiKeyDoc.tenant_id);
    if (!tenant) {
      return res.status(401).json({
        success: false,
        error: 'Tenant not found for API key',
      });
    }

    // Attach tenant and synthetic user to request
    req.tenant = tenant;
    req.user = {
      _id: apiKeyDoc.created_by,
      tenant_id: apiKeyDoc.tenant_id,
      role: 'api_key',
      api_key_id: apiKeyDoc._id,
      permissions: apiKeyDoc.permissions,
      status: 'active',
    };

    next();
  } catch (error) {
    console.error('API key auth error:', error);
    return res.status(500).json({
      success: false,
      error: 'API key authentication failed',
    });
  }
};

module.exports = apiKeyAuth;
