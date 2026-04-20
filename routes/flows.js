const express = require('express');
const { authenticate, requireStatus } = require('../middleware/auth');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const WhatsAppFlow = require('../models/WhatsAppFlow');
const FlowSubmission = require('../models/FlowSubmission');
const Conversation = require('../models/Conversation');
const Contact = require('../models/Contact');
const { decrypt } = require('../services/encryptionService');
const metaService = require('../services/metaService');
const { apiResponse } = require('../utils/helpers');
const { recordOutboundMessage } = require('../services/messagingService');

const router = express.Router();

router.use(authenticate, requireStatus('active'));

const getWAAccount = async (tenantId) => {
  const wa = await WhatsAppAccount.findOne({ tenant_id: tenantId, is_default: true })
    || await WhatsAppAccount.findOne({ tenant_id: tenantId });
  if (!wa) throw new Error('No WhatsApp account connected');
  return { wa, accessToken: decrypt(wa.access_token_encrypted) };
};

// ─── LIST ALL FLOWS (from DB) ─────────────────────────────
router.get('/', async (req, res) => {
  try {
    const flows = await WhatsAppFlow.find({ tenant_id: req.tenant._id }).sort({ name: 1 }).lean();
    return apiResponse(res, { data: { flows } });
  } catch (error) {
    console.error('[Flows] List error:', error.message);
    return apiResponse(res, { status: 500, success: false, error: `Failed to list flows: ${error.message}` });
  }
});

// ─── ANALYTICS SUMMARY ────────────────────────────────────
router.get('/analytics/summary', async (req, res) => {
  try {
    const tenantId = req.tenant._id;
    const totalFlows = await WhatsAppFlow.countDocuments({ tenant_id: tenantId });
    const totalSubmissions = await FlowSubmission.countDocuments({ tenant_id: tenantId });
    const completedSubmissions = await FlowSubmission.countDocuments({ tenant_id: tenantId, status: 'completed' });
    const completionRate = totalSubmissions > 0 ? Math.round((completedSubmissions / totalSubmissions) * 10000) / 100 : 0;

    const flowStats = await WhatsAppFlow.aggregate([
      { $match: { tenant_id: tenantId } },
      {
        $group: {
          _id: null,
          total_sent: { $sum: '$stats.sent' },
          total_delivered: { $sum: '$stats.delivered' },
          total_failed: { $sum: '$stats.failed' },
          total_completed: { $sum: '$stats.completed' },
        },
      },
    ]);

    return apiResponse(res, {
      data: {
        total_flows: totalFlows,
        total_submissions: totalSubmissions,
        completion_rate: completionRate,
        stats: flowStats[0] || { total_sent: 0, total_delivered: 0, total_failed: 0, total_completed: 0 },
      },
    });
  } catch (error) {
    console.error('[Flows] Analytics error:', error.message);
    return apiResponse(res, { status: 500, success: false, error: `Failed to get analytics: ${error.message}` });
  }
});

// ─── SYNC FLOWS FROM META ─────────────────────────────────
router.post('/sync', async (req, res) => {
  try {
    const { wa, accessToken } = await getWAAccount(req.tenant._id);
    const metaFlows = await metaService.getFlows(wa.waba_id, accessToken);

    const results = [];
    for (const mf of metaFlows) {
      const upserted = await WhatsAppFlow.findOneAndUpdate(
        { tenant_id: req.tenant._id, flow_id: mf.id },
        {
          $set: {
            name: mf.name,
            status: mf.status,
            categories: mf.categories || [],
            validation_errors: mf.validation_errors || [],
            json_version: mf.json_version || null,
            data_api_version: mf.data_api_version || null,
            preview_url: mf.preview?.preview_url || null,
            updated_at_meta: mf.updated_at ? new Date(mf.updated_at) : null,
            last_synced_at: new Date(),
          },
        },
        { new: true, upsert: true }
      );
      results.push(upserted);
    }

    return apiResponse(res, { data: { synced: results.length, flows: results } });
  } catch (error) {
    console.error('[Flows] Sync error:', error.message);
    return apiResponse(res, { status: 500, success: false, error: `Failed to sync flows: ${error.message}` });
  }
});

// ─── CREATE FLOW ─────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { name, categories } = req.body;
    if (!name) {
      return apiResponse(res, { status: 400, success: false, error: 'name is required' });
    }

    const { wa, accessToken } = await getWAAccount(req.tenant._id);
    const metaResult = await metaService.createFlow(wa.waba_id, accessToken, name, categories || []);

    // Save to local DB
    const flow = await WhatsAppFlow.findOneAndUpdate(
      { tenant_id: req.tenant._id, flow_id: metaResult.id },
      {
        $set: {
          name,
          status: 'DRAFT',
          categories: categories || [],
          last_synced_at: new Date(),
        },
      },
      { new: true, upsert: true }
    );

    return apiResponse(res, { status: 201, data: { flow, meta: metaResult } });
  } catch (error) {
    console.error('[Flows] Create error:', error.message);
    return apiResponse(res, { status: error.statusCode || 500, success: false, error: error.message || 'Failed to create flow' });
  }
});

// ─── UPLOAD FLOW JSON ────────────────────────────────────
router.post('/:id/json', async (req, res) => {
  try {
    const flow = await WhatsAppFlow.findOne({ _id: req.params.id, tenant_id: req.tenant._id });
    if (!flow) {
      return apiResponse(res, { status: 404, success: false, error: 'Flow not found' });
    }

    const { flow_json } = req.body;
    if (!flow_json) {
      return apiResponse(res, { status: 400, success: false, error: 'flow_json is required' });
    }

    console.log('[Flows] Uploading JSON for flow', flow.flow_id, ':', JSON.stringify(flow_json, null, 2));

    const { accessToken } = await getWAAccount(req.tenant._id);
    const metaResult = await metaService.updateFlowJSON(flow.flow_id, accessToken, flow_json);

    // Re-sync from Meta to get updated validation status
    try {
      const detail = await metaService.getFlowDetail(flow.flow_id, accessToken);
      await WhatsAppFlow.updateOne(
        { _id: flow._id },
        {
          $set: {
            validation_errors: detail.validation_errors || [],
            json_version: detail.json_version || null,
            last_synced_at: new Date(),
          },
        }
      );
    } catch {}

    return apiResponse(res, { data: { success: true, meta: metaResult } });
  } catch (error) {
    console.error('[Flows] Upload JSON error:', error.message);
    return apiResponse(res, { status: error.statusCode || 500, success: false, error: error.message || 'Failed to upload flow JSON' });
  }
});

// ─── PUBLISH FLOW ────────────────────────────────────────
router.post('/:id/publish', async (req, res) => {
  try {
    const flow = await WhatsAppFlow.findOne({ _id: req.params.id, tenant_id: req.tenant._id });
    if (!flow) {
      return apiResponse(res, { status: 404, success: false, error: 'Flow not found' });
    }

    const { accessToken } = await getWAAccount(req.tenant._id);
    const metaResult = await metaService.publishFlow(flow.flow_id, accessToken);

    await WhatsAppFlow.updateOne(
      { _id: flow._id },
      { $set: { status: 'PUBLISHED', last_synced_at: new Date() } }
    );

    return apiResponse(res, { data: { success: true, meta: metaResult } });
  } catch (error) {
    console.error('[Flows] Publish error:', error.message);
    return apiResponse(res, { status: error.statusCode || 500, success: false, error: error.message || 'Failed to publish flow' });
  }
});

// ─── DEPRECATE FLOW (for PUBLISHED flows) ────────────────
router.post('/:id/deprecate', async (req, res) => {
  try {
    const flow = await WhatsAppFlow.findOne({ _id: req.params.id, tenant_id: req.tenant._id });
    if (!flow) {
      return apiResponse(res, { status: 404, success: false, error: 'Flow not found' });
    }
    if (flow.status !== 'PUBLISHED') {
      return apiResponse(res, { status: 400, success: false, error: 'Only PUBLISHED flows can be deprecated' });
    }

    const { accessToken } = await getWAAccount(req.tenant._id);
    const metaResult = await metaService.deprecateFlow(flow.flow_id, accessToken);

    await WhatsAppFlow.updateOne(
      { _id: flow._id },
      { $set: { status: 'DEPRECATED', last_synced_at: new Date() } }
    );

    return apiResponse(res, { data: { success: true, meta: metaResult } });
  } catch (error) {
    console.error('[Flows] Deprecate error:', error.message);
    return apiResponse(res, { status: error.statusCode || 500, success: false, error: error.message || 'Failed to deprecate flow' });
  }
});

// ─── GET FLOW ASSETS (JSON) ─────────────────────────────
router.get('/:id/assets', async (req, res) => {
  try {
    const flow = await WhatsAppFlow.findOne({ _id: req.params.id, tenant_id: req.tenant._id });
    if (!flow) {
      return apiResponse(res, { status: 404, success: false, error: 'Flow not found' });
    }

    const { accessToken } = await getWAAccount(req.tenant._id);
    const assets = await metaService.getFlowAssets(flow.flow_id, accessToken);

    console.log('[Flows] Assets for flow', flow.flow_id, ':', JSON.stringify(assets, null, 2));

    return apiResponse(res, { data: { assets } });
  } catch (error) {
    console.error('[Flows] Get assets error:', error.message);
    return apiResponse(res, { status: error.statusCode || 500, success: false, error: error.message || 'Failed to get flow assets' });
  }
});

// ─── DELETE FLOW ─────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const flow = await WhatsAppFlow.findOne({ _id: req.params.id, tenant_id: req.tenant._id });
    if (!flow) {
      return apiResponse(res, { status: 404, success: false, error: 'Flow not found' });
    }

    const { accessToken } = await getWAAccount(req.tenant._id);

    // Only DRAFT flows can be deleted on Meta
    if (flow.status === 'DRAFT') {
      try {
        await metaService.deleteFlow(flow.flow_id, accessToken);
      } catch (metaErr) {
        console.warn('[Flows] Meta delete failed (may already be deleted):', metaErr.message);
      }
    }

    await WhatsAppFlow.deleteOne({ _id: flow._id });
    await FlowSubmission.deleteMany({ tenant_id: req.tenant._id, flow_id: flow.flow_id });

    return apiResponse(res, { data: { message: 'Flow deleted' } });
  } catch (error) {
    console.error('[Flows] Delete error:', error.message);
    return apiResponse(res, { status: error.statusCode || 500, success: false, error: error.message || 'Failed to delete flow' });
  }
});

// ─── GET SINGLE FLOW ──────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const flow = await WhatsAppFlow.findOne({ _id: req.params.id, tenant_id: req.tenant._id }).lean();
    if (!flow) {
      return apiResponse(res, { status: 404, success: false, error: 'Flow not found' });
    }

    // Optionally refresh from Meta
    if (req.query.refresh === 'true') {
      try {
        const { accessToken } = await getWAAccount(req.tenant._id);
        const metaDetail = await metaService.getFlowDetail(flow.flow_id, accessToken);
        const updated = await WhatsAppFlow.findOneAndUpdate(
          { _id: flow._id },
          {
            $set: {
              name: metaDetail.name,
              status: metaDetail.status,
              categories: metaDetail.categories || [],
              validation_errors: metaDetail.validation_errors || [],
              json_version: metaDetail.json_version || null,
              data_api_version: metaDetail.data_api_version || null,
              preview_url: metaDetail.preview?.preview_url || null,
              updated_at_meta: metaDetail.updated_at ? new Date(metaDetail.updated_at) : null,
              last_synced_at: new Date(),
            },
          },
          { new: true, lean: true }
        );
        return apiResponse(res, { data: { flow: updated } });
      } catch (refreshError) {
        console.warn('[Flows] Refresh from Meta failed, returning cached:', refreshError.message);
      }
    }

    return apiResponse(res, { data: { flow } });
  } catch (error) {
    console.error('[Flows] Get detail error:', error.message);
    return apiResponse(res, { status: 500, success: false, error: `Failed to get flow: ${error.message}` });
  }
});

// ─── SEND FLOW TO CONTACT ─────────────────────────────────
router.post('/:id/send', async (req, res) => {
  try {
    const flow = await WhatsAppFlow.findOne({ _id: req.params.id, tenant_id: req.tenant._id });
    if (!flow) {
      return apiResponse(res, { status: 404, success: false, error: 'Flow not found' });
    }

    const { phone, flow_cta, header_text, body_text, footer_text, flow_token } = req.body;
    if (!phone) {
      return apiResponse(res, { status: 400, success: false, error: 'phone is required' });
    }
    if (!body_text) {
      return apiResponse(res, { status: 400, success: false, error: 'body_text is required' });
    }

    const recipientPhone = String(phone).replace(/[^0-9]/g, '');
    const { wa, accessToken } = await getWAAccount(req.tenant._id);

    // 24-hour window enforcement (flow messages are interactive, not templates)
    const conversation = await Conversation.findOne({
      tenant_id: req.tenant._id,
      contact_phone: recipientPhone,
    });
    if (conversation) {
      const isWindowExpired = !conversation.window_expires_at || new Date() > conversation.window_expires_at;
      if (isWindowExpired) {
        return apiResponse(res, {
          status: 403,
          success: false,
          error: '24-hour conversation window has expired. Flow messages can only be sent within the window.',
          data: { window_expired: true, window_expires_at: conversation.window_expires_at },
        });
      }
    }

    // Opt-in check
    const recipientContact = await Contact.findOne({
      tenant_id: req.tenant._id,
      phone: recipientPhone,
    });
    if (recipientContact && recipientContact.opt_in === false) {
      return apiResponse(res, {
        status: 403,
        success: false,
        error: 'Contact is unsubscribed.',
        data: { unsubscribed: true },
      });
    }

    // Try to resolve first screen from flow JSON assets
    let firstScreenId = null;
    try {
      const assets = await metaService.getFlowAssets(flow.flow_id, accessToken);
      const jsonAsset = assets?.data?.find((a) => a.name === 'flow.json');
      if (jsonAsset?.asset) {
        const parsed = typeof jsonAsset.asset === 'string' ? JSON.parse(jsonAsset.asset) : jsonAsset.asset;
        if (parsed?.screens?.length > 0) {
          firstScreenId = parsed.screens[0].id;
        }
      }
    } catch { /* ignore – will omit navigate action */ }

    const metaResponse = await metaService.sendFlowMessage(
      wa.phone_number_id,
      accessToken,
      recipientPhone,
      flow.flow_id,
      flow_token,
      flow_cta,
      header_text,
      body_text,
      footer_text,
      firstScreenId,
    );

    // Record outbound message
    const stored = await recordOutboundMessage({
      tenantId: req.tenant._id,
      userId: req.user._id,
      wabaId: wa.waba_id,
      phoneNumberId: wa.phone_number_id,
      to: recipientPhone,
      type: 'interactive',
      payload: {
        messaging_product: 'whatsapp',
        to: recipientPhone,
        type: 'interactive',
        interactive: { type: 'flow', body: { text: body_text } },
      },
      whatsappMessageId: metaResponse.messages?.[0]?.id || null,
      status: 'sent',
      messageSource: 'flow',
    });

    // Increment sent stat
    await WhatsAppFlow.updateOne(
      { _id: flow._id },
      { $inc: { 'stats.sent': 1 } }
    );

    return apiResponse(res, {
      status: 201,
      data: {
        message: stored.message,
        conversation: stored.conversation,
        meta: metaResponse,
      },
    });
  } catch (error) {
    console.error('[Flows] Send error:', error.message, error.metaError ? JSON.stringify(error.metaError) : '');
    return apiResponse(res, {
      status: error.statusCode || 500,
      success: false,
      error: error.message || 'Failed to send flow message',
      data: error.metaError ? { meta_error: error.metaError } : undefined,
    });
  }
});

// ─── SEND FLOW TO MULTIPLE CONTACTS (bulk) ───────────────
router.post('/:id/send-bulk', async (req, res) => {
  try {
    const flow = await WhatsAppFlow.findOne({ _id: req.params.id, tenant_id: req.tenant._id });
    if (!flow) {
      return apiResponse(res, { status: 404, success: false, error: 'Flow not found' });
    }

    const { phones, tags, send_all, flow_cta, header_text, body_text, footer_text, flow_token } = req.body;
    if (!body_text) {
      return apiResponse(res, { status: 400, success: false, error: 'body_text is required' });
    }

    const { wa, accessToken } = await getWAAccount(req.tenant._id);

    // Try to resolve first screen from flow JSON assets
    let firstScreenId = null;
    try {
      const assets = await metaService.getFlowAssets(flow.flow_id, accessToken);
      const jsonAsset = assets?.data?.find((a) => a.name === 'flow.json');
      if (jsonAsset?.asset) {
        const parsed = typeof jsonAsset.asset === 'string' ? JSON.parse(jsonAsset.asset) : jsonAsset.asset;
        if (parsed?.screens?.length > 0) {
          firstScreenId = parsed.screens[0].id;
        }
      }
    } catch { /* ignore */ }

    // Resolve target phone numbers
    let targetPhones = [];
    if (send_all) {
      const contacts = await Contact.find({ tenant_id: req.tenant._id, opt_in: { $ne: false } }).select('phone').lean();
      targetPhones = contacts.map((c) => c.phone).filter(Boolean);
    } else if (tags && tags.length > 0) {
      const contacts = await Contact.find({
        tenant_id: req.tenant._id,
        opt_in: { $ne: false },
        $or: [{ tags: { $in: tags } }, { labels: { $in: tags } }],
      }).select('phone').lean();
      targetPhones = contacts.map((c) => c.phone).filter(Boolean);
    } else if (phones && phones.length > 0) {
      targetPhones = phones.map((p) => String(p).replace(/[^0-9]/g, '')).filter(Boolean);
    } else {
      return apiResponse(res, { status: 400, success: false, error: 'Provide phones, tags, or send_all' });
    }

    // Deduplicate
    targetPhones = [...new Set(targetPhones)];

    if (targetPhones.length === 0) {
      return apiResponse(res, { status: 400, success: false, error: 'No contacts found matching criteria' });
    }

    // Check 24-hour window for each and send
    let sent = 0;
    let failed = 0;
    const errors = [];

    for (const phone of targetPhones) {
      try {
        // 24-hour window check
        const convo = await Conversation.findOne({
          tenant_id: req.tenant._id,
          contact_phone: phone,
        });
        if (convo) {
          const isExpired = !convo.window_expires_at || new Date() > convo.window_expires_at;
          if (isExpired) {
            failed++;
            errors.push({ phone, error: 'Window expired' });
            continue;
          }
        }

        const metaResponse = await metaService.sendFlowMessage(
          wa.phone_number_id,
          accessToken,
          phone,
          flow.flow_id,
          flow_token,
          flow_cta,
          header_text,
          body_text,
          footer_text,
          firstScreenId,
        );

        await recordOutboundMessage({
          tenantId: req.tenant._id,
          userId: req.user._id,
          wabaId: wa.waba_id,
          phoneNumberId: wa.phone_number_id,
          to: phone,
          type: 'interactive',
          payload: {
            messaging_product: 'whatsapp',
            to: phone,
            type: 'interactive',
            interactive: { type: 'flow', body: { text: body_text } },
          },
          whatsappMessageId: metaResponse.messages?.[0]?.id || null,
          status: 'sent',
          messageSource: 'flow',
        });

        sent++;
      } catch (err) {
        failed++;
        errors.push({ phone, error: err.message });
      }
    }

    // Increment stats
    if (sent > 0) {
      await WhatsAppFlow.updateOne({ _id: flow._id }, { $inc: { 'stats.sent': sent } });
    }

    return apiResponse(res, {
      status: 201,
      data: { total: targetPhones.length, sent, failed, errors: errors.slice(0, 20) },
    });
  } catch (error) {
    console.error('[Flows] Bulk send error:', error.message);
    return apiResponse(res, {
      status: error.statusCode || 500,
      success: false,
      error: error.message || 'Failed to send flow messages',
    });
  }
});

// ─── LIST FLOW SUBMISSIONS ────────────────────────────────
router.get('/:id/submissions', async (req, res) => {
  try {
    const flow = await WhatsAppFlow.findOne({ _id: req.params.id, tenant_id: req.tenant._id }).lean();
    if (!flow) {
      return apiResponse(res, { status: 404, success: false, error: 'Flow not found' });
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const [submissions, total] = await Promise.all([
      FlowSubmission.find({ tenant_id: req.tenant._id, flow_id: flow.flow_id })
        .sort({ submitted_at: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      FlowSubmission.countDocuments({ tenant_id: req.tenant._id, flow_id: flow.flow_id }),
    ]);

    return apiResponse(res, {
      data: { submissions },
      meta: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('[Flows] Submissions error:', error.message);
    return apiResponse(res, { status: 500, success: false, error: `Failed to list submissions: ${error.message}` });
  }
});

module.exports = router;
