const express = require('express');
const { authenticate, requireStatus } = require('../middleware/auth');
const metaService = require('../services/metaService');
const { decrypt } = require('../services/encryptionService');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const { apiResponse } = require('../utils/helpers');

const router = express.Router();

const getWAAccount = async (tenantId) => {
  const wa = await WhatsAppAccount.findOne({ tenant_id: tenantId });
  if (!wa) throw new Error('No WhatsApp account connected');
  return { wa, accessToken: decrypt(wa.access_token_encrypted) };
};

// ─── LIST ALL TEMPLATES ────────────────────────────────────
router.get('/', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { wa, accessToken } = await getWAAccount(req.tenant._id);
    const templates = await metaService.getTemplates(wa.waba_id, accessToken);

    return apiResponse(res, { data: { templates } });
  } catch (error) {
    console.error('List templates error:', error);
    return apiResponse(res, { status: 500, success: false, error: `Failed to fetch templates: ${error.message}` });
  }
});

// ─── CREATE TEMPLATE ───────────────────────────────────────
router.post('/', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { name, category, language, components } = req.body;
    if (!name || !category || !components) {
      return apiResponse(res, { status: 400, success: false, error: 'name, category, and components are required' });
    }

    const { wa, accessToken } = await getWAAccount(req.tenant._id);

    const result = await metaService.createTemplate(wa.waba_id, accessToken, {
      name,
      category,
      language: language || 'en',
      components,
    });

    return apiResponse(res, { status: 201, data: { template: result } });
  } catch (error) {
    console.error('Create template error:', error);
    return apiResponse(res, { status: 500, success: false, error: `Failed to create template: ${error.message}` });
  }
});

// ─── DELETE TEMPLATE ───────────────────────────────────────
router.delete('/:name', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { wa, accessToken } = await getWAAccount(req.tenant._id);
    await metaService.deleteTemplate(wa.waba_id, accessToken, req.params.name);

    return apiResponse(res, { data: { message: 'Template deleted' } });
  } catch (error) {
    return apiResponse(res, { status: 500, success: false, error: `Failed to delete template: ${error.message}` });
  }
});

module.exports = router;
