const express = require('express');
const { authenticate, requireStatus } = require('../middleware/auth');
const Message = require('../models/Message');
const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const WebhookEvent = require('../models/WebhookEvent');
const { apiResponse } = require('../utils/helpers');

const router = express.Router();

const normalizePhone = (value) => String(value || '').replace(/[^\d]/g, '');
const escapeRegex = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const findMatchingContactPhones = async (tenantId, search = '') => {
  const searchValue = String(search || '').trim();
  if (!searchValue) return [];

  const regex = { $regex: escapeRegex(searchValue), $options: 'i' };
  const digits = searchValue.replace(/[^\d]/g, '');
  const digitRegex = digits ? { $regex: escapeRegex(digits), $options: 'i' } : null;
  const matchingContacts = await Contact.find({
    tenant_id: tenantId,
    $or: [
      { name: regex },
      { wa_name: regex },
      { profile_name: regex },
      { email: regex },
      { labels: regex },
      { tags: regex },
      { phone: regex },
      { whatsapp_id: regex },
      ...(digitRegex ? [{ phone: digitRegex }, { whatsapp_id: digitRegex }] : []),
    ],
  })
    .select('phone')
    .lean();

  return Array.from(new Set(matchingContacts.map((contact) => normalizePhone(contact.phone)).filter(Boolean)));
};

const buildConversationPipeline = ({ tenantId, searchRegex = null, matchingPhones = [], unreadOnly = false } = {}) => {
  const pipeline = [
    { $match: { tenant_id: tenantId } },
    { $sort: { timestamp: -1, _id: -1 } },
    {
      $group: {
        _id: '$contact_phone',
        contact_name: { $first: '$contact_name' },
        contact_phone: { $first: '$contact_phone' },
        last_message: { $first: '$content' },
        last_message_type: { $first: '$message_type' },
        last_message_direction: { $first: '$direction' },
        last_message_status: { $first: '$status' },
        last_message_at: { $first: '$timestamp' },
        last_template_name: { $first: '$template_name' },
        last_media_url: { $first: '$media_url' },
        last_media_id: { $first: '$media_id' },
        last_media_filename: { $first: '$media_filename' },
        last_message_source: { $first: '$message_source' },
        last_interactive_payload: { $first: '$interactive_payload' },
        unread_count: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$direction', 'inbound'] },
                  { $ne: ['$status', 'read'] },
                ],
              },
              1,
              0,
            ],
          },
        },
        total_messages: { $sum: 1 },
      },
    },
  ];

  const searchFilters = [
    ...(searchRegex ? [{ contact_name: searchRegex }, { contact_phone: searchRegex }] : []),
    ...(matchingPhones.length ? [{ contact_phone: { $in: matchingPhones } }] : []),
  ];

  if (searchFilters.length) {
    pipeline.push({
      $match: {
        $or: searchFilters,
      },
    });
  }

  if (unreadOnly) {
    pipeline.push({
      $match: {
        unread_count: { $gt: 0 },
      },
    });
  }

  pipeline.push({ $sort: { last_message_at: -1, _id: 1 } });
  return pipeline;
};

router.get('/', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const unreadOnly = String(req.query.unread_only || '').toLowerCase() === 'true';
    const requestedPage = parsePositiveInt(req.query.page, 1);
    const limit = Math.min(parsePositiveInt(req.query.limit, 25), 100);
    const searchRegex = search ? { $regex: escapeRegex(search), $options: 'i' } : null;
    const matchingPhones = search ? await findMatchingContactPhones(req.tenant._id, search) : [];

    const totalPipeline = [
      ...buildConversationPipeline({ tenantId: req.tenant._id, searchRegex, matchingPhones, unreadOnly }),
      { $count: 'count' },
    ];
    const unreadPipeline = [
      { $match: { tenant_id: req.tenant._id, direction: 'inbound', status: { $ne: 'read' } } },
      { $group: { _id: null, unread_count: { $sum: 1 } } },
    ];

    const [totalRows, unreadAgg] = await Promise.all([
      Message.aggregate(totalPipeline),
      Message.aggregate(unreadPipeline),
    ]);

    const total = Number(totalRows?.[0]?.count || 0);
    const pages = Math.max(1, Math.ceil(total / limit));
    const page = Math.min(requestedPage, pages);
    const skip = (page - 1) * limit;

    const conversationRows = await Message.aggregate([
      ...buildConversationPipeline({ tenantId: req.tenant._id, searchRegex, matchingPhones, unreadOnly }),
      { $skip: skip },
      { $limit: limit },
    ]);

    const phones = Array.from(new Set(conversationRows.map((item) => normalizePhone(item.contact_phone)).filter(Boolean)));
    const contacts = phones.length
      ? await Contact.find({ tenant_id: req.tenant._id, phone: { $in: phones } })
        .select('phone name wa_name profile_name email wa_exists')
        .lean()
      : [];
    const contactsByPhone = new Map(contacts.map((item) => [normalizePhone(item.phone), item]));

    const conversations = conversationRows.map((item) => {
      const normalizedPhone = normalizePhone(item.contact_phone);
      const contact = contactsByPhone.get(normalizedPhone) || null;
      return {
        ...item,
        contact_name: contact?.name || contact?.wa_name || contact?.profile_name || item.contact_name || item.contact_phone || '',
        name: contact?.name || '',
        wa_name: contact?.wa_name || '',
        contact_email: contact?.email || '',
        wa_exists: contact?.wa_exists || 'unknown',
      };
    });

    return apiResponse(res, {
      data: {
        conversations,
        counts: {
          unread: unreadAgg?.[0]?.unread_count || 0,
        },
        pagination: {
          page,
          limit,
          total,
          pages,
        },
      },
    });
  } catch (error) {
    console.error('[Conversations Route][List Failed]', {
      tenant_id: String(req.tenant?._id || ''),
      query: req.query,
      error: error.message,
    });
    return apiResponse(res, { status: 500, success: false, error: 'Failed' });
  }
});

router.get('/:phone', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const normalizedPhone = normalizePhone(req.params.phone);
    const requestedPage = parsePositiveInt(req.query.page, 1);
    const limit = Math.min(parsePositiveInt(req.query.limit, 50), 100);
    const locateUnread = String(req.query.locate_unread || '').toLowerCase() === 'true';
    const threadFilter = {
      tenant_id: req.tenant._id,
      contact_phone: normalizedPhone,
    };
    const unreadFilter = {
      ...threadFilter,
      direction: 'inbound',
      status: { $ne: 'read' },
    };
    const [total, unreadCount, oldestUnread] = await Promise.all([
      Message.countDocuments(threadFilter),
      Message.countDocuments(unreadFilter),
      locateUnread
        ? Message.findOne(unreadFilter).sort({ timestamp: 1, _id: 1 }).select('_id timestamp').lean()
        : Promise.resolve(null),
    ]);
    const pages = Math.max(1, Math.ceil(total / limit));
    let anchorPage = null;

    if (oldestUnread) {
      const newerCount = await Message.countDocuments({
        ...threadFilter,
        $or: [
          { timestamp: { $gt: oldestUnread.timestamp } },
          { timestamp: oldestUnread.timestamp, _id: { $gt: oldestUnread._id } },
        ],
      });
      anchorPage = Math.floor(newerCount / limit) + 1;
    }

    const page = Math.min(locateUnread && anchorPage ? anchorPage : requestedPage, pages);
    const skip = (page - 1) * limit;

    const messages = await Message.find(threadFilter)
      .sort({ timestamp: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const [contact, conversationDoc] = await Promise.all([
      Contact.findOne({
        tenant_id: req.tenant._id,
        phone: normalizedPhone,
      }).lean(),
      Conversation.findOne({
        tenant_id: req.tenant._id,
        contact_phone: normalizedPhone,
      }).select('last_customer_message_at window_expires_at window_status').lean(),
    ]);

    // Compute real-time window status
    // If Conversation model has window data, use it. Otherwise, compute from last inbound message.
    const now = new Date();
    let windowStatus = 'none';
    let windowExpiresAt = null;
    let lastCustomerMessageAt = null;

    if (conversationDoc?.window_expires_at) {
      // Conversation model has window data
      windowExpiresAt = conversationDoc.window_expires_at;
      lastCustomerMessageAt = conversationDoc.last_customer_message_at;
      windowStatus = now > new Date(windowExpiresAt) ? 'expired' : 'open';
    } else {
      // Fallback: compute from last inbound message in this thread
      const lastInbound = await Message.findOne({
        tenant_id: req.tenant._id,
        contact_phone: normalizedPhone,
        direction: 'inbound',
      }).sort({ timestamp: -1 }).select('timestamp').lean();

      if (lastInbound?.timestamp) {
        lastCustomerMessageAt = lastInbound.timestamp;
        windowExpiresAt = new Date(new Date(lastInbound.timestamp).getTime() + 24 * 60 * 60 * 1000);
        windowStatus = now > windowExpiresAt ? 'expired' : 'open';

        // Backfill the Conversation model so future requests are fast
        Conversation.findOneAndUpdate(
          { tenant_id: req.tenant._id, contact_phone: normalizedPhone },
          {
            $set: {
              last_customer_message_at: lastCustomerMessageAt,
              window_expires_at: windowExpiresAt,
              window_status: windowStatus,
            },
          },
          { upsert: true }
        ).catch(() => {});
      }
    }

    return apiResponse(res, {
      data: {
        messages: messages.reverse(),
        contact,
        window: {
          window_status: windowStatus,
          window_expires_at: windowExpiresAt,
          last_customer_message_at: lastCustomerMessageAt,
        },
        pagination: {
          page,
          limit,
          total,
          pages,
          newer_page: page > 1 ? page - 1 : null,
          older_page: page < pages ? page + 1 : null,
        },
        unread: {
          count: unreadCount,
          anchor_page: anchorPage,
        },
      },
    });
  } catch (error) {
    console.error('[Conversations Route][Thread Failed]', {
      tenant_id: String(req.tenant?._id || ''),
      phone: req.params.phone,
      error: error.message,
    });
    return apiResponse(res, { status: 500, success: false, error: 'Failed' });
  }
});

router.post('/:phone/read', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const normalizedPhone = normalizePhone(req.params.phone);
    const result = await Message.updateMany(
      {
        tenant_id: req.tenant._id,
        contact_phone: normalizedPhone,
        direction: 'inbound',
        status: { $ne: 'read' },
      },
      {
        $set: {
          status: 'read',
        },
      }
    );

    return apiResponse(res, {
      data: {
        contact_phone: normalizedPhone,
        updated_count: Number(result.modifiedCount || 0),
      },
    });
  } catch (error) {
    console.error('[Conversations Route][Mark Read Failed]', {
      tenant_id: String(req.tenant?._id || ''),
      phone: req.params.phone,
      error: error.message,
    });
    return apiResponse(res, {
      status: 500,
      success: false,
      error: '[Platform] Failed to mark conversation as read',
    });
  }
});

/* ── Contact Stats for sidebar ── */
router.get('/contact-stats/:phone', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const phone = normalizePhone(req.params.phone);
    if (!phone) return apiResponse(res, { status: 400, success: false, error: 'Invalid phone' });

    const [contact, messageCounts, firstMessage] = await Promise.all([
      Contact.findOne({ tenant_id: tenantId, phone }).lean(),
      Message.aggregate([
        { $match: { tenant_id: tenantId, contact_phone: phone, deleted_at: null } },
        {
          $group: {
            _id: '$direction',
            count: { $sum: 1 },
          },
        },
      ]),
      Message.findOne({ tenant_id: tenantId, contact_phone: phone, deleted_at: null })
        .sort({ timestamp: 1 })
        .select('timestamp')
        .lean(),
    ]);

    const sent = messageCounts.find((m) => m._id === 'outbound')?.count || 0;
    const received = messageCounts.find((m) => m._id === 'inbound')?.count || 0;
    const total = sent + received;
    const retention = total > 0 ? Math.round((received / total) * 100) : 0;

    return apiResponse(res, {
      data: {
        opt_in: contact?.opt_in ?? false,
        sent_count: sent,
        received_count: received,
        total_messages: total,
        retention_ratio: retention,
        first_message_at: firstMessage?.timestamp || null,
        tags: contact?.tags || [],
      },
    });
  } catch (err) {
    console.error('[Conversations] contact-stats error:', err);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to load contact stats' });
  }
});

/* ── Repair broken interactive messages from WebhookEvent data ── */
router.post('/repair-interactive', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;

    // Find all inbound interactive messages with generic/broken content
    const brokenMessages = await Message.find({
      tenant_id: tenantId,
      direction: 'inbound',
      message_type: 'interactive',
      $or: [
        { content: { $regex: /^\[.*\]$/i } },
        { content: 'Interactive message' },
        { content: 'Interactive Reply' },
        { content: '' },
        { content: null },
        { interactive_payload: null },
      ],
    }).lean();

    let patched = 0;
    let notFound = 0;

    for (const msg of brokenMessages) {
      const waId = msg.wa_message_id || msg.whatsapp_message_id;
      if (!waId) { notFound++; continue; }

      // Find the corresponding WebhookEvent with the raw Meta payload
      const webhookEvent = await WebhookEvent.findOne({
        tenant_id: tenantId,
        'payload.change.value.messages.id': waId,
      }).lean();

      if (!webhookEvent) {
        // Also try nested entry format
        const webhookEvent2 = await WebhookEvent.findOne({
          tenant_id: tenantId,
        }).where('payload').exists(true).lean();
        // Skip if no event found
        notFound++;
        continue;
      }

      // Extract the message from the webhook payload
      const change = webhookEvent.payload?.change || webhookEvent.payload?.changes?.[0] || webhookEvent.payload?.entry?.[0]?.changes?.[0] || {};
      const messages = change?.value?.messages || [];
      const rawMsg = messages.find(m => m.id === waId);

      if (!rawMsg || rawMsg.type !== 'interactive') { notFound++; continue; }

      const ir = rawMsg.interactive || {};
      let newContent = '';
      if (ir.type === 'button_reply') newContent = ir.button_reply?.title || '';
      else if (ir.type === 'list_reply') newContent = ir.list_reply?.title || '';

      if (!newContent) { notFound++; continue; }

      await Message.findByIdAndUpdate(msg._id, {
        $set: {
          content: newContent,
          interactive_payload: ir,
        },
      });
      patched++;
    }

    // Also delete phantom [Meta status update] records while we're at it
    const phantom = await Message.deleteMany({
      tenant_id: tenantId,
      content: { $regex: /^\[Meta status update\]$/i },
    });

    return apiResponse(res, {
      data: {
        broken_found: brokenMessages.length,
        patched,
        not_found_in_events: notFound,
        phantom_deleted: phantom.deletedCount,
      },
    });
  } catch (err) {
    console.error('[Conversations] repair-interactive error:', err);
    return apiResponse(res, { status: 500, success: false, error: 'Repair failed' });
  }
});

/* ── Cleanup phantom [Meta status update] records ── */
router.delete('/cleanup-phantom', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const result = await Message.deleteMany({
      tenant_id: tenantId,
      content: { $regex: /^\[Meta status update\]$/i },
    });
    return apiResponse(res, { data: { deleted: result.deletedCount } });
  } catch (err) {
    console.error('[Conversations] cleanup-phantom error:', err);
    return apiResponse(res, { status: 500, success: false, error: 'Cleanup failed' });
  }
});

module.exports = router;
