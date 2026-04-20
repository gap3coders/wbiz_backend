const express = require('express');
const { authenticate, requireStatus } = require('../middleware/auth');
const metaService = require('../services/metaService');
const { decrypt } = require('../services/encryptionService');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const Message = require('../models/Message');
const Campaign = require('../models/Campaign');
const { apiResponse } = require('../utils/helpers');

const router = express.Router();

const getWAAccount = async (tenantId) => {
  const wa = await WhatsAppAccount.findOne({ tenant_id: tenantId, is_default: true })
    || await WhatsAppAccount.findOne({ tenant_id: tenantId });
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

// ─── TEMPLATE ANALYTICS (all templates) ───────────────────
router.get('/analytics', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const rangeParam = req.query.range || req.query.days || '30';
    const days = Math.max(1, Math.min(365, parseInt(String(rangeParam).replace(/\D/g, ''), 10) || 30));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const pipeline = [
      {
        $match: {
          tenant_id: req.tenant._id,
          message_type: 'template',
          template_name: { $ne: null },
          timestamp: { $gte: since },
        },
      },
      {
        $group: {
          _id: '$template_name',
          total_sent: { $sum: 1 },
          delivered: {
            $sum: { $cond: [{ $in: ['$status', ['delivered', 'read']] }, 1, 0] },
          },
          read: {
            $sum: { $cond: [{ $eq: ['$status', 'read'] }, 1, 0] },
          },
          failed: {
            $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] },
          },
        },
      },
      { $sort: { total_sent: -1 } },
      {
        $project: {
          _id: 0,
          template_name: '$_id',
          total_sent: 1,
          delivered: 1,
          read: 1,
          failed: 1,
          delivery_rate: {
            $cond: [
              { $gt: ['$total_sent', 0] },
              { $round: [{ $multiply: [{ $divide: ['$delivered', '$total_sent'] }, 100] }, 2] },
              0,
            ],
          },
          read_rate: {
            $cond: [
              { $gt: ['$delivered', 0] },
              { $round: [{ $multiply: [{ $divide: ['$read', '$delivered'] }, 100] }, 2] },
              0,
            ],
          },
        },
      },
    ];

    const analytics = await Message.aggregate(pipeline);

    return apiResponse(res, { data: { analytics, days, generated_at: new Date().toISOString() } });
  } catch (error) {
    console.error('Template analytics error:', error);
    return apiResponse(res, { status: 500, success: false, error: `Failed to fetch template analytics: ${error.message}` });
  }
});

// ─── TEMPLATE ANALYTICS (single template) ─────────────────
router.get('/analytics/:templateName', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { templateName } = req.params;
    const rangeParam = req.query.range || req.query.days || '30';
    const days = Math.max(1, Math.min(365, parseInt(String(rangeParam).replace(/\D/g, ''), 10) || 30));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const matchStage = {
      tenant_id: req.tenant._id,
      message_type: 'template',
      template_name: templateName,
      timestamp: { $gte: since },
    };

    // Total stats
    const [totalStats] = await Message.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: null,
          total_sent: { $sum: 1 },
          delivered: {
            $sum: { $cond: [{ $in: ['$status', ['delivered', 'read']] }, 1, 0] },
          },
          read: {
            $sum: { $cond: [{ $eq: ['$status', 'read'] }, 1, 0] },
          },
          failed: {
            $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] },
          },
          last_sent_at: { $max: '$timestamp' },
        },
      },
    ]);

    const stats = totalStats || { total_sent: 0, delivered: 0, read: 0, failed: 0, last_sent_at: null };
    stats.delivery_rate = stats.total_sent > 0
      ? Math.round((stats.delivered / stats.total_sent) * 10000) / 100
      : 0;
    stats.read_rate = stats.delivered > 0
      ? Math.round((stats.read / stats.delivered) * 10000) / 100
      : 0;
    delete stats._id;

    // Daily breakdown for charts
    const dailyBreakdown = await Message.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
          sent: { $sum: 1 },
          delivered: {
            $sum: { $cond: [{ $in: ['$status', ['delivered', 'read']] }, 1, 0] },
          },
          read: {
            $sum: { $cond: [{ $eq: ['$status', 'read'] }, 1, 0] },
          },
          failed: {
            $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] },
          },
        },
      },
      { $sort: { _id: 1 } },
      {
        $project: {
          _id: 0,
          date: '$_id',
          sent: 1,
          delivered: 1,
          read: 1,
          failed: 1,
        },
      },
    ]);

    // Campaign usage count
    const campaignUsage = await Campaign.countDocuments({
      tenant_id: req.tenant._id,
      template_name: templateName,
    });

    return apiResponse(res, {
      data: {
        template_name: templateName,
        stats,
        daily_breakdown: dailyBreakdown,
        campaign_usage_count: campaignUsage,
        last_sent_at: stats.last_sent_at,
        days,
        generated_at: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('Template detail analytics error:', error);
    return apiResponse(res, { status: 500, success: false, error: `Failed to fetch template analytics: ${error.message}` });
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
