/**
 * Date Trigger Routes — CRUD + dry-run + logs
 *
 * Mounted at /api/v1/date-triggers
 *
 * IMPORTANT: Static routes (/contact-fields, /logs/history) MUST be
 * defined BEFORE dynamic /:id routes, otherwise Express matches them
 * as an :id parameter.
 */
const express = require('express');
const mongoose = require('mongoose');
const { authenticate, requireStatus } = require('../middleware/auth');
const DateTrigger = require('../models/DateTrigger');
const DateTriggerLog = require('../models/DateTriggerLog');
const Contact = require('../models/Contact');
const ContactList = require('../models/ContactList');
const CustomFieldDefinition = require('../models/CustomFieldDefinition');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const { decrypt } = require('../services/encryptionService');
const metaService = require('../services/metaService');
const { apiResponse } = require('../utils/helpers');

const router = express.Router();

router.use(authenticate, requireStatus('active'));

/* ────────────────────────────────────────────────────────
   Helpers
   ──────────────────────────────────────────────────────── */

const parsePositiveInt = (v, fallback) => {
  const p = Number.parseInt(v, 10);
  return Number.isFinite(p) && p > 0 ? p : fallback;
};

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

const getWAAccount = async (tenantId) => {
  const wa = await WhatsAppAccount.findOne({ tenant_id: tenantId, is_default: true })
    || await WhatsAppAccount.findOne({ tenant_id: tenantId });
  if (!wa) throw new Error('No WhatsApp account connected');
  return { wa, accessToken: decrypt(wa.access_token_encrypted) };
};

/**
 * Resolve the value of a date field from a contact doc.
 * Supports top-level fields and dot-notation for custom_fields.
 * Examples: "birthday", "created_at", "custom_fields.renewal_date"
 */
const getContactDateValue = (contact, fieldPath) => {
  if (!fieldPath || !contact) return null;
  // Direct top-level field
  if (contact[fieldPath] !== undefined && contact[fieldPath] !== '') return contact[fieldPath];
  // Dot-notation path (e.g. "custom_fields.my_date")
  const parts = fieldPath.split('.');
  let val = contact;
  for (const p of parts) {
    if (val == null) return null;
    val = typeof val === 'object' ? val[p] : undefined;
  }
  return (val !== undefined && val !== null && val !== '') ? val : null;
};

/**
 * Smart date parser — extracts { month, day, year? } from virtually any date format.
 *
 * Handles:
 *   ISO:          "2025-06-15", "2025-06-15T10:30:00Z", "2025-06-15T10:30:00+05:30"
 *   YYYY/MM/DD:   "2025/06/15"
 *   DD-MM-YYYY:   "15-06-2025", "15/06/2025"
 *   MM-DD-YYYY:   "06-15-2025", "06/15/2025"
 *   DD-MM:        "15-06", "15/06" (day > 12 → must be DD/MM)
 *   MM-DD:        "06-15" (second > 12 → must be MM/DD)
 *   Ambiguous:    "06-05" (both ≤ 12 → treated as MM/DD but also matched as DD/MM)
 *   Timestamps:   1718438400000 (Unix ms)
 *   Text dates:   "June 15, 2025", "15 Jun 2025"
 *   Month names:  "Jun 15", "15-Jun", "June 15"
 */
const MONTH_NAMES = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

const extractMonthDay = (raw) => {
  if (raw == null || raw === '') return null;

  // Handle numeric timestamps (Unix ms or s)
  if (typeof raw === 'number' || /^\d{10,13}$/.test(String(raw))) {
    const ts = Number(raw);
    const d = new Date(ts > 1e11 ? ts : ts * 1000);
    if (!isNaN(d.getTime())) return { month: d.getMonth() + 1, day: d.getDate(), year: d.getFullYear() };
    return null;
  }

  const str = String(raw).trim();
  if (!str) return null;

  // 1) ISO format: YYYY-MM-DD or YYYY/MM/DD (with optional time)
  const isoMatch = str.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (isoMatch) {
    const m = parseInt(isoMatch[2], 10);
    const d = parseInt(isoMatch[3], 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return { month: m, day: d, year: parseInt(isoMatch[1], 10) };
    }
  }

  // 2) Month name formats: "June 15, 2025", "15 Jun 2025", "Jun 15", "15-Jun-2025"
  const monthNameMatch = str.match(/(\d{1,2})[\/\-\s]+([a-zA-Z]+)[,\-\s]*(\d{2,4})?/);
  if (monthNameMatch) {
    const monthStr = monthNameMatch[2].toLowerCase();
    if (MONTH_NAMES[monthStr]) {
      return { month: MONTH_NAMES[monthStr], day: parseInt(monthNameMatch[1], 10), year: monthNameMatch[3] ? parseInt(monthNameMatch[3], 10) : null };
    }
  }
  const monthFirstMatch = str.match(/([a-zA-Z]+)[,\-\s]+(\d{1,2})[,\-\s]*(\d{2,4})?/);
  if (monthFirstMatch) {
    const monthStr = monthFirstMatch[1].toLowerCase();
    if (MONTH_NAMES[monthStr]) {
      return { month: MONTH_NAMES[monthStr], day: parseInt(monthFirstMatch[2], 10), year: monthFirstMatch[3] ? parseInt(monthFirstMatch[3], 10) : null };
    }
  }

  // 3) Numeric with 3 parts: DD/MM/YYYY or MM/DD/YYYY
  const threePartMatch = str.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (threePartMatch) {
    let a = parseInt(threePartMatch[1], 10);
    let b = parseInt(threePartMatch[2], 10);
    let y = parseInt(threePartMatch[3], 10);
    if (y < 100) y += 2000; // 2-digit year

    // Smart detection: if first > 12, it must be DD/MM/YYYY
    if (a > 12 && b >= 1 && b <= 12) return { month: b, day: a, year: y };
    // If second > 12, it must be MM/DD/YYYY
    if (b > 12 && a >= 1 && a <= 12) return { month: a, day: b, year: y };
    // Both ≤ 12: assume DD/MM/YYYY (Indian/EU convention, more common globally)
    if (a >= 1 && a <= 31 && b >= 1 && b <= 12) return { month: b, day: a, year: y };
    // Fallback
    if (a >= 1 && a <= 12 && b >= 1 && b <= 31) return { month: a, day: b, year: y };
  }

  // 4) Two-part short format: DD/MM or MM/DD
  const twoPartMatch = str.match(/^(\d{1,2})[\/\-\.](\d{1,2})$/);
  if (twoPartMatch) {
    let a = parseInt(twoPartMatch[1], 10);
    let b = parseInt(twoPartMatch[2], 10);

    // If first > 12, must be DD/MM
    if (a > 12 && b >= 1 && b <= 12) return { month: b, day: a };
    // If second > 12, must be MM/DD
    if (b > 12 && a >= 1 && a <= 12) return { month: a, day: b };
    // Both ≤ 12: assume DD/MM (Indian/EU convention)
    if (a >= 1 && a <= 31 && b >= 1 && b <= 12) return { month: b, day: a };
    if (a >= 1 && a <= 12 && b >= 1 && b <= 31) return { month: a, day: b };
  }

  // 5) Fallback: JavaScript Date constructor (handles "June 15, 2025", etc.)
  const d = new Date(str);
  if (!isNaN(d.getTime())) {
    // Avoid timezone offset issues — parse UTC components for ISO-like strings
    const hasTimezone = /[TZ+]/.test(str) || /\d{4}-\d{2}-\d{2}/.test(str);
    if (hasTimezone) {
      return { month: d.getUTCMonth() + 1, day: d.getUTCDate(), year: d.getUTCFullYear() };
    }
    return { month: d.getMonth() + 1, day: d.getDate(), year: d.getFullYear() };
  }

  return null;
};

/**
 * Validate that a raw value can be parsed as a valid date for trigger matching.
 * Returns { valid, parsed, error } for use in validation endpoints.
 */
const validateDateValue = (raw) => {
  if (raw == null || raw === '') return { valid: false, error: 'Empty date value' };
  const parsed = extractMonthDay(raw);
  if (!parsed) return { valid: false, error: `Cannot parse "${raw}" as a date` };
  if (parsed.month < 1 || parsed.month > 12) return { valid: false, error: `Invalid month: ${parsed.month}` };
  if (parsed.day < 1 || parsed.day > 31) return { valid: false, error: `Invalid day: ${parsed.day}` };
  // Check days per month
  const maxDays = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (parsed.day > maxDays[parsed.month]) return { valid: false, error: `${parsed.month}/${parsed.day} is not a valid date` };
  return { valid: true, parsed };
};

/**
 * Find contacts whose date field matches a target month/day.
 * Logs skipped contacts for debugging.
 */
const findMatchingContacts = async (trigger, targetMonth, targetDay) => {
  const tenantId = trigger.tenant_id;
  const query = { tenant_id: tenantId };

  if (trigger.target_type === 'tags' && trigger.target_tags.length > 0) {
    query.$or = [{ labels: { $in: trigger.target_tags } }, { tags: { $in: trigger.target_tags } }];
  } else if (trigger.target_type === 'list' && trigger.target_list_id) {
    const list = await ContactList.findById(trigger.target_list_id).lean();
    if (list?.phones?.length) {
      query.phone = { $in: list.phones };
    } else {
      return [];
    }
  }

  const fieldPath = trigger.contact_field || 'birthday';
  const projection = { phone: 1, name: 1, wa_name: 1, email: 1, birthday: 1, custom_fields: 1, labels: 1, tags: 1 };
  const allContacts = await Contact.find(query).select(projection).lean();

  const matched = [];
  let noField = 0;
  let unparseable = 0;

  for (const c of allContacts) {
    const rawDate = getContactDateValue(c, fieldPath);
    if (!rawDate) { noField++; continue; }

    const md = extractMonthDay(rawDate);
    if (!md) {
      unparseable++;
      console.warn(`[DateTrigger] Cannot parse date "${rawDate}" for contact ${c.phone || c._id} (field: ${fieldPath})`);
      continue;
    }

    // Validate parsed values
    if (md.month < 1 || md.month > 12 || md.day < 1 || md.day > 31) {
      unparseable++;
      console.warn(`[DateTrigger] Invalid date month=${md.month} day=${md.day} from "${rawDate}" for contact ${c.phone || c._id}`);
      continue;
    }

    if (md.month === targetMonth && md.day === targetDay) {
      matched.push(c);
    }
  }

  if (unparseable > 0) {
    console.warn(`[DateTrigger] ${trigger.name}: ${unparseable} contacts had unparseable dates in ${fieldPath}. ${noField} contacts had no value.`);
  }

  return matched;
};

/**
 * Compute next_run_at for a trigger.
 */
const computeNextRunAt = (trigger) => {
  const now = new Date();
  const [hours, minutes] = (trigger.send_time || '09:00').split(':').map(Number);

  if (trigger.trigger_type === 'one_time' && trigger.one_time_date) {
    const d = new Date(trigger.one_time_date);
    d.setHours(hours, minutes, 0, 0);
    return d > now ? d : null;
  }

  const today = new Date();
  today.setHours(hours, minutes, 0, 0);
  if (today > now) return today;
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow;
};

/* ════════════════════════════════════════════════════════
   STATIC ROUTES — Must be BEFORE /:id routes
   ════════════════════════════════════════════════════════ */

/* ────────────────────────────────────────────────────────
   GET /contact-fields  — Available date-type fields
   ──────────────────────────────────────────────────────── */
router.get('/contact-fields', async (req, res) => {
  try {
    // Built-in date-capable fields
    const fields = [
      { value: 'birthday', label: 'Birthday', type: 'built-in' },
      { value: 'created_at', label: 'Contact Created Date', type: 'built-in' },
      { value: 'subscribed_at', label: 'Subscribed Date', type: 'built-in' },
    ];

    // Custom date fields from tenant's custom field definitions
    const customFields = await CustomFieldDefinition.find({
      tenant_id: req.tenant._id,
      field_type: 'date',
      is_active: true,
    })
      .sort({ sort_order: 1 })
      .lean();

    for (const cf of customFields) {
      fields.push({
        value: `custom_fields.${cf.field_name}`,
        label: cf.field_label,
        type: 'custom',
      });
    }

    // Also list ALL custom field definitions (any type) so frontend knows what's available
    const allCustomFields = await CustomFieldDefinition.find({
      tenant_id: req.tenant._id,
      is_active: true,
    })
      .sort({ sort_order: 1 })
      .lean();

    return apiResponse(res, {
      data: {
        fields,
        all_custom_fields: allCustomFields.map((cf) => ({
          value: `custom_fields.${cf.field_name}`,
          label: cf.field_label,
          type: cf.field_type,
        })),
      },
    });
  } catch (error) {
    console.error('[DateTriggers] Contact fields error:', error);
    return apiResponse(res, { status: 500, success: false, error: error.message });
  }
});

/* ────────────────────────────────────────────────────────
   POST /validate-field  — Check how many contacts have valid dates
   ──────────────────────────────────────────────────────── */
router.post('/validate-field', async (req, res) => {
  try {
    const { field_path, target_type, target_tags, target_list_id } = req.body;
    if (!field_path) return apiResponse(res, { status: 400, success: false, error: 'field_path is required' });

    const query = { tenant_id: req.tenant._id };
    if (target_type === 'tags' && Array.isArray(target_tags) && target_tags.length > 0) {
      query.$or = [{ labels: { $in: target_tags } }, { tags: { $in: target_tags } }];
    } else if (target_type === 'list' && target_list_id) {
      const list = await ContactList.findById(target_list_id).lean();
      if (list?.phones?.length) query.phone = { $in: list.phones };
      else return apiResponse(res, { data: { total: 0, with_field: 0, valid_dates: 0, invalid_dates: 0, samples: [] } });
    }

    const contacts = await Contact.find(query).select({ phone: 1, name: 1, birthday: 1, custom_fields: 1 }).lean();

    let withField = 0, validDates = 0, invalidDates = 0;
    const invalidSamples = [];
    const validSamples = [];

    for (const c of contacts) {
      const raw = getContactDateValue(c, field_path);
      if (!raw) continue;
      withField++;
      const result = validateDateValue(raw);
      if (result.valid) {
        validDates++;
        if (validSamples.length < 3) validSamples.push({ phone: c.phone, name: c.name, raw_value: String(raw), parsed: `${result.parsed.month}/${result.parsed.day}` });
      } else {
        invalidDates++;
        if (invalidSamples.length < 5) invalidSamples.push({ phone: c.phone, name: c.name, raw_value: String(raw), error: result.error });
      }
    }

    return apiResponse(res, {
      data: {
        total: contacts.length,
        with_field: withField,
        valid_dates: validDates,
        invalid_dates: invalidDates,
        valid_samples: validSamples,
        invalid_samples: invalidSamples,
      },
    });
  } catch (error) {
    console.error('[DateTriggers] Validate field error:', error);
    return apiResponse(res, { status: 500, success: false, error: error.message });
  }
});

/* ────────────────────────────────────────────────────────
   GET /logs/history  — Execution logs for tenant
   ──────────────────────────────────────────────────────── */
router.get('/logs/history', async (req, res) => {
  try {
    const page = parsePositiveInt(req.query.page, 1);
    const limit = Math.min(parsePositiveInt(req.query.limit, 30), 100);
    const skip = (page - 1) * limit;

    const filter = { tenant_id: req.tenant._id };
    if (req.query.trigger_id) {
      if (!isValidObjectId(req.query.trigger_id)) {
        return apiResponse(res, { status: 400, success: false, error: 'Invalid trigger ID' });
      }
      filter.trigger_id = req.query.trigger_id;
    }

    const [logs, total] = await Promise.all([
      DateTriggerLog.find(filter).sort({ created_at: -1 }).skip(skip).limit(limit).lean(),
      DateTriggerLog.countDocuments(filter),
    ]);

    return apiResponse(res, {
      data: { logs },
      meta: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('[DateTriggers] Logs error:', error);
    return apiResponse(res, { status: 500, success: false, error: error.message });
  }
});

/* ════════════════════════════════════════════════════════
   MAIN CRUD ROUTES
   ════════════════════════════════════════════════════════ */

/* ── GET /  — List all date triggers ── */
router.get('/', async (req, res) => {
  try {
    const page = parsePositiveInt(req.query.page, 1);
    const limit = Math.min(parsePositiveInt(req.query.limit, 50), 100);
    const skip = (page - 1) * limit;

    const [triggers, total] = await Promise.all([
      DateTrigger.find({ tenant_id: req.tenant._id })
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      DateTrigger.countDocuments({ tenant_id: req.tenant._id }),
    ]);

    const triggerIds = triggers.map((t) => t._id);
    const recentLogs = triggerIds.length
      ? await DateTriggerLog.find({ trigger_id: { $in: triggerIds } })
          .sort({ created_at: -1 })
          .limit(triggerIds.length * 3)
          .lean()
      : [];

    const logsByTrigger = {};
    for (const log of recentLogs) {
      const tid = String(log.trigger_id);
      if (!logsByTrigger[tid]) logsByTrigger[tid] = [];
      if (logsByTrigger[tid].length < 3) logsByTrigger[tid].push(log);
    }

    const enriched = triggers.map((t) => ({
      ...t,
      recent_logs: logsByTrigger[String(t._id)] || [],
    }));

    return apiResponse(res, {
      data: { triggers: enriched },
      meta: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('[DateTriggers] List error:', error);
    return apiResponse(res, { status: 500, success: false, error: error.message });
  }
});

/* ── POST /  — Create date trigger ── */
router.post('/', async (req, res) => {
  try {
    const {
      name, description, trigger_type, contact_field, offset_days,
      send_time, timezone, one_time_date, cron_expression,
      template_name, template_language, template_header_type,
      template_header_media_url, variable_mapping,
      target_type, target_tags, target_list_id, active,
    } = req.body;

    // ── Strict validation ─────────────────────────────
    const errors = [];
    if (!name?.trim()) errors.push('Name is required');
    if (!trigger_type) errors.push('Trigger type is required');
    if (!template_name?.trim()) errors.push('Template is required');

    if (trigger_type === 'cron') {
      if (!cron_expression?.trim()) errors.push('Cron expression is required for cron type');
    } else {
      if (!contact_field?.trim()) errors.push('Contact date field is required');
      if (!send_time?.trim()) errors.push('Send time is required');
    }

    if (trigger_type === 'one_time' && !one_time_date) {
      errors.push('Date is required for one-time triggers');
    }

    if (target_type === 'tags' && (!Array.isArray(target_tags) || target_tags.length === 0)) {
      errors.push('At least one tag is required when targeting by tags');
    }

    if (target_type === 'list' && !target_list_id) {
      errors.push('Contact list is required when targeting by list');
    }

    if (errors.length > 0) {
      return apiResponse(res, { status: 400, success: false, error: errors.join('. ') });
    }

    // ── Validate template exists in Meta ─────────────
    try {
      const { wa, accessToken } = await getWAAccount(req.tenant._id);
      const templates = await metaService.getTemplates(wa.waba_id, accessToken);
      const found = (templates || []).find(
        (t) => t.name === template_name.trim() && t.status === 'APPROVED'
      );
      if (!found) {
        return apiResponse(res, {
          status: 400,
          success: false,
          error: `Template "${template_name}" not found or not approved. Only approved templates can be used.`,
        });
      }
    } catch (err) {
      console.warn('[DateTriggers] Template validation skipped:', err.message);
    }

    // ── Validate cron expression ─────────────────────
    if (cron_expression?.trim()) {
      try {
        const cronParser = require('cron-parser');
        cronParser.parseExpression(cron_expression.trim());
      } catch {
        return apiResponse(res, { status: 400, success: false, error: 'Invalid cron expression. Format: minute hour dayOfMonth month dayOfWeek' });
      }
    }

    const trigger = await DateTrigger.create({
      tenant_id: req.tenant._id,
      name: name.trim(),
      description: (description || '').trim(),
      trigger_type: trigger_type || 'birthday',
      contact_field: contact_field || 'birthday',
      offset_days: Number.isFinite(Number(offset_days)) ? Number(offset_days) : 0,
      send_time: send_time || '09:00',
      timezone: timezone || 'Asia/Kolkata',
      one_time_date: one_time_date || null,
      cron_expression: (cron_expression || '').trim(),
      template_name: template_name.trim(),
      template_language: (template_language || 'en').trim(),
      template_header_type: template_header_type || 'none',
      template_header_media_url: (template_header_media_url || '').trim(),
      variable_mapping: Array.isArray(variable_mapping) ? variable_mapping : [],
      target_type: target_type || 'all',
      target_tags: Array.isArray(target_tags) ? target_tags : [],
      target_list_id: target_list_id || null,
      active: active !== false,
      created_by: req.user._id,
    });

    trigger.next_run_at = computeNextRunAt(trigger);
    await trigger.save();

    return apiResponse(res, { status: 201, data: { trigger } });
  } catch (error) {
    console.error('[DateTriggers] Create error:', error);
    if (error.name === 'ValidationError') {
      const msgs = Object.values(error.errors).map((e) => e.message).join('. ');
      return apiResponse(res, { status: 400, success: false, error: msgs });
    }
    return apiResponse(res, { status: 500, success: false, error: error.message });
  }
});

/* ── GET /:id  — Get single trigger ── */
router.get('/:id', async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return apiResponse(res, { status: 400, success: false, error: 'Invalid trigger ID' });
    }

    const trigger = await DateTrigger.findOne({
      _id: req.params.id,
      tenant_id: req.tenant._id,
    }).lean();

    if (!trigger) {
      return apiResponse(res, { status: 404, success: false, error: 'Date trigger not found' });
    }

    const logs = await DateTriggerLog.find({ trigger_id: trigger._id })
      .sort({ created_at: -1 })
      .limit(20)
      .lean();

    return apiResponse(res, { data: { trigger, logs } });
  } catch (error) {
    console.error('[DateTriggers] Get error:', error);
    return apiResponse(res, { status: 500, success: false, error: error.message });
  }
});

/* ── PUT /:id  — Update trigger ── */
router.put('/:id', async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return apiResponse(res, { status: 400, success: false, error: 'Invalid trigger ID' });
    }

    const trigger = await DateTrigger.findOne({
      _id: req.params.id,
      tenant_id: req.tenant._id,
    });

    if (!trigger) {
      return apiResponse(res, { status: 404, success: false, error: 'Date trigger not found' });
    }

    // Validation for updates
    const errors = [];
    if (req.body.name !== undefined && !req.body.name?.trim()) errors.push('Name cannot be empty');
    if (req.body.template_name !== undefined && !req.body.template_name?.trim()) errors.push('Template cannot be empty');
    if (req.body.trigger_type === 'cron' && req.body.cron_expression !== undefined && !req.body.cron_expression?.trim()) {
      errors.push('Cron expression is required for cron type');
    }
    if (req.body.target_type === 'tags' && Array.isArray(req.body.target_tags) && req.body.target_tags.length === 0) {
      errors.push('At least one tag is required');
    }
    if (errors.length > 0) {
      return apiResponse(res, { status: 400, success: false, error: errors.join('. ') });
    }

    const allowedFields = [
      'name', 'description', 'active', 'trigger_type', 'contact_field',
      'offset_days', 'send_time', 'timezone', 'one_time_date', 'cron_expression',
      'template_name', 'template_language', 'template_header_type',
      'template_header_media_url', 'variable_mapping',
      'target_type', 'target_tags', 'target_list_id',
    ];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        trigger[field] = req.body[field];
      }
    }

    trigger.updated_by = req.user._id;
    trigger.next_run_at = computeNextRunAt(trigger);

    if (req.body.cron_expression?.trim()) {
      try {
        const cronParser = require('cron-parser');
        cronParser.parseExpression(req.body.cron_expression.trim());
      } catch {
        return apiResponse(res, { status: 400, success: false, error: 'Invalid cron expression' });
      }
    }

    await trigger.save();

    return apiResponse(res, { data: { trigger } });
  } catch (error) {
    console.error('[DateTriggers] Update error:', error);
    return apiResponse(res, { status: 500, success: false, error: error.message });
  }
});

/* ── DELETE /:id ── */
router.delete('/:id', async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return apiResponse(res, { status: 400, success: false, error: 'Invalid trigger ID' });
    }

    const result = await DateTrigger.findOneAndDelete({
      _id: req.params.id,
      tenant_id: req.tenant._id,
    });

    if (!result) {
      return apiResponse(res, { status: 404, success: false, error: 'Date trigger not found' });
    }

    await DateTriggerLog.deleteMany({ trigger_id: req.params.id }).catch(() => {});
    return apiResponse(res, { data: { message: 'Date trigger deleted' } });
  } catch (error) {
    console.error('[DateTriggers] Delete error:', error);
    return apiResponse(res, { status: 500, success: false, error: error.message });
  }
});

/* ── POST /:id/toggle ── */
router.post('/:id/toggle', async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return apiResponse(res, { status: 400, success: false, error: 'Invalid trigger ID' });
    }

    const trigger = await DateTrigger.findOne({
      _id: req.params.id,
      tenant_id: req.tenant._id,
    });

    if (!trigger) {
      return apiResponse(res, { status: 404, success: false, error: 'Date trigger not found' });
    }

    trigger.active = !trigger.active;
    trigger.updated_by = req.user._id;
    if (trigger.active) trigger.next_run_at = computeNextRunAt(trigger);
    await trigger.save();

    return apiResponse(res, { data: { trigger } });
  } catch (error) {
    console.error('[DateTriggers] Toggle error:', error);
    return apiResponse(res, { status: 500, success: false, error: error.message });
  }
});

/* ── POST /:id/test  — Dry-run ── */
router.post('/:id/test', async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return apiResponse(res, { status: 400, success: false, error: 'Invalid trigger ID' });
    }

    const trigger = await DateTrigger.findOne({
      _id: req.params.id,
      tenant_id: req.tenant._id,
    }).lean();

    if (!trigger) {
      return apiResponse(res, { status: 404, success: false, error: 'Date trigger not found' });
    }

    const now = new Date();
    const targetDate = new Date(now);
    targetDate.setDate(targetDate.getDate() - (trigger.offset_days || 0));
    const targetMonth = targetDate.getMonth() + 1;
    const targetDay = targetDate.getDate();

    // Get total contacts for this target
    const fieldPath = trigger.contact_field || 'birthday';
    const targetQuery = { tenant_id: req.tenant._id };
    if (trigger.target_type === 'tags' && trigger.target_tags?.length) {
      targetQuery.$or = [{ labels: { $in: trigger.target_tags } }, { tags: { $in: trigger.target_tags } }];
    } else if (trigger.target_type === 'list' && trigger.target_list_id) {
      const list = await ContactList.findById(trigger.target_list_id).lean();
      if (list?.phones?.length) targetQuery.phone = { $in: list.phones };
    }
    const totalContacts = await Contact.countDocuments(targetQuery);

    // Count contacts with the field populated
    const allForDiag = await Contact.find(targetQuery).select({ phone: 1, birthday: 1, custom_fields: 1 }).lean();
    let withField = 0, validDates = 0, invalidDates = 0;
    for (const c of allForDiag) {
      const raw = getContactDateValue(c, fieldPath);
      if (!raw) continue;
      withField++;
      const vr = validateDateValue(raw);
      if (vr.valid) validDates++; else invalidDates++;
    }

    const matched = await findMatchingContacts(trigger, targetMonth, targetDay);

    return apiResponse(res, {
      data: {
        trigger_name: trigger.name,
        target_date: `${targetMonth}/${targetDay}`,
        looking_for: fieldPath,
        offset_days: trigger.offset_days,
        matched_count: matched.length,
        diagnostics: {
          total_contacts: totalContacts,
          with_date_field: withField,
          valid_dates: validDates,
          invalid_dates: invalidDates,
          without_field: totalContacts - withField,
        },
        contacts: matched.slice(0, 50).map((c) => ({
          _id: c._id,
          phone: c.phone,
          name: c.name || c.wa_name || '',
          email: c.email || '',
          field_value: getContactDateValue(c, fieldPath),
        })),
        template_name: trigger.template_name,
      },
    });
  } catch (error) {
    console.error('[DateTriggers] Test error:', error);
    return apiResponse(res, { status: 500, success: false, error: error.message });
  }
});

module.exports = router;

// Export helpers for use by the execution service
module.exports.findMatchingContacts = findMatchingContacts;
module.exports.getContactDateValue = getContactDateValue;
module.exports.extractMonthDay = extractMonthDay;
module.exports.validateDateValue = validateDateValue;
module.exports.computeNextRunAt = computeNextRunAt;
