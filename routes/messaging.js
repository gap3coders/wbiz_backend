const express = require('express');
const { authenticate, requireStatus } = require('../middleware/auth');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const { decrypt } = require('../services/encryptionService');
const metaService = require('../services/metaService');
const { apiResponse } = require('../utils/helpers');
const {
  recordOutboundMessage,
} = require('../services/messagingService');
const { buildMessagePayload } = require('../services/whatsappPayloadService');

const router = express.Router();

router.use(authenticate, requireStatus('active'));

router.post('/send', async (req, res) => {
  try {
    const waAccount = await WhatsAppAccount.findOne({ tenant_id: req.tenant._id });
    if (!waAccount) {
      return apiResponse(res, {
        status: 400,
        success: false,
        error: 'Connect a WhatsApp account before sending messages',
      });
    }

    let recipientPhone = req.body.to || req.body.phone_number;

    if (!recipientPhone && req.body.contact_id) {
      const contact = await Contact.findOne({
        _id: req.body.contact_id,
        tenant_id: req.tenant._id,
      });
      recipientPhone = contact?.phone || '';
    }

    if (!recipientPhone && req.body.conversation_id) {
      const conversation = await Conversation.findOne({
        _id: req.body.conversation_id,
        tenant_id: req.tenant._id,
      });
      recipientPhone = conversation?.contact_phone || '';
    }

    const payload = buildMessagePayload({
      ...req.body,
      to: recipientPhone,
    });

    const accessToken = decrypt(waAccount.access_token_encrypted);
    const metaResponse = await metaService.sendWhatsAppMessage(
      waAccount.phone_number_id,
      accessToken,
      payload
    );

    waAccount.last_error_source = null;
    waAccount.last_error_code = null;
    waAccount.last_error_message = null;
    waAccount.last_error_at = null;
    if (waAccount.sender_registration_status !== 'registered') {
      waAccount.sender_registration_status = 'registered';
    }
    await waAccount.save();

    const stored = await recordOutboundMessage({
      tenantId: req.tenant._id,
      userId: req.user._id,
      wabaId: waAccount.waba_id,
      phoneNumberId: waAccount.phone_number_id,
      to: payload.to,
      type: payload.type,
      payload,
      whatsappMessageId: metaResponse.messages?.[0]?.id || null,
      status: 'sent',
    });

    return apiResponse(res, {
      status: 201,
      data: {
        conversation: stored.conversation,
        message: stored.message,
        meta: metaResponse,
      },
    });
  } catch (error) {
    console.error('[Messaging Route] Failed to send message', error);
    const metaError = error?.metaError || null;
    const isRegistrationIssue = metaError?.code === 133010;

    const waAccount = await WhatsAppAccount.findOne({ tenant_id: req.tenant._id }).catch(() => null);
    if (waAccount) {
      waAccount.last_error_source = metaError ? 'meta' : 'app';
      waAccount.last_error_code = metaError?.code || null;
      waAccount.last_error_message = error.message || 'Failed to send WhatsApp message';
      waAccount.last_error_at = new Date();
      if (isRegistrationIssue) {
        waAccount.sender_registration_status = 'needs_registration';
      }
      await waAccount.save().catch(() => null);
    }

    return apiResponse(res, {
      status: metaError ? 502 : 400,
      success: false,
      error: isRegistrationIssue
        ? 'Connected WhatsApp sender number is not registered yet. Register the number from portal settings using a 6-digit PIN, then try again.'
        : error.message || 'Failed to send WhatsApp message',
      meta: metaError
        ? {
            source: 'meta',
            code: metaError.code || null,
            subcode: metaError.error_subcode || null,
            type: metaError.type || null,
            trace_id: metaError.fbtrace_id || null,
          }
        : {
            source: 'app',
          },
    });
  }
});

module.exports = router;
