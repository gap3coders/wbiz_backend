const express = require('express');
const { authenticate, requireStatus } = require('../middleware/auth');
const AutoResponseRule = require('../models/AutoResponseRule');
const AutoResponseLog = require('../models/AutoResponseLog');
const { apiResponse } = require('../utils/helpers');

const router = express.Router();

router.use(authenticate, requireStatus('active'));

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const normalizeKeywords = (keywords) =>
  Array.from(
    new Set(
      (Array.isArray(keywords) ? keywords : [])
        .map((keyword) => String(keyword || '').trim())
        .filter(Boolean)
    )
  );

const normalizeTemplateVariables = (variables) =>
  (Array.isArray(variables) ? variables : [])
    .map((item) => ({
      key: String(item?.key || '').trim(),
      source: String(item?.source || 'static').trim(),
      value: String(item?.value || '').trim(),
    }))
    .filter((item) => item.key);

const sanitizeRulePayload = (body = {}, userId = null, isUpdate = false) => {
  const payload = {};

  if (!isUpdate || body.name !== undefined) payload.name = String(body.name || '').trim();
  if (!isUpdate || body.description !== undefined) payload.description = String(body.description || '').trim();
  if (!isUpdate || body.active !== undefined) payload.active = Boolean(body.active);
  if (!isUpdate || body.trigger_type !== undefined) payload.trigger_type = String(body.trigger_type || 'keyword').trim();
  if (!isUpdate || body.keyword_match_type !== undefined) payload.keyword_match_type = String(body.keyword_match_type || 'contains').trim();
  if (!isUpdate || body.keywords !== undefined) payload.keywords = normalizeKeywords(body.keywords);
  if (!isUpdate || body.response_type !== undefined) payload.response_type = String(body.response_type || 'text').trim();
  if (!isUpdate || body.text_body !== undefined) payload.text_body = String(body.text_body || '');
  if (!isUpdate || body.template_name !== undefined) payload.template_name = String(body.template_name || '').trim();
  if (!isUpdate || body.template_language !== undefined) payload.template_language = String(body.template_language || 'en').trim() || 'en';
  if (!isUpdate || body.template_header_type !== undefined) payload.template_header_type = String(body.template_header_type || 'none').trim().toLowerCase() || 'none';
  if (!isUpdate || body.template_header_media_url !== undefined) payload.template_header_media_url = String(body.template_header_media_url || '').trim();
  if (!isUpdate || body.template_variables !== undefined) payload.template_variables = normalizeTemplateVariables(body.template_variables);
  if (!isUpdate || body.send_once_per_contact !== undefined) payload.send_once_per_contact = Boolean(body.send_once_per_contact);
  if (!isUpdate || body.cooldown_minutes !== undefined) payload.cooldown_minutes = Math.max(0, Number.parseInt(body.cooldown_minutes, 10) || 0);
  if (!isUpdate || body.priority !== undefined) payload.priority = Math.max(1, Number.parseInt(body.priority, 10) || 100);
  if (!isUpdate || body.stop_after_match !== undefined) payload.stop_after_match = Boolean(body.stop_after_match);

  if (!isUpdate || body.business_hours !== undefined) {
    const hours = body.business_hours || {};
    payload.business_hours = {
      timezone: String(hours.timezone || 'Asia/Kolkata').trim() || 'Asia/Kolkata',
      days: Array.isArray(hours.days)
        ? hours.days.map((day) => Number.parseInt(day, 10)).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
        : [1, 2, 3, 4, 5],
      start_time: String(hours.start_time || '09:00').trim() || '09:00',
      end_time: String(hours.end_time || '18:00').trim() || '18:00',
    };
  }

  if (userId) {
    payload.updated_by = userId;
    if (!isUpdate) payload.created_by = userId;
  }

  return payload;
};

const validateRulePayload = (payload) => {
  if (!payload.name) return 'Rule name is required';
  if (!['keyword', 'welcome', 'away', 'fallback'].includes(payload.trigger_type)) return 'Invalid trigger type';
  if (!['text', 'template'].includes(payload.response_type)) return 'Invalid response type';
  if (payload.trigger_type === 'keyword' && !payload.keywords?.length) return 'At least one keyword is required for keyword rules';
  if (payload.response_type === 'text' && !String(payload.text_body || '').trim()) return 'Text reply is required for text responses';
  if (payload.response_type === 'template' && !String(payload.template_name || '').trim()) return 'Template name is required for template responses';
  if (payload.response_type === 'template' && ['image', 'video', 'document'].includes(String(payload.template_header_type || '').toLowerCase()) && !String(payload.template_header_media_url || '').trim()) {
    return 'Template header media URL is required for media header templates';
  }
  return null;
};

router.get('/', async (req, res) => {
  try {
    const logsLimit = Math.min(Math.max(Number(req.query.logs_limit) || 10, 1), 100);
    const requestedLogsPage = parsePositiveInt(req.query.logs_page, 1);
    const logQuery = { tenant_id: req.tenant._id };

    const [rules, totalLogs, logStatusAgg] = await Promise.all([
      AutoResponseRule.find({ tenant_id: req.tenant._id }).sort({ priority: 1, created_at: -1 }).lean(),
      AutoResponseLog.countDocuments(logQuery),
      AutoResponseLog.aggregate([
        { $match: logQuery },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
    ]);

    const logPages = Math.max(1, Math.ceil(totalLogs / logsLimit));
    const logsPage = Math.min(requestedLogsPage, logPages);
    const logs = await AutoResponseLog.find(logQuery)
      .sort({ created_at: -1 })
      .skip((logsPage - 1) * logsLimit)
      .limit(logsLimit)
      .lean();

    const logTotals = { sent: 0, failed: 0, skipped: 0 };
    logStatusAgg.forEach((row) => {
      logTotals[row._id] = row.count;
    });

    const summary = {
      total_rules: rules.length,
      active_rules: rules.filter((rule) => rule.active).length,
      keyword_rules: rules.filter((rule) => rule.trigger_type === 'keyword').length,
      welcome_rules: rules.filter((rule) => rule.trigger_type === 'welcome').length,
      sent_count: logTotals.sent || 0,
      failed_count: logTotals.failed || 0,
    };

    return apiResponse(res, {
      data: {
        rules,
        logs,
        summary,
        pagination: {
          logs: {
            page: logsPage,
            limit: logsLimit,
            total: totalLogs,
            pages: logPages,
          },
        },
      },
    });
  } catch (error) {
    console.error('[Auto Responses Route][List Failed]', {
      tenant_id: String(req.tenant?._id || ''),
      error: error.message,
    });
    return apiResponse(res, { status: 500, success: false, error: '[Platform] Failed to load auto responses' });
  }
});

router.post('/', async (req, res) => {
  try {
    const payload = sanitizeRulePayload(req.body, req.user?._id, false);
    const validationError = validateRulePayload(payload);
    if (validationError) {
      return apiResponse(res, { status: 400, success: false, error: `[Platform] ${validationError}` });
    }

    const rule = await AutoResponseRule.create({
      tenant_id: req.tenant._id,
      ...payload,
    });

    return apiResponse(res, { status: 201, data: { rule } });
  } catch (error) {
    console.error('[Auto Responses Route][Create Failed]', {
      tenant_id: String(req.tenant?._id || ''),
      body: req.body,
      error: error.message,
    });
    return apiResponse(res, { status: 500, success: false, error: '[Platform] Failed to create auto response rule' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const payload = sanitizeRulePayload(req.body, req.user?._id, true);

    const existing = await AutoResponseRule.findOne({ _id: req.params.id, tenant_id: req.tenant._id });
    if (!existing) {
      return apiResponse(res, { status: 404, success: false, error: '[Platform] Auto response rule not found' });
    }

    const merged = {
      ...existing.toObject(),
      ...payload,
    };

    const validationError = validateRulePayload(merged);
    if (validationError) {
      return apiResponse(res, { status: 400, success: false, error: `[Platform] ${validationError}` });
    }

    Object.assign(existing, payload);
    await existing.save();

    return apiResponse(res, { data: { rule: existing } });
  } catch (error) {
    console.error('[Auto Responses Route][Update Failed]', {
      tenant_id: String(req.tenant?._id || ''),
      rule_id: req.params.id,
      error: error.message,
    });
    return apiResponse(res, { status: 500, success: false, error: '[Platform] Failed to update auto response rule' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const rule = await AutoResponseRule.findOneAndDelete({ _id: req.params.id, tenant_id: req.tenant._id });
    if (!rule) {
      return apiResponse(res, { status: 404, success: false, error: '[Platform] Auto response rule not found' });
    }

    await AutoResponseLog.deleteMany({ tenant_id: req.tenant._id, rule_id: rule._id });
    return apiResponse(res, { data: { message: 'Deleted' } });
  } catch (error) {
    console.error('[Auto Responses Route][Delete Failed]', {
      tenant_id: String(req.tenant?._id || ''),
      rule_id: req.params.id,
      error: error.message,
    });
    return apiResponse(res, { status: 500, success: false, error: '[Platform] Failed to delete auto response rule' });
  }
});

router.get('/logs/history', async (req, res) => {
  try {
    const requestedPage = parsePositiveInt(req.query.page, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const query = { tenant_id: req.tenant._id };
    const total = await AutoResponseLog.countDocuments(query);
    const pages = Math.max(1, Math.ceil(total / limit));
    const page = Math.min(requestedPage, pages);

    const logs = await AutoResponseLog.find(query)
      .sort({ created_at: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    return apiResponse(res, {
      data: {
        logs,
        pagination: {
          page,
          limit,
          total,
          pages,
        },
      },
    });
  } catch (error) {
    console.error('[Auto Responses Route][Logs Failed]', {
      tenant_id: String(req.tenant?._id || ''),
      error: error.message,
    });
    return apiResponse(res, { status: 500, success: false, error: '[Platform] Failed to load auto response logs' });
  }
});

module.exports = router;
