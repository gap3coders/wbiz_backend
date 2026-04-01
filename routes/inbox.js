const express = require('express');
const mongoose = require('mongoose');
const { authenticate, requireStatus } = require('../middleware/auth');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Contact = require('../models/Contact');
const { apiResponse } = require('../utils/helpers');
const { recordAuditLog } = require('../services/messagingService');

const router = express.Router();

router.use(authenticate, requireStatus('active'));

const serializeConversation = (conversation, contact = null) => ({
  ...conversation.toObject(),
  contact,
  assigned_user: conversation.assigned_user_id || null,
});

router.get('/conversations', async (req, res) => {
  try {
    const tenantId = req.tenant?._id;
    const status = String(req.query.status || '').trim();
    const search = String(req.query.search || '').trim();
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);

    const query = { tenant_id: tenantId };
    if (status) {
      query.status = status;
    }

    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const matchingContacts = await Contact.find({
        tenant_id: tenantId,
        $or: [
          { name: regex },
          { profile_name: regex },
          { phone: regex },
          { whatsapp_id: regex },
          { email: regex },
          { tags: regex },
        ],
      }).select('phone');

      const contactPhones = matchingContacts.map((contact) => String(contact.phone || '').trim()).filter(Boolean);
      if (contactPhones.length === 0) {
        return apiResponse(res, {
          data: {
            conversations: [],
            counts: {
              total: 0,
              open: 0,
              pending: 0,
              resolved: 0,
              unread: 0,
            },
          },
        });
      }

      query.contact_phone = { $in: contactPhones };
    }

    const tenantObjectId = new mongoose.Types.ObjectId(String(tenantId));

    const [conversations, countsByStatus, unreadAgg] = await Promise.all([
      Conversation.find(query)
        .populate('assigned_user_id', 'full_name email role')
        .sort({ last_message_at: -1, updated_at: -1 })
        .limit(limit),
      Conversation.aggregate([
        { $match: { tenant_id: tenantObjectId } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      Conversation.aggregate([
        { $match: { tenant_id: tenantObjectId } },
        { $group: { _id: null, unread: { $sum: '$unread_count' } } },
      ]),
    ]);

    const counts = {
      total: countsByStatus.reduce((sum, item) => sum + item.count, 0),
      open: countsByStatus.find((item) => item._id === 'open')?.count || 0,
      pending: countsByStatus.find((item) => item._id === 'pending')?.count || 0,
      resolved: countsByStatus.find((item) => item._id === 'resolved')?.count || 0,
      unread: unreadAgg[0]?.unread || 0,
    };

    const phones = Array.from(new Set(conversations.map((item) => String(item.contact_phone || '').trim()).filter(Boolean)));
    const contacts = phones.length
      ? await Contact.find({ tenant_id: tenantId, phone: { $in: phones } }).lean()
      : [];
    const contactsByPhone = new Map(contacts.map((item) => [String(item.phone || '').trim(), item]));

    return apiResponse(res, {
      data: {
        conversations: conversations.map((conversation) =>
          serializeConversation(conversation, contactsByPhone.get(String(conversation.contact_phone || '').trim()) || null)
        ),
        counts,
      },
    });
  } catch (error) {
    console.error('[Inbox Route] Failed to fetch conversations', error);
    return apiResponse(res, {
      status: 500,
      success: false,
      error: 'Failed to load conversations',
    });
  }
});

router.get('/conversations/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const conversation = await Conversation.findOne({
      _id: conversationId,
      tenant_id: req.tenant._id,
    })
      .populate('assigned_user_id', 'full_name email role');

    if (!conversation) {
      return apiResponse(res, {
        status: 404,
        success: false,
        error: 'Conversation not found',
      });
    }

    const messages = await Message.find({
      tenant_id: req.tenant._id,
      conversation_id: conversationId,
    }).sort({ message_timestamp: 1, created_at: 1 });

    return apiResponse(res, {
      data: {
        conversation: serializeConversation(
          conversation,
          await Contact.findOne({
            tenant_id: req.tenant._id,
            phone: conversation.contact_phone,
          }).lean()
        ),
        messages,
      },
    });
  } catch (error) {
    console.error('[Inbox Route] Failed to load conversation detail', error);
    return apiResponse(res, {
      status: 500,
      success: false,
      error: 'Failed to load conversation',
    });
  }
});

router.patch('/conversations/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const conversation = await Conversation.findOne({
      _id: conversationId,
      tenant_id: req.tenant._id,
    });

    if (!conversation) {
      return apiResponse(res, {
        status: 404,
        success: false,
        error: 'Conversation not found',
      });
    }

    if (req.body.status !== undefined) {
      conversation.status = req.body.status;
    }

    if (req.body.assigned_user_id !== undefined) {
      conversation.assigned_user_id = req.body.assigned_user_id ? req.body.assigned_user_id : null;
    }

    await conversation.save();
    await recordAuditLog({
      tenantId: req.tenant._id,
      userId: req.user._id,
      action: 'conversation.updated',
      entityType: 'conversation',
      entityId: conversation._id,
      metadata: {
        status: conversation.status,
        assigned_user_id: conversation.assigned_user_id ? String(conversation.assigned_user_id) : null,
      },
    });

    const populatedConversation = await Conversation.findById(conversation._id)
      .populate('assigned_user_id', 'full_name email role');

    return apiResponse(res, {
      data: {
        conversation: serializeConversation(
          populatedConversation,
          await Contact.findOne({
            tenant_id: req.tenant._id,
            phone: populatedConversation.contact_phone,
          }).lean()
        ),
      },
    });
  } catch (error) {
    console.error('[Inbox Route] Failed to update conversation', error);
    return apiResponse(res, {
      status: 500,
      success: false,
      error: 'Failed to update conversation',
    });
  }
});

router.post('/conversations/:conversationId/read', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const conversation = await Conversation.findOneAndUpdate(
      {
        _id: conversationId,
        tenant_id: req.tenant._id,
      },
      {
        unread_count: 0,
      },
      { new: true }
    )
      .populate('assigned_user_id', 'full_name email role');

    if (!conversation) {
      return apiResponse(res, {
        status: 404,
        success: false,
        error: 'Conversation not found',
      });
    }

    await recordAuditLog({
      tenantId: req.tenant._id,
      userId: req.user._id,
      action: 'conversation.read',
      entityType: 'conversation',
      entityId: conversation._id,
      metadata: {},
    });

    return apiResponse(res, {
      data: {
        conversation: serializeConversation(
          conversation,
          await Contact.findOne({
            tenant_id: req.tenant._id,
            phone: conversation.contact_phone,
          }).lean()
        ),
      },
    });
  } catch (error) {
    console.error('[Inbox Route] Failed to mark conversation read', error);
    return apiResponse(res, {
      status: 500,
      success: false,
      error: 'Failed to mark conversation as read',
    });
  }
});

module.exports = router;
