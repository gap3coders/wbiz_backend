const express = require('express');
const { authenticate, requireStatus } = require('../middleware/auth');
const CustomFieldDefinition = require('../models/CustomFieldDefinition');
const Contact = require('../models/Contact');
const { apiResponse } = require('../utils/helpers');

const router = express.Router();

const generateFieldName = (label) =>
  String(label || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');

/* ── LIST all custom field definitions ────────────────────── */
router.get('/', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const fields = await CustomFieldDefinition.find({ tenant_id: req.tenant._id })
      .sort({ sort_order: 1 })
      .lean();

    return apiResponse(res, { data: { fields } });
  } catch (error) {
    console.error('[CustomFields][List]', {
      tenant_id: String(req.tenant?._id || ''),
      error: error.message,
      stack: error.stack,
    });
    return apiResponse(res, { status: 500, success: false, error: 'Failed to fetch custom fields' });
  }
});

/* ── CREATE a new field definition ────────────────────────── */
router.post('/', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { field_label, field_type, options, is_required, placeholder, default_value, sort_order } = req.body;

    if (!field_label || !String(field_label).trim()) {
      return apiResponse(res, { status: 400, success: false, error: 'field_label is required' });
    }

    const field_name = req.body.field_name
      ? generateFieldName(req.body.field_name)
      : generateFieldName(field_label);

    if (!field_name) {
      return apiResponse(res, { status: 400, success: false, error: 'Unable to generate a valid field_name' });
    }

    const existing = await CustomFieldDefinition.findOne({
      tenant_id: req.tenant._id,
      field_name,
    }).lean();

    if (existing) {
      return apiResponse(res, { status: 409, success: false, error: `Field name "${field_name}" already exists` });
    }

    const field = await CustomFieldDefinition.create({
      tenant_id: req.tenant._id,
      field_name,
      field_label: String(field_label).trim(),
      field_type: field_type || 'text',
      options: Array.isArray(options) ? options : [],
      is_required: is_required || false,
      placeholder: placeholder || '',
      default_value: default_value !== undefined ? default_value : null,
      sort_order: sort_order || 0,
      created_by: req.user?._id || null,
    });

    return apiResponse(res, { status: 201, data: { field } });
  } catch (error) {
    console.error('[CustomFields][Create]', {
      tenant_id: String(req.tenant?._id || ''),
      body: req.body,
      error: error.message,
      stack: error.stack,
    });
    return apiResponse(res, { status: 500, success: false, error: 'Failed to create custom field' });
  }
});

/* ── UPDATE a field definition ────────────────────────────── */
router.put('/:id', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const fieldDef = await CustomFieldDefinition.findOne({
      _id: req.params.id,
      tenant_id: req.tenant._id,
    });

    if (!fieldDef) {
      return apiResponse(res, { status: 404, success: false, error: 'Custom field not found' });
    }

    // Don't allow changing field_name if contacts are using it
    if (req.body.field_name && req.body.field_name !== fieldDef.field_name) {
      const contactsUsingField = await Contact.countDocuments({
        tenant_id: req.tenant._id,
        [`custom_fields.${fieldDef.field_name}`]: { $exists: true },
      });

      if (contactsUsingField > 0) {
        return apiResponse(res, {
          status: 400,
          success: false,
          error: `Cannot rename field_name: ${contactsUsingField} contact(s) are using this field`,
        });
      }
    }

    const allowedFields = [
      'field_name', 'field_label', 'field_type', 'options',
      'is_required', 'placeholder', 'default_value', 'sort_order', 'is_active',
    ];

    for (const key of allowedFields) {
      if (req.body[key] !== undefined) {
        fieldDef[key] = key === 'field_name' ? generateFieldName(req.body[key]) : req.body[key];
      }
    }

    await fieldDef.save();

    return apiResponse(res, { data: { field: fieldDef.toObject() } });
  } catch (error) {
    console.error('[CustomFields][Update]', {
      tenant_id: String(req.tenant?._id || ''),
      field_id: req.params.id,
      body: req.body,
      error: error.message,
      stack: error.stack,
    });
    return apiResponse(res, { status: 500, success: false, error: 'Failed to update custom field' });
  }
});

/* ── DELETE a field definition ─────────────────────────────── */
router.delete('/:id', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const fieldDef = await CustomFieldDefinition.findOne({
      _id: req.params.id,
      tenant_id: req.tenant._id,
    });

    if (!fieldDef) {
      return apiResponse(res, { status: 404, success: false, error: 'Custom field not found' });
    }

    // Unset the field from all contacts' custom_fields
    const updateResult = await Contact.updateMany(
      { tenant_id: req.tenant._id, [`custom_fields.${fieldDef.field_name}`]: { $exists: true } },
      { $unset: { [`custom_fields.${fieldDef.field_name}`]: '' } }
    );

    await CustomFieldDefinition.deleteOne({ _id: fieldDef._id });

    return apiResponse(res, {
      data: {
        message: `Field "${fieldDef.field_label}" deleted`,
        contacts_updated: updateResult.modifiedCount || 0,
      },
    });
  } catch (error) {
    console.error('[CustomFields][Delete]', {
      tenant_id: String(req.tenant?._id || ''),
      field_id: req.params.id,
      error: error.message,
      stack: error.stack,
    });
    return apiResponse(res, { status: 500, success: false, error: 'Failed to delete custom field' });
  }
});

/* ── REORDER field definitions (bulk sort_order update) ───── */
router.post('/reorder', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { fields } = req.body;

    if (!Array.isArray(fields) || !fields.length) {
      return apiResponse(res, { status: 400, success: false, error: 'fields array is required' });
    }

    const ops = fields.map((item) => ({
      updateOne: {
        filter: { _id: item.id, tenant_id: req.tenant._id },
        update: { $set: { sort_order: item.sort_order } },
      },
    }));

    const result = await CustomFieldDefinition.bulkWrite(ops);

    return apiResponse(res, {
      data: {
        matched: result.matchedCount || 0,
        modified: result.modifiedCount || 0,
      },
    });
  } catch (error) {
    console.error('[CustomFields][Reorder]', {
      tenant_id: String(req.tenant?._id || ''),
      error: error.message,
      stack: error.stack,
    });
    return apiResponse(res, { status: 500, success: false, error: 'Failed to reorder custom fields' });
  }
});

/* ── BULK CREATE fields (CSV import auto-detect) ──────────── */
router.post('/bulk-create', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { fields } = req.body;

    if (!Array.isArray(fields) || !fields.length) {
      return apiResponse(res, { status: 400, success: false, error: 'fields array is required' });
    }

    const created = [];
    const skipped = [];

    for (const item of fields) {
      const label = String(item.field_label || '').trim();
      if (!label) {
        skipped.push({ field_label: item.field_label, reason: 'Empty field_label' });
        continue;
      }

      const fieldName = generateFieldName(label);
      if (!fieldName) {
        skipped.push({ field_label: label, reason: 'Unable to generate field_name' });
        continue;
      }

      const existing = await CustomFieldDefinition.findOne({
        tenant_id: req.tenant._id,
        field_name: fieldName,
      }).lean();

      if (existing) {
        skipped.push({ field_label: label, field_name: fieldName, reason: 'Already exists' });
        continue;
      }

      const field = await CustomFieldDefinition.create({
        tenant_id: req.tenant._id,
        field_name: fieldName,
        field_label: label,
        field_type: item.field_type || 'text',
        created_by: req.user?._id || null,
      });

      created.push(field);
    }

    return apiResponse(res, {
      data: {
        created: created.length,
        skipped: skipped.length,
        fields: created,
      },
    });
  } catch (error) {
    console.error('[CustomFields][BulkCreate]', {
      tenant_id: String(req.tenant?._id || ''),
      error: error.message,
      stack: error.stack,
    });
    return apiResponse(res, { status: 500, success: false, error: 'Failed to bulk create custom fields' });
  }
});

module.exports = router;
