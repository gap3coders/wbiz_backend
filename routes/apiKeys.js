const express = require('express');
const crypto = require('crypto');
const { authenticate, requireStatus } = require('../middleware/auth');
const ApiKey = require('../models/ApiKey');
const { apiResponse } = require('../utils/helpers');

const router = express.Router();

// All routes require JWT auth (not API key auth) — these are management endpoints
router.use(authenticate, requireStatus('active'));

// ─── GENERATE NEW API KEY ─────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { name, permissions, expires_at } = req.body;

    if (!name || !name.trim()) {
      return apiResponse(res, { status: 400, success: false, error: 'name is required' });
    }

    // Generate random key: "wbiz_" + 35 random hex chars = 40 chars total
    const randomPart = crypto.randomBytes(18).toString('hex').slice(0, 35);
    const fullKey = `wbiz_${randomPart}`;
    const keyPrefix = fullKey.slice(0, 8);
    const keyHash = crypto.createHash('sha256').update(fullKey).digest('hex');

    const apiKeyDoc = await ApiKey.create({
      tenant_id: req.user.tenant_id,
      created_by: req.user._id,
      name: name.trim(),
      key_prefix: keyPrefix,
      key_hash: keyHash,
      permissions: permissions || undefined,
      expires_at: expires_at || null,
    });

    // Return the full key ONCE — it is never stored in plain text
    return apiResponse(res, {
      status: 201,
      data: {
        key: fullKey,
        id: apiKeyDoc._id,
        name: apiKeyDoc.name,
        permissions: apiKeyDoc.permissions,
        expires_at: apiKeyDoc.expires_at,
        created_at: apiKeyDoc.created_at,
      },
    });
  } catch (error) {
    console.error('Create API key error:', error);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to create API key' });
  }
});

// ─── LIST ALL KEYS FOR TENANT ─────────────────────────────
router.get('/', async (req, res) => {
  try {
    const keys = await ApiKey.find({ tenant_id: req.user.tenant_id })
      .select('name key_prefix permissions last_used_at request_count active expires_at created_at created_by')
      .sort({ created_at: -1 })
      .lean();

    return apiResponse(res, {
      data: {
        api_keys: keys.map((k) => ({
          id: k._id,
          name: k.name,
          key_preview: `${k.key_prefix}...`,
          permissions: k.permissions,
          last_used_at: k.last_used_at,
          request_count: k.request_count,
          active: k.active,
          expires_at: k.expires_at,
          created_at: k.created_at,
          created_by: k.created_by,
        })),
      },
    });
  } catch (error) {
    console.error('List API keys error:', error);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to list API keys' });
  }
});

// ─── UPDATE KEY (rename, toggle active, update permissions) ─
router.patch('/:id', async (req, res) => {
  try {
    const { name, active, permissions } = req.body;

    const apiKeyDoc = await ApiKey.findOne({
      _id: req.params.id,
      tenant_id: req.user.tenant_id,
    });

    if (!apiKeyDoc) {
      return apiResponse(res, { status: 404, success: false, error: 'API key not found' });
    }

    if (name !== undefined) apiKeyDoc.name = name.trim();
    if (active !== undefined) apiKeyDoc.active = active;
    if (permissions !== undefined) apiKeyDoc.permissions = permissions;

    await apiKeyDoc.save();

    return apiResponse(res, {
      data: {
        id: apiKeyDoc._id,
        name: apiKeyDoc.name,
        active: apiKeyDoc.active,
        permissions: apiKeyDoc.permissions,
        updated_at: apiKeyDoc.updated_at,
      },
    });
  } catch (error) {
    console.error('Update API key error:', error);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to update API key' });
  }
});

// ─── DELETE KEY (hard delete) ─────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const result = await ApiKey.findOneAndDelete({
      _id: req.params.id,
      tenant_id: req.user.tenant_id,
    });

    if (!result) {
      return apiResponse(res, { status: 404, success: false, error: 'API key not found' });
    }

    return apiResponse(res, { data: { message: 'API key deleted' } });
  } catch (error) {
    console.error('Delete API key error:', error);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to delete API key' });
  }
});

module.exports = router;
