const express = require('express');
const { authenticate, requireStatus } = require('../middleware/auth');
const metaService = require('../services/metaService');
const { decrypt } = require('../services/encryptionService');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const Message = require('../models/Message');
const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const { apiResponse } = require('../utils/helpers');

const router = express.Router();
const escapeRegex = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Helper to get WhatsApp account and decrypt token
const getWAAccount = async (tenantId) => {
  const wa = await WhatsAppAccount.findOne({ tenant_id: tenantId, is_default: true })
    || await WhatsAppAccount.findOne({ tenant_id: tenantId });
  if (!wa) throw new Error('No WhatsApp account connected');
  return { wa, accessToken: decrypt(wa.access_token_encrypted) };
};

const normalizePhone = (value) => String(value || '').replace(/[^\d]/g, '');

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

// ─── LIST CONVERSATIONS (grouped by contact) ──────────────
router.get('/conversations', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { search, page = 1, limit = 30 } = req.query;
    const searchValue = String(search || '').trim();
    const searchRegex = searchValue ? { $regex: escapeRegex(searchValue), $options: 'i' } : null;
    const matchingPhones = searchValue ? await findMatchingContactPhones(req.tenant._id, searchValue) : [];

    // Aggregate messages to get unique conversations
    const matchStage = { tenant_id: req.tenant._id };

    const pipeline = [
      { $match: matchStage },
      { $sort: { timestamp: -1 } },
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
          unread_count: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$direction', 'inbound'] }, { $ne: ['$status', 'read'] }] },
                1,
                0,
              ],
            },
          },
          total_messages: { $sum: 1 },
          last_customer_message_at: { $max: { $cond: [{ $eq: ['$direction', 'inbound'] }, '$timestamp', null] } },
        },
      },
      {
        $addFields: {
          window_expires_at: {
            $cond: [
              { $ne: ['$last_customer_message_at', null] },
              { $add: ['$last_customer_message_at', 24 * 60 * 60 * 1000] },
              null,
            ],
          },
          window_status: {
            $cond: [
              { $eq: ['$last_customer_message_at', null] },
              'none',
              {
                $cond: [
                  { $gt: [{ $add: ['$last_customer_message_at', 24 * 60 * 60 * 1000] }, '$$NOW'] },
                  'open',
                  'expired',
                ],
              },
            ],
          },
        },
      },
      { $sort: { last_message_at: -1 } },
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

    const skip = (parseInt(page) - 1) * parseInt(limit);
    pipeline.push({ $skip: skip });
    pipeline.push({ $limit: parseInt(limit) });

    const conversations = await Message.aggregate(pipeline);

    return apiResponse(res, { data: { conversations } });
  } catch (error) {
    console.error('List conversations error:', error);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to fetch conversations' });
  }
});

// ─── GET MESSAGES FOR A CONTACT ────────────────────────────
router.get('/thread/:phone', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { phone } = req.params;
    const { page = 1, limit = 50 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const messages = await Message.find({
      tenant_id: req.tenant._id,
      contact_phone: phone,
      deleted_at: null,
    })
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Message.countDocuments({
      tenant_id: req.tenant._id,
      contact_phone: phone,
    });

    // Get contact info
    const contact = await Contact.findOne({ tenant_id: req.tenant._id, phone });

    const conversationDoc = await Conversation.findOne({
      tenant_id: req.tenant._id,
      contact_phone: phone,
    }).lean();

    const windowInfo = {
      window_status: conversationDoc?.window_status || 'none',
      window_expires_at: conversationDoc?.window_expires_at || null,
      last_customer_message_at: conversationDoc?.last_customer_message_at || null,
    };

    return apiResponse(res, {
      data: {
        messages: messages.reverse(),
        contact,
        window: windowInfo,
        pagination: { page: parseInt(page), limit: parseInt(limit), total },
      },
    });
  } catch (error) {
    return apiResponse(res, { status: 500, success: false, error: 'Failed to fetch messages' });
  }
});

// ─── SEND TEXT MESSAGE ─────────────────────────────────────
router.post('/send', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { to, text } = req.body;
    if (!to || !text) {
      return apiResponse(res, { status: 400, success: false, error: 'Recipient phone and text are required' });
    }

    const normalizedTo = to.replace(/[^0-9]/g, '');

    // 24-hour window enforcement
    const existingConversation = await Conversation.findOne({
      tenant_id: req.tenant._id,
      contact_phone: normalizedTo,
    });

    if (existingConversation) {
      const isWindowExpired = !existingConversation.window_expires_at || new Date() > existingConversation.window_expires_at;
      if (isWindowExpired) {
        return apiResponse(res, {
          status: 403,
          success: false,
          error: '24-hour conversation window has expired. Only template messages can be sent.',
          data: { window_expired: true, window_expires_at: existingConversation.window_expires_at },
        });
      }
    }

    const { wa, accessToken } = await getWAAccount(req.tenant._id);

    const result = await metaService.sendTextMessage(
      wa.phone_number_id,
      accessToken,
      normalizedTo,
      text
    );

    const waMessageId = result.messages?.[0]?.id || null;

    // Ensure contact exists
    const contact = await Contact.findOneAndUpdate(
      { tenant_id: req.tenant._id, phone: normalizedTo },
      { $set: { phone: normalizedTo, whatsapp_id: normalizedTo, last_message_at: new Date() }, $setOnInsert: { tenant_id: req.tenant._id, name: '' } },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: false }
    );

    // Save message record
    const message = await Message.create({
      tenant_id: req.tenant._id,
      contact_id: contact._id,
      contact_phone: normalizedTo,
      contact_name: contact.name,
      direction: 'outbound',
      message_type: 'text',
      content: text,
      wa_message_id: waMessageId,
      status: 'sent',
      sent_by: req.user._id,
      timestamp: new Date(),
    });

    return apiResponse(res, { data: { message, wa_message_id: waMessageId } });
  } catch (error) {
    console.error('Send message error:', error);
    return apiResponse(res, { status: 500, success: false, error: `Failed to send message: ${error.message}` });
  }
});

// ─── SEND TEMPLATE MESSAGE ─────────────────────────────────
router.post('/send-template', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { to, template_name, language, components } = req.body;
    if (!to || !template_name) {
      return apiResponse(res, { status: 400, success: false, error: 'Recipient and template name are required' });
    }

    const normalizedTo = to.replace(/[^0-9]/g, '');
    const { wa, accessToken } = await getWAAccount(req.tenant._id);

    const result = await metaService.sendTemplateMessage(
      wa.phone_number_id,
      accessToken,
      normalizedTo,
      template_name,
      language || 'en',
      components || []
    );

    const waMessageId = result.messages?.[0]?.id || null;

    const contact = await Contact.findOneAndUpdate(
      { tenant_id: req.tenant._id, phone: normalizedTo },
      { $set: { phone: normalizedTo, whatsapp_id: normalizedTo, last_message_at: new Date() }, $setOnInsert: { tenant_id: req.tenant._id, name: '' } },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: false }
    );

    const message = await Message.create({
      tenant_id: req.tenant._id,
      contact_id: contact._id,
      contact_phone: normalizedTo,
      contact_name: contact.name,
      direction: 'outbound',
      message_type: 'template',
      content: `[Template: ${template_name}]`,
      template_name,
      wa_message_id: waMessageId,
      status: 'sent',
      sent_by: req.user._id,
      timestamp: new Date(),
    });

    return apiResponse(res, { data: { message, wa_message_id: waMessageId } });
  } catch (error) {
    console.error('Send template error:', error);
    return apiResponse(res, { status: 500, success: false, error: `Failed to send template: ${error.message}` });
  }
});

// ─── MARK AS READ ──────────────────────────────────────────
router.post('/mark-read', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { message_id } = req.body;
    if (!message_id) return apiResponse(res, { status: 400, success: false, error: 'message_id required' });

    const msg = await Message.findOne({ _id: message_id, tenant_id: req.tenant._id });
    if (!msg) return apiResponse(res, { status: 404, success: false, error: 'Message not found' });

    if (msg.wa_message_id && msg.direction === 'inbound') {
      const { wa, accessToken } = await getWAAccount(req.tenant._id);
      try {
        await metaService.markMessageRead(wa.phone_number_id, accessToken, msg.wa_message_id);
      } catch (e) {
        console.warn('Mark read API call failed:', e.message);
      }
    }

    msg.status = 'read';
    await msg.save();

    return apiResponse(res, { data: { message: 'Marked as read' } });
  } catch (error) {
    return apiResponse(res, { status: 500, success: false, error: 'Failed to mark as read' });
  }
});

// ─── DELETE SINGLE MESSAGE ────────────────────────────────
router.delete('/message/:id', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const message = await Message.findOne({
      _id: req.params.id,
      tenant_id: req.tenant._id,
    });

    if (!message) {
      return apiResponse(res, { status: 404, success: false, error: 'Message not found' });
    }

    message.deleted_at = new Date();
    message.content = '[This message was deleted]';
    await message.save();

    return apiResponse(res, { data: { message: 'Message deleted successfully' } });
  } catch (error) {
    console.error('Delete message error:', error);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to delete message' });
  }
});

// ─── BULK DELETE MESSAGES ─────────────────────────────────
router.post('/messages/bulk-delete', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { message_ids } = req.body;
    if (!Array.isArray(message_ids) || message_ids.length === 0) {
      return apiResponse(res, { status: 400, success: false, error: 'message_ids array is required' });
    }

    if (message_ids.length > 100) {
      return apiResponse(res, { status: 400, success: false, error: 'Maximum 100 messages can be deleted at once' });
    }

    const result = await Message.updateMany(
      {
        _id: { $in: message_ids },
        tenant_id: req.tenant._id,
      },
      {
        $set: {
          deleted_at: new Date(),
          content: '[This message was deleted]',
        },
      }
    );

    return apiResponse(res, {
      data: {
        deleted_count: result.modifiedCount,
        message: `${result.modifiedCount} message(s) deleted successfully`,
      },
    });
  } catch (error) {
    console.error('Bulk delete messages error:', error);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to delete messages' });
  }
});

// ─── ARCHIVE CONVERSATION ─────────────────────────────────
router.delete('/conversation/:phone', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { phone } = req.params;
    const Conversation = require('../models/Conversation');

    const conversation = await Conversation.findOne({
      tenant_id: req.tenant._id,
      contact_phone: phone,
    });

    if (!conversation) {
      return apiResponse(res, { status: 404, success: false, error: 'Conversation not found' });
    }

    conversation.status = 'resolved';
    conversation.metadata = {
      ...conversation.metadata,
      archived_at: new Date(),
      archived_by: req.user._id,
    };
    await conversation.save();

    return apiResponse(res, { data: { message: 'Conversation archived successfully' } });
  } catch (error) {
    console.error('Archive conversation error:', error);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to archive conversation' });
  }
});

// ─── GET CONTACT STATS ────────────────────────────────────
router.get('/contact-stats/:phone', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { phone } = req.params;

    const stats = await Message.aggregate([
      {
        $match: {
          tenant_id: req.tenant._id,
          contact_phone: phone,
          deleted_at: null,
        },
      },
      {
        $group: {
          _id: null,
          total_messages: { $sum: 1 },
          sent_count: { $sum: { $cond: [{ $eq: ['$direction', 'outbound'] }, 1, 0] } },
          received_count: { $sum: { $cond: [{ $eq: ['$direction', 'inbound'] }, 1, 0] } },
          read_count: { $sum: { $cond: [{ $eq: ['$status', 'read'] }, 1, 0] } },
          delivered_count: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0] } },
          failed_count: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
          first_message_at: { $min: '$timestamp' },
          last_message_at: { $max: '$timestamp' },
        },
      },
    ]);

    const contact = await Contact.findOne({
      tenant_id: req.tenant._id,
      phone,
    }).lean();

    const stat = stats[0] || {
      total_messages: 0,
      sent_count: 0,
      received_count: 0,
      read_count: 0,
      delivered_count: 0,
      failed_count: 0,
      first_message_at: null,
      last_message_at: null,
    };

    const retentionRatio = stat.sent_count > 0
      ? Math.round((stat.received_count / stat.sent_count) * 100)
      : 0;

    return apiResponse(res, {
      data: {
        ...stat,
        retention_ratio: retentionRatio,
        opt_in: contact?.opt_in ?? true,
        subscription_status: contact?.subscription_status || 'subscribed',
        subscribed_at: contact?.subscribed_at || null,
        unsubscribed_at: contact?.unsubscribed_at || null,
      },
    });
  } catch (error) {
    console.error('Contact stats error:', error);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to fetch contact stats' });
  }
});

// ─── GET CONVERSATION WINDOW STATUS ───────────────────────
router.get('/window/:phone', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { phone } = req.params;
    const conversation = await Conversation.findOne({
      tenant_id: req.tenant._id,
      contact_phone: phone,
    }).lean();

    if (!conversation) {
      return apiResponse(res, {
        data: { window_status: 'none', window_expires_at: null, last_customer_message_at: null },
      });
    }

    // Recompute status in real-time
    const now = new Date();
    let status = conversation.window_status || 'none';
    if (conversation.window_expires_at && now > conversation.window_expires_at) {
      status = 'expired';
    }

    return apiResponse(res, {
      data: {
        window_status: status,
        window_expires_at: conversation.window_expires_at,
        last_customer_message_at: conversation.last_customer_message_at,
      },
    });
  } catch (error) {
    return apiResponse(res, { status: 500, success: false, error: 'Failed to fetch window status' });
  }
});

module.exports = router;
