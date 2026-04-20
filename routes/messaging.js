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
    let waAccount;
    if (req.body.phone_number_id) {
      waAccount = await WhatsAppAccount.findOne({ tenant_id: req.tenant._id, phone_number_id: req.body.phone_number_id });
    } else if (req.body.account_id) {
      waAccount = await WhatsAppAccount.findOne({ _id: req.body.account_id, tenant_id: req.tenant._id });
    }
    if (!waAccount) {
      // Fall back to default account, then any account
      waAccount = await WhatsAppAccount.findOne({ tenant_id: req.tenant._id, is_default: true })
        || await WhatsAppAccount.findOne({ tenant_id: req.tenant._id });
    }
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

    // 24-hour window enforcement
    const conversation = await Conversation.findOne({
      tenant_id: req.tenant._id,
      contact_phone: recipientPhone?.replace(/[^0-9]/g, ''),
    });

    if (conversation) {
      const isWindowExpired = !conversation.window_expires_at || new Date() > conversation.window_expires_at;
      const messageType = req.body.type || 'text';

      if (isWindowExpired && messageType !== 'template') {
        return apiResponse(res, {
          status: 403,
          success: false,
          error: '24-hour conversation window has expired. Only template messages can be sent. The customer needs to message you first to reopen the window.',
          data: {
            window_expired: true,
            window_expires_at: conversation.window_expires_at,
            last_customer_message_at: conversation.last_customer_message_at,
          },
        });
      }
    }

    // Opt-in check — block messaging to unsubscribed contacts
    const recipientContact = await Contact.findOne({
      tenant_id: req.tenant._id,
      phone: recipientPhone?.replace(/[^0-9]/g, ''),
    });
    if (recipientContact && recipientContact.opt_in === false) {
      const messageType = req.body.type || 'text';
      // Allow resubscribe confirmation templates through
      if (messageType !== 'template' || !req.body._allow_unsubscribed) {
        return apiResponse(res, {
          status: 403,
          success: false,
          error: 'Contact is unsubscribed. They need to send a resubscribe keyword (e.g., "START") before you can message them again.',
          data: {
            unsubscribed: true,
            unsubscribed_at: recipientContact.unsubscribed_at,
            subscription_status: recipientContact.subscription_status,
          },
        });
      }
    }

    const payload = buildMessagePayload({
      ...req.body,
      to: recipientPhone,
    });

    const accessToken = decrypt(waAccount.access_token_encrypted);
    const metaResponse = await metaService.sendRawPayload(
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

    const waAccount = await WhatsAppAccount.findOne({ tenant_id: req.tenant._id, is_default: true }).catch(() => null)
      || await WhatsAppAccount.findOne({ tenant_id: req.tenant._id }).catch(() => null);
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

/* ── Build validated interactive payload ────────────────── */
const buildInteractivePayload = (body) => {
  const { interactive_type, header_text, body_text, footer_text, buttons, sections } = body;

  if (!body_text || !String(body_text).trim()) {
    throw new Error('Body text is required for interactive messages');
  }

  const interactive = { type: interactive_type };

  // Optional header (text only for interactive — Meta restriction)
  if (header_text && String(header_text).trim()) {
    interactive.header = { type: 'text', text: String(header_text).trim().slice(0, 60) };
  }

  // Required body
  interactive.body = { text: String(body_text).trim().slice(0, 1024) };

  // Optional footer
  if (footer_text && String(footer_text).trim()) {
    interactive.footer = { text: String(footer_text).trim().slice(0, 60) };
  }

  // ── Reply Buttons (max 3) ──
  if (interactive_type === 'button') {
    if (!Array.isArray(buttons) || buttons.length === 0 || buttons.length > 3) {
      throw new Error('Reply button messages require 1-3 buttons');
    }
    interactive.action = {
      buttons: buttons.map((btn, i) => ({
        type: 'reply',
        reply: {
          id: btn.id || `btn_${i}`,
          title: String(btn.title || '').trim().slice(0, 20),
        },
      })),
    };
  }

  // ── List Message (max 10 sections, max 10 rows each) ──
  if (interactive_type === 'list') {
    if (!Array.isArray(sections) || sections.length === 0 || sections.length > 10) {
      throw new Error('List messages require 1-10 sections');
    }
    const button_text = String(body.button_text || 'View Options').trim().slice(0, 20);
    interactive.action = {
      button: button_text,
      sections: sections.map((sec) => {
        if (!Array.isArray(sec.rows) || sec.rows.length === 0 || sec.rows.length > 10) {
          throw new Error('Each section must have 1-10 rows');
        }
        return {
          title: String(sec.title || '').trim().slice(0, 24),
          rows: sec.rows.map((row, ri) => ({
            id: row.id || `row_${ri}`,
            title: String(row.title || '').trim().slice(0, 24),
            ...(row.description ? { description: String(row.description).trim().slice(0, 72) } : {}),
          })),
        };
      }),
    };
  }

  return interactive;
};

/* ── Send interactive message (buttons / list) ──────────── */
router.post('/interactive', async (req, res) => {
  try {
    const recipientPhone = String(req.body.phone || '').replace(/[^0-9]/g, '');
    if (!recipientPhone) {
      return apiResponse(res, { status: 400, success: false, error: 'Recipient phone number is required' });
    }

    const interactiveType = req.body.interactive_type;
    if (!interactiveType || !['button', 'list'].includes(interactiveType)) {
      return apiResponse(res, { status: 400, success: false, error: 'interactive_type must be "button" or "list"' });
    }

    let waAccount;
    if (req.body.phone_number_id) {
      waAccount = await WhatsAppAccount.findOne({ tenant_id: req.tenant._id, phone_number_id: req.body.phone_number_id });
    } else if (req.body.account_id) {
      waAccount = await WhatsAppAccount.findOne({ _id: req.body.account_id, tenant_id: req.tenant._id });
    }
    if (!waAccount) {
      waAccount = await WhatsAppAccount.findOne({ tenant_id: req.tenant._id, is_default: true })
        || await WhatsAppAccount.findOne({ tenant_id: req.tenant._id });
    }
    if (!waAccount) {
      return apiResponse(res, { status: 400, success: false, error: 'Connect a WhatsApp account first' });
    }

    // 24-hour window enforcement (interactive messages are not templates)
    const conversation = await Conversation.findOne({
      tenant_id: req.tenant._id,
      contact_phone: recipientPhone,
    });
    if (conversation) {
      const isWindowExpired = !conversation.window_expires_at || new Date() > conversation.window_expires_at;
      if (isWindowExpired) {
        return apiResponse(res, {
          status: 403,
          success: false,
          error: '24-hour conversation window has expired. Interactive messages can only be sent within the window.',
          data: { window_expired: true },
        });
      }
    }

    // Opt-in check
    const recipientContact = await Contact.findOne({
      tenant_id: req.tenant._id,
      phone: recipientPhone,
    });
    if (recipientContact && recipientContact.opt_in === false) {
      return apiResponse(res, {
        status: 403,
        success: false,
        error: 'Contact is unsubscribed.',
        data: { unsubscribed: true },
      });
    }

    // Build and validate the interactive payload
    let interactive;
    if (req.body.interactive && typeof req.body.interactive === 'object') {
      // Raw passthrough (backward-compatible)
      interactive = req.body.interactive;
    } else {
      interactive = buildInteractivePayload(req.body);
    }

    const accessToken = decrypt(waAccount.access_token_encrypted);
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipientPhone,
      type: 'interactive',
      interactive,
    };

    const metaResponse = await metaService.sendRawPayload(
      waAccount.phone_number_id,
      accessToken,
      payload,
    );

    const stored = await recordOutboundMessage({
      tenantId: req.tenant._id,
      userId: req.user._id,
      wabaId: waAccount.waba_id,
      phoneNumberId: waAccount.phone_number_id,
      to: recipientPhone,
      type: 'interactive',
      payload,
      whatsappMessageId: metaResponse.messages?.[0]?.id || null,
      status: 'sent',
      messageSource: 'interactive',
    });

    return apiResponse(res, { status: 201, data: { message: stored.message, meta: metaResponse } });
  } catch (error) {
    console.error('[Messaging][Interactive] Failed', error.message);
    return apiResponse(res, { status: error.status || 500, success: false, error: error.message || 'Failed to send interactive message' });
  }
});

module.exports = router;
