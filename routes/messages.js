const express = require('express');
const { authenticate, requireStatus } = require('../middleware/auth');
const metaService = require('../services/metaService');
const { decrypt } = require('../services/encryptionService');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const Message = require('../models/Message');
const Contact = require('../models/Contact');
const { apiResponse } = require('../utils/helpers');

const router = express.Router();

// Helper to get WhatsApp account and decrypt token
const getWAAccount = async (tenantId) => {
  const wa = await WhatsAppAccount.findOne({ tenant_id: tenantId });
  if (!wa) throw new Error('No WhatsApp account connected');
  return { wa, accessToken: decrypt(wa.access_token_encrypted) };
};

// ─── LIST CONVERSATIONS (grouped by contact) ──────────────
router.get('/conversations', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { search, page = 1, limit = 30 } = req.query;

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
        },
      },
      { $sort: { last_message_at: -1 } },
    ];

    if (search) {
      pipeline.push({
        $match: {
          $or: [
            { contact_name: { $regex: search, $options: 'i' } },
            { contact_phone: { $regex: search, $options: 'i' } },
          ],
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

    return apiResponse(res, {
      data: {
        messages: messages.reverse(),
        contact,
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

module.exports = router;
