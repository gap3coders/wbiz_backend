const express = require('express');
const { authenticate, requireStatus } = require('../middleware/auth');
const Notification = require('../models/Notification');
const { apiResponse } = require('../utils/helpers');

const router = express.Router();

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const notificationKey = (notification = {}) =>
  [
    notification.type || '',
    notification.source || '',
    notification.title || '',
    notification.message || '',
    notification.link || '',
  ].join('|');

const dedupeNotifications = (items = []) => {
  const groups = new Map();

  items.forEach((item) => {
    const key = notificationKey(item);
    const existing = groups.get(key);

    if (!existing) {
      groups.set(key, {
        ...item,
        duplicate_count: 1,
        duplicate_ids: [String(item._id)],
      });
      return;
    }

    existing.duplicate_count += 1;
    existing.duplicate_ids.push(String(item._id));
    existing.read = existing.read && Boolean(item.read);

    if (new Date(item.created_at).getTime() > new Date(existing.created_at).getTime()) {
      existing._id = item._id;
      existing.created_at = item.created_at;
      existing.updated_at = item.updated_at;
      existing.meta_data = item.meta_data;
    }
  });

  return Array.from(groups.values()).sort(
    (left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime()
  );
};

router.get('/', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const unreadOnly = req.query.unread_only === 'true';
    const page = parsePositiveInt(req.query.page, 1);
    const limit = Math.min(parsePositiveInt(req.query.limit, 30), 100);
    const filter = { tenant_id: req.tenant._id };

    if (unreadOnly) filter.read = false;

    const rawLimit = Math.min(limit * 8, 400);
    const rawItems = await Notification.find(filter).sort({ created_at: -1 }).limit(rawLimit).lean();
    const uniqueItems = dedupeNotifications(rawItems);
    const startIndex = (page - 1) * limit;
    const pagedItems = uniqueItems.slice(startIndex, startIndex + limit);
    const unreadCount = dedupeNotifications(
      await Notification.find({ tenant_id: req.tenant._id, read: false }).sort({ created_at: -1 }).limit(400).lean()
    ).length;

    return apiResponse(res, {
      data: {
        notifications: pagedItems,
        total: uniqueItems.length,
        unread_count: unreadCount,
      },
    });
  } catch (error) {
    console.error('[Notifications Route][List Failed]', {
      tenant_id: String(req.tenant?._id || ''),
      error: error.message,
    });
    return apiResponse(res, { status: 500, success: false, error: 'Failed' });
  }
});

router.get('/unread-count', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const unreadItems = await Notification.find({ tenant_id: req.tenant._id, read: false })
      .sort({ created_at: -1 })
      .limit(400)
      .lean();
    const count = dedupeNotifications(unreadItems).length;
    return apiResponse(res, { data: { count } });
  } catch (error) {
    console.error('[Notifications Route][Unread Count Failed]', {
      tenant_id: String(req.tenant?._id || ''),
      error: error.message,
    });
    return apiResponse(res, { status: 500, success: false, error: 'Failed' });
  }
});

router.post('/mark-read', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (ids.length) {
      await Notification.updateMany({ _id: { $in: ids }, tenant_id: req.tenant._id }, { read: true });
    } else {
      await Notification.updateMany({ tenant_id: req.tenant._id, read: false }, { read: true });
    }
    return apiResponse(res, { data: { message: 'Marked as read' } });
  } catch (error) {
    console.error('[Notifications Route][Mark Read Failed]', {
      tenant_id: String(req.tenant?._id || ''),
      error: error.message,
    });
    return apiResponse(res, { status: 500, success: false, error: 'Failed' });
  }
});

router.delete('/:id', authenticate, requireStatus('active'), async (req, res) => {
  try {
    await Notification.findOneAndDelete({ _id: req.params.id, tenant_id: req.tenant._id });
    return apiResponse(res, { data: { message: 'Deleted' } });
  } catch (error) {
    console.error('[Notifications Route][Delete Failed]', {
      tenant_id: String(req.tenant?._id || ''),
      notification_id: req.params.id,
      error: error.message,
    });
    return apiResponse(res, { status: 500, success: false, error: 'Failed' });
  }
});

module.exports = router;
