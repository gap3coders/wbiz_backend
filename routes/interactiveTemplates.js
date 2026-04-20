const express = require('express');
const { authenticate, requireStatus } = require('../middleware/auth');
const InteractiveTemplate = require('../models/InteractiveTemplate');
const { apiResponse } = require('../utils/helpers');

const router = express.Router();
router.use(authenticate, requireStatus('active'));

// ─── LIST ────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { type, search, active } = req.query;
    const filter = { tenant_id: req.user.tenant_id };
    if (type) filter.type = type;
    if (active !== undefined) filter.active = active === 'true';
    if (search) filter.name = { $regex: search, $options: 'i' };

    const templates = await InteractiveTemplate.find(filter)
      .sort({ created_at: -1 })
      .lean();

    return apiResponse(res, {
      data: {
        templates,
        counts: {
          total: templates.length,
          button: templates.filter((t) => t.type === 'button').length,
          list: templates.filter((t) => t.type === 'list').length,
          product: templates.filter((t) => t.type === 'product').length,
          product_list: templates.filter((t) => t.type === 'product_list').length,
          poll: templates.filter((t) => t.type === 'poll').length,
        },
      },
    });
  } catch (error) {
    console.error('List interactive templates error:', error);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to list templates' });
  }
});

// ─── GET ONE ─────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const template = await InteractiveTemplate.findOne({
      _id: req.params.id,
      tenant_id: req.user.tenant_id,
    }).lean();
    if (!template) return apiResponse(res, { status: 404, success: false, error: 'Template not found' });
    return apiResponse(res, { data: { template } });
  } catch (error) {
    return apiResponse(res, { status: 500, success: false, error: 'Failed to fetch template' });
  }
});

// ─── CREATE ──────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { name, type } = req.body;
    if (!name || !name.trim()) return apiResponse(res, { status: 400, success: false, error: 'Name is required' });
    if (!type) return apiResponse(res, { status: 400, success: false, error: 'Type is required' });

    const template = await InteractiveTemplate.create({
      tenant_id: req.user.tenant_id,
      created_by: req.user._id,
      ...req.body,
      name: name.trim(),
    });

    return apiResponse(res, { status: 201, data: { template } });
  } catch (error) {
    console.error('Create interactive template error:', error);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to create template' });
  }
});

// ─── UPDATE ──────────────────────────────────────────────
router.patch('/:id', async (req, res) => {
  try {
    const template = await InteractiveTemplate.findOneAndUpdate(
      { _id: req.params.id, tenant_id: req.user.tenant_id },
      { $set: req.body },
      { new: true },
    );
    if (!template) return apiResponse(res, { status: 404, success: false, error: 'Template not found' });
    return apiResponse(res, { data: { template } });
  } catch (error) {
    return apiResponse(res, { status: 500, success: false, error: 'Failed to update template' });
  }
});

// ─── DELETE ──────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const result = await InteractiveTemplate.findOneAndDelete({
      _id: req.params.id,
      tenant_id: req.user.tenant_id,
    });
    if (!result) return apiResponse(res, { status: 404, success: false, error: 'Template not found' });
    return apiResponse(res, { data: { message: 'Template deleted' } });
  } catch (error) {
    return apiResponse(res, { status: 500, success: false, error: 'Failed to delete template' });
  }
});

// ─── DUPLICATE ───────────────────────────────────────────
router.post('/:id/duplicate', async (req, res) => {
  try {
    const source = await InteractiveTemplate.findOne({
      _id: req.params.id,
      tenant_id: req.user.tenant_id,
    }).lean();
    if (!source) return apiResponse(res, { status: 404, success: false, error: 'Template not found' });

    delete source._id;
    delete source.created_at;
    delete source.updated_at;
    source.name = `${source.name} (Copy)`;
    source.times_sent = 0;
    source.last_sent_at = null;

    const copy = await InteractiveTemplate.create(source);
    return apiResponse(res, { status: 201, data: { template: copy } });
  } catch (error) {
    return apiResponse(res, { status: 500, success: false, error: 'Failed to duplicate template' });
  }
});

module.exports = router;
