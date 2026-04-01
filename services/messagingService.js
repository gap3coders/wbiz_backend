const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const AuditLog = require('../models/AuditLog');
const { emitToTenant } = require('./socketService');
const VALID_MESSAGE_STATUSES = new Set(['received', 'queued', 'sent', 'delivered', 'read', 'failed']);

const normalizePhoneNumber = (value) => {
  if (!value) return '';
  return String(value).replace(/[^\d]/g, '');
};

const parseMetaTimestamp = (value) => {
  if (!value) return new Date();
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return new Date(parsed * 1000);
  }
  const asDate = new Date(value);
  return Number.isNaN(asDate.getTime()) ? new Date() : asDate;
};

const previewFromPayload = (type, payload = {}) => {
  switch (type) {
    case 'text':
      return payload.text?.body || payload.body || '';
    case 'image':
      return payload.image?.caption || 'Image message';
    case 'document':
      return payload.document?.caption || payload.document?.filename || 'Document message';
    case 'video':
      return payload.video?.caption || 'Video message';
    case 'audio':
      return 'Audio message';
    case 'location':
      return payload.location?.name || payload.location?.address || 'Location shared';
    case 'template':
      return payload.template?.name ? `Template: ${payload.template.name}` : 'Template message';
    case 'interactive':
      return payload.interactive?.body?.text || 'Interactive message';
    case 'button':
      return payload.button?.text || 'Button reply';
    default:
      return 'WhatsApp message';
  }
};

const sanitizeTags = (tags = []) =>
  Array.from(
    new Set(
      (Array.isArray(tags) ? tags : [])
        .map((tag) => String(tag || '').trim())
        .filter(Boolean)
    )
  );

const ensureContact = async ({
  tenantId,
  phoneNumber,
  whatsappId = null,
  name = null,
  profileName = null,
  email = null,
  tags,
  notes,
  customFields,
  lastInboundAt,
  lastOutboundAt,
}) => {
  const normalizedPhone = normalizePhoneNumber(phoneNumber);
  if (!normalizedPhone) {
    throw new Error('Valid contact phone number is required');
  }

  const update = {
    phone: normalizedPhone,
    whatsapp_id: whatsappId || normalizedPhone,
    last_message_at: new Date(),
  };

  if (name !== undefined && name !== null) update.name = name;
  if (profileName !== undefined && profileName !== null) {
    update.wa_name = profileName;
    update.profile_name = profileName;
  }
  if (email !== undefined) update.email = email;
  if (tags !== undefined) {
    const normalizedTags = sanitizeTags(tags);
    update.tags = normalizedTags;
    update.labels = normalizedTags;
  }
  if (notes !== undefined) update.notes = notes;
  if (customFields !== undefined) update.custom_fields = customFields;
  if (lastInboundAt) update.last_inbound_at = lastInboundAt;
  if (lastOutboundAt) update.last_outbound_at = lastOutboundAt;

  const contact = await Contact.findOneAndUpdate(
    {
      tenant_id: tenantId,
      phone: normalizedPhone,
    },
    {
      $set: update,
      $setOnInsert: { tenant_id: tenantId },
    },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: false }
  );

  return contact;
};

const ensureConversation = async ({
  tenantId,
  contactPhone,
  contactName = '',
  wabaId = null,
  phoneNumberId = null,
  status = 'open',
  unreadIncrement = 0,
  lastMessageAt = new Date(),
  lastMessagePreview = '',
  lastMessageDirection = null,
  lastMessageStatus = null,
  metadata,
}) => {
  const update = {
    last_message_at: lastMessageAt,
    last_message_preview: lastMessagePreview,
    last_message_direction: lastMessageDirection,
    last_message_status: lastMessageStatus,
  };

  if (wabaId) update.waba_id = wabaId;
  if (phoneNumberId) update.sender_phone_number_id = phoneNumberId;
  if (contactName !== undefined && contactName !== null) update.contact_name = String(contactName || '').trim();
  if (status) update.status = status;
  if (metadata) update.metadata = metadata;

  const operations = {
    $set: update,
    $setOnInsert: {
      tenant_id: tenantId,
      contact_phone: contactPhone,
      contact_name: String(contactName || '').trim(),
    },
  };

  if (unreadIncrement) {
    operations.$inc = { unread_count: unreadIncrement };
  }

  return Conversation.findOneAndUpdate(
    { tenant_id: tenantId, contact_phone: contactPhone },
    operations,
    { new: true, upsert: true }
  );
};

const buildRealtimePayload = async (conversationId) => {
  const conversation = await Conversation.findById(conversationId).populate('assigned_user_id', 'full_name email role');

  if (!conversation) return null;
  const contact = await Contact.findOne({
    tenant_id: conversation.tenant_id,
    phone: conversation.contact_phone,
  }).lean();

  const recentMessages = await Message.find({ conversation_id: conversationId })
    .sort({ message_timestamp: 1, created_at: 1 })
    .limit(100);

  return {
    conversation: {
      ...conversation.toObject(),
      contact,
      assigned_user: conversation.assigned_user_id,
    },
    messages: recentMessages,
  };
};

const recordAuditLog = async ({ tenantId, userId = null, action, entityType, entityId = null, metadata = {} }) => {
  try {
    await AuditLog.create({
      tenant_id: tenantId,
      user_id: userId,
      action,
      entity_type: entityType,
      entity_id: entityId ? String(entityId) : null,
      metadata,
    });
  } catch (error) {
    console.error('[Messaging Service] Failed to write audit log', error.message);
  }
};

const recordInboundMessage = async ({
  tenantId,
  wabaId,
  phoneNumberId,
  contactProfile = {},
  message,
  rawPayload = {},
}) => {
  const messageTimestamp = parseMetaTimestamp(message.timestamp);
  const phoneNumber = normalizePhoneNumber(message.from || contactProfile.wa_id);
  const type = message.type || 'unknown';
  const preview = previewFromPayload(type, message);

  const contact = await ensureContact({
    tenantId,
    phoneNumber,
    whatsappId: contactProfile.wa_id || phoneNumber,
    profileName: contactProfile.profile?.name || contactProfile.profile_name || null,
    lastInboundAt: messageTimestamp,
  });

  const conversation = await ensureConversation({
    tenantId,
    contactPhone: phoneNumber,
    contactName: contact.name || contact.wa_name || contact.profile_name || '',
    wabaId,
    phoneNumberId,
    status: 'open',
    unreadIncrement: 1,
    lastMessageAt: messageTimestamp,
    lastMessagePreview: preview,
    lastMessageDirection: 'inbound',
    lastMessageStatus: 'received',
  });

  const storedMessage = await Message.findOneAndUpdate(
    { tenant_id: tenantId, whatsapp_message_id: message.id },
    {
      $setOnInsert: {
        tenant_id: tenantId,
        conversation_id: conversation._id,
        contact_id: contact._id,
        whatsapp_message_id: message.id,
        direction: 'inbound',
        status: 'received',
        type,
        from: phoneNumber,
        to: phoneNumberId || null,
        text_body: preview,
        payload: rawPayload,
        message_timestamp: messageTimestamp,
      },
    },
    { new: true, upsert: true }
  );

  const realtimePayload = await buildRealtimePayload(conversation._id);
  emitToTenant(tenantId, 'conversation:updated', realtimePayload);

  return { contact, conversation, message: storedMessage };
};

const recordOutboundMessage = async ({
  tenantId,
  userId = null,
  wabaId,
  phoneNumberId,
  to,
  type,
  payload,
  whatsappMessageId,
  status = 'sent',
}) => {
  const messageTimestamp = new Date();
  const preview = previewFromPayload(type, payload);
  const normalizedPhone = normalizePhoneNumber(to);

  const contact = await ensureContact({
    tenantId,
    phoneNumber: normalizedPhone,
    whatsappId: normalizedPhone,
    lastOutboundAt: messageTimestamp,
  });

  const conversation = await ensureConversation({
    tenantId,
    contactPhone: normalizedPhone,
    contactName: contact.name || contact.wa_name || contact.profile_name || '',
    wabaId,
    phoneNumberId,
    lastMessageAt: messageTimestamp,
    lastMessagePreview: preview,
    lastMessageDirection: 'outbound',
    lastMessageStatus: status,
  });

  const storedMessage = await Message.create({
    tenant_id: tenantId,
    conversation_id: conversation._id,
    contact_id: contact._id,
    whatsapp_message_id: whatsappMessageId || null,
    direction: 'outbound',
    status,
    type,
    from: phoneNumberId || null,
    to: normalizedPhone,
    text_body: preview,
    payload,
    message_timestamp: messageTimestamp,
    sent_at: messageTimestamp,
  });

  await recordAuditLog({
    tenantId,
    userId,
    action: 'message.sent',
    entityType: 'message',
    entityId: storedMessage._id,
    metadata: {
      conversation_id: conversation._id,
      contact_id: contact._id,
      whatsapp_message_id: whatsappMessageId || null,
      type,
    },
  });

  const realtimePayload = await buildRealtimePayload(conversation._id);
  emitToTenant(tenantId, 'conversation:updated', realtimePayload);

  return { contact, conversation, message: storedMessage };
};

const applyStatusUpdate = async ({ tenantId, statusPayload }) => {
  const whatsappMessageId = statusPayload.id;
  if (!whatsappMessageId) return null;

  const message = await Message.findOne({
    tenant_id: tenantId,
    whatsapp_message_id: whatsappMessageId,
  });

  if (!message) {
    console.warn('[Messaging Service] Message not found for status update', {
      tenantId: String(tenantId),
      whatsappMessageId,
      status: statusPayload.status,
    });
    return null;
  }

  const timestamp = parseMetaTimestamp(statusPayload.timestamp);
  if (VALID_MESSAGE_STATUSES.has(statusPayload.status)) {
    message.status = statusPayload.status;
  }
  message.payload = {
    ...message.payload,
    latest_status_payload: statusPayload,
  };

  if (statusPayload.status === 'sent') message.sent_at = timestamp;
  if (statusPayload.status === 'delivered') message.delivered_at = timestamp;
  if (statusPayload.status === 'read') message.read_at = timestamp;
  if (statusPayload.status === 'failed') {
    message.error_message =
      statusPayload.errors?.[0]?.title ||
      statusPayload.errors?.[0]?.message ||
      'Meta returned a failed status update';
  }

  await message.save();

  await Conversation.findByIdAndUpdate(message.conversation_id, {
    last_message_status: message.status,
  });

  const realtimePayload = await buildRealtimePayload(message.conversation_id);
  emitToTenant(tenantId, 'conversation:updated', realtimePayload);
  emitToTenant(tenantId, 'message:status', {
    conversation_id: message.conversation_id,
    message_id: message._id,
    whatsapp_message_id: whatsappMessageId,
    status: message.status,
  });

  return message;
};

module.exports = {
  normalizePhoneNumber,
  ensureContact,
  ensureConversation,
  recordInboundMessage,
  recordOutboundMessage,
  applyStatusUpdate,
  previewFromPayload,
  recordAuditLog,
};
