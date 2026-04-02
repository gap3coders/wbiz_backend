const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const config = require('../config');
const WebhookEvent = require('../models/WebhookEvent');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const Message = require('../models/Message');
const Contact = require('../models/Contact');
const Notification = require('../models/Notification');
const { processInboundAutoResponses } = require('../services/autoResponseService');
const { parsePhoneInput } = require('../utils/phone');

const router = express.Router();
const WEBHOOK_HANDLER_VERSION = '2026-04-01-single-phone-v6';
const WEBHOOK_BOOT_MARKER = `${WEBHOOK_HANDLER_VERSION}-pid-${process.pid}`;

const normalizePhone = (value) => String(value || '').replace(/[^\d]/g, '');

const logInboundStage = (stage, payload = {}) => {
  if (!config.verboseLogs) return;
  console.info('[Meta Webhook][Inbound Stage]', {
    version: WEBHOOK_HANDLER_VERSION,
    stage,
    ...payload,
  });
};

if (config.verboseLogs) {
  console.info('[Meta Webhook][Handler Loaded]', {
    version: WEBHOOK_HANDLER_VERSION,
    boot_marker: WEBHOOK_BOOT_MARKER,
    pid: process.pid,
  });
}

const toObjectId = (value) => {
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (mongoose.Types.ObjectId.isValid(value)) return new mongoose.Types.ObjectId(String(value));
  throw new Error('Invalid tenant id for contact upsert');
};

const publishThreadDebugMessage = async ({ tenantId, phone, name, source, messageId, details }) => {
  if (!tenantId || !phone) return null;
  const summary = `[Webhook Debug ${WEBHOOK_HANDLER_VERSION}] ${source} failed: ${details}`;
  return Message.create({
    tenant_id: tenantId,
    contact_phone: phone,
    contact_name: name || '',
    direction: 'outbound',
    message_type: 'unknown',
    content: summary.slice(0, 900),
    wa_message_id: null,
    status: 'failed',
    error_message: summary.slice(0, 500),
    error_source: 'platform',
    timestamp: new Date(),
  }).catch(() => null);
};

const logWebhookCritical = (stage, payload = {}) => {
  console.error('[Meta Webhook][Critical]', {
    version: WEBHOOK_HANDLER_VERSION,
    boot_marker: WEBHOOK_BOOT_MARKER,
    stage,
    ...payload,
  });
};

const upsertContact = async ({ tenantId, phone, name = '' }) => {
  try {
    logInboundStage('contact_lookup_start', { tenant_id: String(tenantId), phone });
    const parsedPhone = parsePhoneInput({ phone });
    const resolvedPhone = parsedPhone.phone || phone;

    const tenantObjectId = toObjectId(tenantId);
    const now = new Date();
    const setFields = {
      phone: resolvedPhone,
      country_code: parsedPhone.country_code || '',
      phone_number: parsedPhone.phone_number || '',
      whatsapp_id: resolvedPhone,
      wa_name: name,
      profile_name: name,
      last_message_at: now,
      last_inbound_at: now,
      wa_exists: 'yes',
      updated_at: now,
    };

    if (name) setFields.name = name;

    const collection = Contact.collection;
    const phoneQuery = { tenant_id: tenantObjectId, phone: resolvedPhone };
    let writeResult = await collection.updateOne(phoneQuery, { $set: setFields });

    if (!writeResult.matchedCount) {
      try {
        await collection.insertOne({
          tenant_id: tenantObjectId,
          phone: resolvedPhone,
          country_code: parsedPhone.country_code || '',
          phone_number: parsedPhone.phone_number || '',
          whatsapp_id: resolvedPhone,
          name: name || '',
          wa_name: name,
          profile_name: name,
          wa_exists: 'yes',
          last_message_at: now,
          last_inbound_at: now,
          created_at: now,
          updated_at: now,
        });
      } catch (insertError) {
        if (insertError?.code !== 11000) {
          throw insertError;
        }
        await collection.updateOne(phoneQuery, { $set: setFields });
      }
    }

    const contact = await collection.findOne(
      {
        tenant_id: tenantObjectId,
        phone: resolvedPhone,
      },
      {
        projection: { _id: 1, phone: 1, whatsapp_id: 1, name: 1, wa_name: 1, profile_name: 1 },
      }
    );

    logInboundStage('contact_save_done', {
      tenant_id: String(tenantId),
      phone,
      contact_id: contact?._id ? String(contact._id) : null,
      matched_count: writeResult?.matchedCount ?? null,
      modified_count: writeResult?.modifiedCount ?? null,
    });

    return contact;
  } catch (error) {
    try {
      const tenantObjectId = toObjectId(tenantId);
      const now = new Date();
      const fallbackFields = {
        phone,
        whatsapp_id: phone,
        wa_name: name,
        profile_name: name,
        last_message_at: now,
        last_inbound_at: now,
        wa_exists: 'yes',
        updated_at: now,
      };
      if (name) fallbackFields.name = name;

      const collection = Contact.collection;
      const phoneQuery = { tenant_id: tenantObjectId, phone };
      await collection.updateOne(phoneQuery, { $set: fallbackFields });

      let contact = await collection.findOne(phoneQuery, {
        projection: { _id: 1, phone: 1, whatsapp_id: 1, name: 1, wa_name: 1, profile_name: 1 },
      });
      if (contact) {
        logInboundStage('contact_save_done_fallback_update', {
          tenant_id: String(tenantId),
          phone,
          contact_id: String(contact._id),
        });
        return contact;
      }

      try {
        await collection.insertOne({
          tenant_id: tenantObjectId,
          phone,
          whatsapp_id: phone,
          name: name || '',
          wa_name: name,
          profile_name: name,
          wa_exists: 'yes',
          last_message_at: now,
          last_inbound_at: now,
          created_at: now,
          updated_at: now,
        });
      } catch (insertError) {
        if (insertError?.code !== 11000) {
          throw insertError;
        }
      }

      contact = await collection.findOne(
        {
          tenant_id: tenantObjectId,
          phone,
        },
        {
          projection: { _id: 1, phone: 1, whatsapp_id: 1, name: 1, wa_name: 1, profile_name: 1 },
        }
      );
      if (contact) {
        logInboundStage('contact_save_done_fallback_create', {
          tenant_id: String(tenantId),
          phone,
          contact_id: String(contact._id),
        });
        return contact;
      }
    } catch (fallbackError) {
      logWebhookCritical('contact_upsert_fallback_failed', {
        tenant_id: String(tenantId),
        phone,
        name,
        error: fallbackError.message,
        error_code: fallbackError?.code || null,
        error_name: fallbackError?.name || null,
      });
      console.error('[Meta Webhook][Contact Upsert Fallback Failed]', {
        version: WEBHOOK_HANDLER_VERSION,
        tenant_id: String(tenantId),
        phone,
        name,
        error: fallbackError.message,
        stack: fallbackError.stack,
      });
      const wrappedFallbackError = new Error(`[Inbound Contact Save Fallback] ${fallbackError.message}`);
      wrappedFallbackError.debug_context = {
        phase: 'fallback',
        phone,
        tenant_id: String(tenantId),
      };
      throw wrappedFallbackError;
    }

    logWebhookCritical('contact_upsert_primary_failed', {
      tenant_id: String(tenantId),
      phone,
      name,
      error: error.message,
      error_code: error?.code || null,
      error_name: error?.name || null,
    });
    console.error('[Meta Webhook][Contact Upsert Failed]', {
      version: WEBHOOK_HANDLER_VERSION,
      tenant_id: String(tenantId),
      phone,
      name,
      error: error.message,
      stack: error.stack,
    });
    const wrappedError = new Error(`[Inbound Contact Save] ${error.message}`);
    wrappedError.debug_context = {
      phase: 'primary',
      phone,
      tenant_id: String(tenantId),
    };
    throw wrappedError;
  }
};

const compareSignatures = (left, right) => {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const buildIncomingContent = (message) => {
  if (message.type === 'text') return message.text?.body || '';
  if (message.type === 'image') return message.image?.caption || '[Image]';
  if (message.type === 'document') return message.document?.caption || `[Document: ${message.document?.filename || 'file'}]`;
  if (message.type === 'video') return message.video?.caption || '[Video]';
  if (message.type === 'audio') return '[Audio]';
  if (message.type === 'location') return '[Location]';
  if (message.type === 'reaction') return message.reaction?.emoji || '[Reaction]';
  if (message.type === 'sticker') return '[Sticker]';
  return `[${message.type || 'unknown'}]`;
};

const processMessageChange = async (tenantId, change) => {
  const value = change.value || {};

  for (const inbound of (value.messages || [])) {
    const phone = normalizePhone(inbound.from);
    if (!phone || !inbound.id) continue;
    const name = value.contacts?.find((contact) => contact.wa_id === phone)?.profile?.name || value.contacts?.[0]?.profile?.name || '';
    const previewText = buildIncomingContent(inbound);

    logInboundStage('message_received', {
      tenant_id: String(tenantId),
      from: phone,
      message_id: inbound.id || null,
      message_type: inbound.type || 'unknown',
    });

    const existingInbound = await Message.findOne({
      tenant_id: tenantId,
      wa_message_id: inbound.id,
    })
      .select('_id')
      .lean();

    try {
      await upsertContact({ tenantId, phone, name });
    } catch (error) {
      logWebhookCritical('process_message_contact_upsert_failed', {
        tenant_id: String(tenantId),
        from: phone,
        message_id: inbound.id || null,
        message_type: inbound.type || null,
        error: error.message,
      });
      console.error('[Meta Webhook][Contact Save NonBlocking Failed]', {
        version: WEBHOOK_HANDLER_VERSION,
        tenant_id: String(tenantId),
        from: phone,
        message_id: inbound.id || null,
        error: error.message,
        debug_context: error.debug_context || null,
      });
      await publishThreadDebugMessage({
        tenantId,
        phone,
        name,
        source: 'contact_upsert',
        messageId: inbound.id || null,
        details: error.message,
      });
      await Notification.create({
        tenant_id: tenantId,
        type: 'webhook_error',
        title: `Webhook Debug ${WEBHOOK_HANDLER_VERSION}`,
        message: `[Platform] Contact upsert failed for ${phone}: ${error.message}`,
        source: 'platform',
        severity: 'error',
        link: `/portal/inbox?phone=${phone}`,
        meta_data: {
          source: 'contact_upsert',
          debug_marker: WEBHOOK_BOOT_MARKER,
          debug_context: error.debug_context || null,
          inbound_wa_message_id: inbound.id || null,
        },
      }).catch(() => null);
    }

    if (existingInbound) {
      if (config.verboseLogs) {
        console.info('[Meta Webhook][Inbound Duplicate Ignored]', {
          tenant_id: String(tenantId),
          from: phone,
          message_id: inbound.id || null,
        });
      }
      continue;
    }

    try {
      logInboundStage('message_create_start', {
        tenant_id: String(tenantId),
        from: phone,
        message_id: inbound.id || null,
      });

      await Message.create({
        tenant_id: tenantId,
        contact_phone: phone,
        contact_name: name,
        direction: 'inbound',
        message_type: inbound.type || 'unknown',
        content: previewText,
        wa_message_id: inbound.id,
        status: 'delivered',
        media_id: inbound.image?.id || inbound.document?.id || inbound.video?.id || inbound.audio?.id || null,
        media_mime: inbound.image?.mime_type || inbound.document?.mime_type || inbound.video?.mime_type || inbound.audio?.mime_type || null,
        media_filename: inbound.document?.filename || null,
        timestamp: inbound.timestamp ? new Date(parseInt(inbound.timestamp, 10) * 1000) : new Date(),
      });

      logInboundStage('message_create_done', {
        tenant_id: String(tenantId),
        from: phone,
        message_id: inbound.id || null,
      });
    } catch (error) {
      if (error?.code === 11000) {
        if (config.verboseLogs) {
          console.info('[Meta Webhook][Inbound Duplicate Race Ignored]', {
            tenant_id: String(tenantId),
            from: phone,
            message_id: inbound.id || null,
          });
        }
        continue;
      }
      throw error;
    }

    logInboundStage('notification_create_start', {
      tenant_id: String(tenantId),
      from: phone,
      message_id: inbound.id || null,
    });

    await Notification.create({
      tenant_id: tenantId,
      type: 'system',
      title: `New message from ${name || phone}`,
      message: `[Meta] ${previewText || 'New inbound WhatsApp message received.'}`,
      source: 'meta',
      severity: 'info',
      link: `/portal/inbox?phone=${phone}`,
      meta_data: {
        contact_phone: phone,
        wa_message_id: inbound.id,
        direction: 'inbound',
        message_type: inbound.type || 'unknown',
      },
    }).catch((error) => {
      console.error('[Meta Webhook][Notification Create Failed]', {
        version: WEBHOOK_HANDLER_VERSION,
        tenant_id: String(tenantId),
        from: phone,
        message_id: inbound.id || null,
        error: error.message,
      });
      return null;
    });

    logInboundStage('notification_create_done', {
      tenant_id: String(tenantId),
      from: phone,
      message_id: inbound.id || null,
    });

    try {
      await processInboundAutoResponses({
        tenantId,
        inboundMessage: inbound,
      });
      logInboundStage('auto_response_done', {
        tenant_id: String(tenantId),
        from: phone,
        message_id: inbound.id || null,
      });
    } catch (error) {
      console.error('[Meta Webhook][Auto Response Failed]', {
        version: WEBHOOK_HANDLER_VERSION,
        tenant_id: String(tenantId),
        from: phone,
        message_id: inbound.id || null,
        error: error.message,
      });
      await Notification.create({
        tenant_id: tenantId,
        type: 'webhook_error',
        title: `Auto response processing failed`,
        message: `[Platform] Auto response failed for ${phone}: ${error.message}`,
        source: 'platform',
        severity: 'error',
        link: `/portal/auto-responses`,
        meta_data: {
          source: 'auto_response',
          inbound_wa_message_id: inbound.id || null,
          debug_marker: WEBHOOK_BOOT_MARKER,
        },
      }).catch(() => null);
    }

    if (config.verboseLogs) {
      console.info('[Meta Webhook][Inbound Message]', {
        tenant_id: String(tenantId),
        from: phone,
        message_id: inbound.id || null,
        message_type: inbound.type || 'unknown',
      });
    }

  }

  for (const statusUpdate of (value.statuses || [])) {
    if (!statusUpdate.id) continue;

    const update = { status: statusUpdate.status };
    if (statusUpdate.status === 'failed' && statusUpdate.errors?.length) {
      update.error_message = statusUpdate.errors[0]?.title || statusUpdate.errors[0]?.message || 'Unknown error';
      update.error_source = 'meta';

      await Notification.create({
        tenant_id: tenantId,
        type: 'message_failed',
        title: 'Message Delivery Failed',
        message: `[Meta Error] ${update.error_message} (Code: ${statusUpdate.errors[0]?.code || 'unknown'})`,
        source: 'meta',
        severity: 'error',
        meta_data: statusUpdate.errors[0],
      });
    }

    await Message.findOneAndUpdate(
      { tenant_id: tenantId, wa_message_id: statusUpdate.id },
      {
        $set: update,
        $setOnInsert: {
          tenant_id: tenantId,
          contact_phone: statusUpdate.recipient_id || 'unknown',
          contact_name: '',
          direction: 'outbound',
          message_type: 'unknown',
          content: '[Meta status update]',
          wa_message_id: statusUpdate.id,
          timestamp: statusUpdate.timestamp ? new Date(parseInt(statusUpdate.timestamp, 10) * 1000) : new Date(),
        },
      },
      { upsert: true, new: true }
    );

    if (config.verboseLogs) {
      console.info('[Meta Webhook][Status Update]', {
        tenant_id: String(tenantId),
        recipient_id: statusUpdate.recipient_id || null,
        wa_message_id: statusUpdate.id,
        status: statusUpdate.status || 'unknown',
        error_code: statusUpdate.errors?.[0]?.code || null,
        error_message: statusUpdate.errors?.[0]?.title || statusUpdate.errors?.[0]?.message || null,
      });
    }
  }
};

const processNonMessageChange = async (tenantId, change) => {
  if (change.field === 'message_template_status_update') {
    const template = change.value || {};
    const typeMap = { APPROVED: 'template_approved', REJECTED: 'template_rejected', PAUSED: 'template_paused', PENDING_DELETION: 'template_paused' };
    const severityMap = { APPROVED: 'success', REJECTED: 'error', PAUSED: 'warning' };

    await Notification.create({
      tenant_id: tenantId,
      type: typeMap[template.event] || 'system',
      title: `Template ${template.event}: ${template.message_template_name || 'Unknown'}`,
      message: `[Meta] Template "${template.message_template_name}" status changed to ${template.event}.${template.reason ? ` Reason: ${template.reason}` : ''}`,
      source: 'meta',
      severity: severityMap[template.event] || 'info',
      link: '/portal/templates',
      meta_data: template,
    });

    if (config.verboseLogs) {
      console.info('[Meta Webhook][Template Status Update]', {
        tenant_id: String(tenantId),
        template_name: template.message_template_name || null,
        event: template.event || null,
        reason: template.reason || null,
      });
    }
    return;
  }

  if (change.field === 'account_update') {
    const account = change.value || {};
    await Notification.create({
      tenant_id: tenantId,
      type: 'account_warning',
      title: 'Meta Account Update',
      message: `[Meta] ${account.ban_info ? `Account restricted: ${JSON.stringify(account.ban_info)}` : 'Account status changed.'}`,
      source: 'meta',
      severity: account.ban_info ? 'error' : 'warning',
      meta_data: account,
    });

    if (config.verboseLogs) {
      console.info('[Meta Webhook][Account Update]', {
        tenant_id: String(tenantId),
        has_ban_info: Boolean(account.ban_info),
      });
    }
    return;
  }

  if (change.field === 'phone_number_quality_update') {
    const quality = change.value || {};
    await Notification.create({
      tenant_id: tenantId,
      type: 'quality_change',
      title: 'Quality Rating Changed',
      message: `[Meta] Phone number quality changed to ${quality.current_limit || 'unknown'}. Previous: ${quality.previous_limit || 'unknown'}`,
      source: 'meta',
      severity: quality.current_limit === 'TIER_1000' ? 'warning' : 'info',
      meta_data: quality,
    });

    if (config.verboseLogs) {
      console.info('[Meta Webhook][Phone Quality Update]', {
        tenant_id: String(tenantId),
        current_limit: quality.current_limit || null,
        previous_limit: quality.previous_limit || null,
      });
    }
  }
};

router.get('/meta', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === config.meta.webhookVerifyToken) return res.status(200).send(challenge);
  return res.status(403).send('Forbidden');
});

router.get('/meta/debug-version', (req, res) => {
  return res.status(200).json({
    success: true,
    data: {
      webhook_handler_version: WEBHOOK_HANDLER_VERSION,
      webhook_boot_marker: WEBHOOK_BOOT_MARKER,
      pid: process.pid,
      trust_proxy: config.trustProxy,
      verbose_logs: config.verboseLogs,
    },
  });
});

router.post('/meta', async (req, res) => {
  try {
    console.error('[Meta Webhook][Runtime]', {
      version: WEBHOOK_HANDLER_VERSION,
      boot_marker: WEBHOOK_BOOT_MARKER,
      path: req.originalUrl,
      method: req.method,
      has_signature: Boolean(req.headers['x-hub-signature-256']),
      entry_count: Array.isArray(req.body?.entry) ? req.body.entry.length : 0,
    });

    const signature = req.headers['x-hub-signature-256'];
    if (!signature) {
      console.warn('[Meta Webhook][Signature Missing]', {
        path: req.originalUrl,
      });
      return res.status(403).send('Missing signature');
    }

    const rawBody = req.rawBody || JSON.stringify(req.body);
    const expected = `sha256=${crypto.createHmac('sha256', config.meta.appSecret).update(rawBody, 'utf8').digest('hex')}`;
    if (!compareSignatures(signature, expected)) {
      console.warn('[Meta Webhook][Signature Invalid]', {
        path: req.originalUrl,
        entry_count: Array.isArray(req.body?.entry) ? req.body.entry.length : 0,
      });
      return res.status(403).send('Invalid signature');
    }

    if (config.verboseLogs) {
      console.info('[Meta Webhook][Callback Received]', {
        entry_count: Array.isArray(req.body?.entry) ? req.body.entry.length : 0,
        change_count: Array.isArray(req.body?.entry)
          ? req.body.entry.reduce((count, entry) => count + (Array.isArray(entry?.changes) ? entry.changes.length : 0), 0)
          : 0,
      });
    }

    res.status(200).send('EVENT_RECEIVED');

    for (const entry of (req.body?.entry || [])) {
      const wabaId = entry.id;
      const wa = await WhatsAppAccount.findOne({ waba_id: wabaId });
      const tenantId = wa?.tenant_id || null;

      for (const change of (entry.changes || [])) {
        const event = await WebhookEvent.create({
          tenant_id: tenantId,
          waba_id: wabaId,
          event_type: change.field || 'unknown',
          payload: { entry_id: wabaId, change },
          processing_status: 'pending',
        });

        try {
          if (!tenantId) {
            event.processing_status = 'skipped';
            event.error_message = 'No tenant matched this webhook WABA.';
            event.processed_at = new Date();
            await event.save();

            console.warn('[Platform Webhook][Skipped]', {
              waba_id: wabaId || null,
              field: change.field || 'unknown',
              reason: 'No tenant matched this webhook WABA.',
            });
            continue;
          }

          if (change.field === 'messages') {
            await processMessageChange(tenantId, change);
          } else {
            await processNonMessageChange(tenantId, change);
          }

          event.processing_status = 'processed';
          event.processed_at = new Date();
          await event.save();

          if (config.verboseLogs) {
            console.info('[Platform Webhook][Processed]', {
              tenant_id: String(tenantId),
              waba_id: wabaId || null,
              field: change.field || 'unknown',
              event_id: String(event._id),
            });
          }
        } catch (error) {
          const failureLine = String(error?.stack || '')
            .split('\n')
            .map((line) => line.trim())
            .find((line) => line.startsWith('at '))
            || null;

          console.error('[Platform Webhook][Processing Failed]', {
            tenant_id: tenantId ? String(tenantId) : null,
            waba_id: wabaId || null,
            field: change.field || 'unknown',
            error: error.message,
            error_name: error?.name || null,
            error_code: error?.code || null,
            failure_line: failureLine,
            version: WEBHOOK_HANDLER_VERSION,
            boot_marker: WEBHOOK_BOOT_MARKER,
            payload_sample: {
              from: normalizePhone(change?.value?.messages?.[0]?.from),
              wa_message_id: change?.value?.messages?.[0]?.id || null,
              type: change?.value?.messages?.[0]?.type || null,
            },
          });

          event.processing_status = 'failed';
          event.error_message = `[${WEBHOOK_HANDLER_VERSION}] ${error.message}${failureLine ? ` | ${failureLine}` : ''}`;
          event.processed_at = new Date();
          event.retry_count = (event.retry_count || 0) + 1;
          await event.save().catch(() => {});

          if (tenantId) {
            const failedPhone = normalizePhone(change?.value?.messages?.[0]?.from);
            const failedName = change?.value?.contacts?.[0]?.profile?.name || '';
            await Notification.create({
              tenant_id: tenantId,
              type: 'webhook_error',
              title: `Webhook Processing Error ${WEBHOOK_HANDLER_VERSION}`,
              message: `[Platform] ${change.field || 'unknown'} webhook failed: ${error.message}`,
              source: 'platform',
              severity: 'error',
              link: failedPhone ? `/portal/inbox?phone=${failedPhone}` : '/portal/logs',
              meta_data: {
                field: change.field,
                error: error.message,
                failure_line: failureLine,
                version: WEBHOOK_HANDLER_VERSION,
                boot_marker: WEBHOOK_BOOT_MARKER,
                sample_from: failedPhone || null,
                sample_message_id: change?.value?.messages?.[0]?.id || null,
              },
            }).catch(() => {});
            await publishThreadDebugMessage({
              tenantId,
              phone: failedPhone,
              name: failedName,
              source: `change_${change.field || 'unknown'}`,
              messageId: change?.value?.messages?.[0]?.id || null,
              details: `${error.message}${failureLine ? ` | ${failureLine}` : ''}`,
            });
          }
        }
      }
    }
  } catch (error) {
    console.error('[Platform Webhook][Unhandled Error]', error);
  }
});

module.exports = router;
