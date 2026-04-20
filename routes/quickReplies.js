const express = require('express');
const { authenticate, requireStatus } = require('../middleware/auth');
const QuickReply = require('../models/QuickReply');
const { apiResponse } = require('../utils/helpers');

const router = express.Router();

const parsePositiveInt = (v, fb) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fb;
};

/* ── LIST ─────────────────────────────────────────────── */
router.get('/', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const page = parsePositiveInt(req.query.page, 1);
    const limit = Math.min(parsePositiveInt(req.query.limit, 50), 200);
    const filter = { tenant_id: req.tenant._id };

    if (req.query.category && req.query.category !== 'all') {
      filter.category = req.query.category;
    }
    if (req.query.search) {
      const regex = new RegExp(req.query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ title: regex }, { shortcut: regex }, { message: regex }];
    }

    const total = await QuickReply.countDocuments(filter);
    const items = await QuickReply.find(filter)
      .sort({ use_count: -1, created_at: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const summary = await QuickReply.aggregate([
      { $match: { tenant_id: req.tenant._id } },
      { $group: { _id: '$category', count: { $sum: 1 }, total_uses: { $sum: '$use_count' } } },
    ]);

    return apiResponse(res, {
      data: {
        quick_replies: items,
        total,
        page,
        pages: Math.ceil(total / limit),
        summary: summary.reduce((acc, s) => {
          acc[s._id] = { count: s.count, total_uses: s.total_uses };
          return acc;
        }, {}),
      },
    });
  } catch (error) {
    console.error('[QuickReplies][List]', { tenant_id: String(req.tenant?._id), error: error.message });
    return apiResponse(res, { status: 500, success: false, error: 'Failed to fetch quick replies' });
  }
});

/* ── SEARCH (for / shortcut popup) ───────────────────── */
router.get('/search/shortcut', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    const filter = {
      tenant_id: req.tenant._id,
      $or: [{ is_global: true }, { user_id: req.user._id }],
    };

    if (q) {
      const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$and = [{ $or: [{ shortcut: regex }, { title: regex }, { message: regex }] }];
    }

    const items = await QuickReply.find(filter)
      .sort({ use_count: -1, created_at: -1 })
      .limit(10)
      .select('title shortcut message category media_url media_type')
      .lean();

    return apiResponse(res, { data: { quick_replies: items } });
  } catch (error) {
    console.error('[QuickReplies][Search]', { error: error.message });
    return apiResponse(res, { status: 500, success: false, error: 'Search failed' });
  }
});

/* ── GET ONE ──────────────────────────────────────────── */
router.get('/:id', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const item = await QuickReply.findOne({ _id: req.params.id, tenant_id: req.tenant._id }).lean();
    if (!item) return apiResponse(res, { status: 404, success: false, error: 'Quick reply not found' });
    return apiResponse(res, { data: { quick_reply: item } });
  } catch (error) {
    console.error('[QuickReplies][Get]', { id: req.params.id, error: error.message });
    return apiResponse(res, { status: 500, success: false, error: 'Failed to fetch quick reply' });
  }
});

/* ── CREATE ───────────────────────────────────────────── */
router.post('/', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { title, shortcut, message, category, media_url, media_type, is_global } = req.body;
    if (!title || !message) {
      return apiResponse(res, { status: 400, success: false, error: 'Title and message are required' });
    }

    const item = await QuickReply.create({
      tenant_id: req.tenant._id,
      user_id: req.user._id,
      title: title.trim(),
      shortcut: (shortcut || '').trim(),
      message: message.trim(),
      category: category || 'general',
      media_url: media_url || null,
      media_type: media_type || null,
      is_global: is_global !== false,
    });

    return apiResponse(res, { status: 201, data: { quick_reply: item.toObject() } });
  } catch (error) {
    console.error('[QuickReplies][Create]', { tenant_id: String(req.tenant?._id), error: error.message });
    return apiResponse(res, { status: 500, success: false, error: 'Failed to create quick reply' });
  }
});

/* ── UPDATE ───────────────────────────────────────────── */
router.put('/:id', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const allowed = ['title', 'shortcut', 'message', 'category', 'media_url', 'media_type', 'is_global'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    const item = await QuickReply.findOneAndUpdate(
      { _id: req.params.id, tenant_id: req.tenant._id },
      updates,
      { new: true, runValidators: true },
    );

    if (!item) return apiResponse(res, { status: 404, success: false, error: 'Quick reply not found' });
    return apiResponse(res, { data: { quick_reply: item.toObject() } });
  } catch (error) {
    console.error('[QuickReplies][Update]', { id: req.params.id, error: error.message });
    return apiResponse(res, { status: 500, success: false, error: 'Failed to update quick reply' });
  }
});

/* ── INCREMENT USE COUNT ──────────────────────────────── */
router.post('/:id/use', authenticate, requireStatus('active'), async (req, res) => {
  try {
    await QuickReply.updateOne(
      { _id: req.params.id, tenant_id: req.tenant._id },
      { $inc: { use_count: 1 } },
    );
    return apiResponse(res, { data: { message: 'Use count incremented' } });
  } catch (error) {
    return apiResponse(res, { status: 500, success: false, error: 'Failed' });
  }
});

/* ── DELETE ────────────────────────────────────────────── */
router.delete('/:id', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const item = await QuickReply.findOneAndDelete({ _id: req.params.id, tenant_id: req.tenant._id });
    if (!item) return apiResponse(res, { status: 404, success: false, error: 'Quick reply not found' });
    return apiResponse(res, { data: { message: 'Deleted' } });
  } catch (error) {
    console.error('[QuickReplies][Delete]', { id: req.params.id, error: error.message });
    return apiResponse(res, { status: 500, success: false, error: 'Failed to delete quick reply' });
  }
});

module.exports = router;
