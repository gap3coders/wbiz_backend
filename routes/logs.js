const express = require('express');
const config = require('../config');
const { authenticate, requireStatus } = require('../middleware/auth');
const metaService = require('../services/metaService');
const { decrypt } = require('../services/encryptionService');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const WebhookEvent = require('../models/WebhookEvent');
const Message = require('../models/Message');
const { apiResponse } = require('../utils/helpers');

const router = express.Router();

const clamp = (value, min, max, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
};

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const isPrivateIpv4 = (hostname) => {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return false;
  if (hostname.startsWith('10.')) return true;
  if (hostname.startsWith('127.')) return true;
  if (hostname.startsWith('192.168.')) return true;
  if (hostname === '0.0.0.0') return true;
  const octets = hostname.split('.').map(Number);
  return octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31;
};

const getCallbackDetails = (callbackUrl) => {
  if (!callbackUrl) {
    return {
      callback_url: null,
      host: null,
      path: null,
      is_localhost: false,
      is_private_network: false,
      is_publicly_reachable: null,
      invalid_url: false,
    };
  }

  try {
    const parsed = new URL(callbackUrl);
    const hostname = parsed.hostname.toLowerCase();
    const isLocalhost = ['localhost', '::1'].includes(hostname) || hostname.endsWith('.localhost');
    const isPrivateNetwork = isPrivateIpv4(hostname);

    return {
      callback_url: callbackUrl,
      host: parsed.host,
      path: parsed.pathname,
      is_localhost: isLocalhost,
      is_private_network: isPrivateNetwork,
      is_publicly_reachable: !(isLocalhost || isPrivateNetwork),
      invalid_url: false,
    };
  } catch (error) {
    return {
      callback_url: callbackUrl,
      host: null,
      path: null,
      is_localhost: false,
      is_private_network: false,
      is_publicly_reachable: null,
      invalid_url: true,
    };
  }
};

const extractAppId = (item) => item?.id || item?.app_id || item?.application?.id || item?.whatsapp_business_api_data?.id || null;
const extractAppName = (item) => item?.name || item?.application?.name || item?.whatsapp_business_api_data?.name || null;
const normalizeSubscriptionFields = (fields) =>
  (Array.isArray(fields) ? fields : [])
    .map((field) => {
      if (typeof field === 'string') return field;
      if (field && typeof field === 'object') {
        return field.name || field.field || field.subscription_field || field.object || null;
      }
      return null;
    })
    .filter(Boolean);

const extractChange = (payload) => payload?.change || payload?.changes?.[0] || payload?.entry?.[0]?.changes?.[0] || null;

const summarizeWebhookEvent = (event) => {
  const change = extractChange(event.payload);
  const value = change?.value || {};
  const inboundMessage = value.messages?.[0] || null;
  const messageStatus = value.statuses?.[0] || null;

  let summary = 'Webhook event recorded';
  let level = 'info';
  let contactPhone = null;
  let waMessageId = null;
  let metaStatus = null;

  if (change?.field === 'messages' && messageStatus) {
    contactPhone = messageStatus.recipient_id || null;
    waMessageId = messageStatus.id || null;
    metaStatus = messageStatus.status || null;
    summary = `Outbound message ${messageStatus.status || 'update'}${contactPhone ? ` for ${contactPhone}` : ''}`;
    if (messageStatus.status === 'failed') level = 'error';
    else if (['delivered', 'read'].includes(messageStatus.status)) level = 'success';
  } else if (change?.field === 'messages' && inboundMessage) {
    contactPhone = inboundMessage.from || null;
    waMessageId = inboundMessage.id || null;
    metaStatus = inboundMessage.type || null;
    summary = `Inbound ${inboundMessage.type || 'message'}${contactPhone ? ` from ${contactPhone}` : ''}`;
    level = 'success';
  } else if (change?.field === 'message_template_status_update') {
    summary = `Template ${value.event || 'update'}: ${value.message_template_name || 'unknown template'}`;
    metaStatus = value.event || null;
    level = value.event === 'REJECTED' ? 'error' : value.event === 'APPROVED' ? 'success' : 'warning';
  } else if (change?.field === 'account_update') {
    summary = value?.ban_info ? 'Meta account restriction update received' : 'Meta account update received';
    level = value?.ban_info ? 'error' : 'warning';
  } else if (change?.field === 'phone_number_quality_update') {
    summary = `Phone quality update: ${value.current_limit || value.current_quality_rating || 'unknown'}`;
    metaStatus = value.current_limit || value.current_quality_rating || null;
    level = 'warning';
  }

  if (event.processing_status === 'failed') level = 'error';
  if (event.processing_status === 'skipped' && level !== 'error') level = 'warning';

  return {
    _id: event._id,
    created_at: event.created_at,
    updated_at: event.updated_at,
    event_type: event.event_type || change?.field || 'unknown',
    processing_status: event.processing_status,
    error_message: event.error_message || null,
    contact_phone: contactPhone,
    wa_message_id: waMessageId,
    meta_status: metaStatus,
    level,
    summary,
    payload: event.payload,
  };
};

router.get('/whatsapp', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const hours = clamp(req.query.hours, 1, 24 * 30, 72);
    const requestedWebhookPage = parsePositiveInt(req.query.webhook_page, 1);
    const requestedOutboundPage = parsePositiveInt(req.query.outbound_page, 1);
    const limitEvents = clamp(req.query.limit_events, 5, 100, 10);
    const limitMessages = clamp(req.query.limit_messages, 5, 100, 10);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const pendingCutoff = new Date(Date.now() - 5 * 60 * 1000);
    const tenantId = req.tenant._id;
    const webhookQuery = { tenant_id: tenantId, created_at: { $gte: since } };
    const outboundQuery = { tenant_id: tenantId, direction: 'outbound', timestamp: { $gte: since } };

    const [waAccount, totalWebhookEvents, totalOutboundMessages, eventStatusAgg, messageStatusAgg, lastWebhook, pendingDeliveryUpdates] = await Promise.all([
      WhatsAppAccount.findOne({ tenant_id: tenantId, is_default: true }).lean().then(a => a || WhatsAppAccount.findOne({ tenant_id: tenantId }).lean()),
      WebhookEvent.countDocuments(webhookQuery),
      Message.countDocuments(outboundQuery),
      WebhookEvent.aggregate([
        { $match: webhookQuery },
        { $group: { _id: '$processing_status', count: { $sum: 1 } } },
      ]),
      Message.aggregate([
        { $match: outboundQuery },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      WebhookEvent.findOne({ tenant_id: tenantId }).sort({ created_at: -1 }).lean(),
      Message.countDocuments({
        ...outboundQuery,
        status: { $in: ['queued', 'sent'] },
        $or: [
          { updated_at: { $lte: pendingCutoff } },
          { created_at: { $lte: pendingCutoff } },
          { timestamp: { $lte: pendingCutoff } },
        ],
      }),
    ]);

    const webhookPages = Math.max(1, Math.ceil(totalWebhookEvents / limitEvents));
    const outboundPages = Math.max(1, Math.ceil(totalOutboundMessages / limitMessages));
    const webhookPage = Math.min(requestedWebhookPage, webhookPages);
    const outboundPage = Math.min(requestedOutboundPage, outboundPages);

    const [events, outboundMessages] = await Promise.all([
      WebhookEvent.find(webhookQuery)
        .sort({ created_at: -1 })
        .skip((webhookPage - 1) * limitEvents)
        .limit(limitEvents)
        .lean(),
      Message.find(outboundQuery)
        .sort({ timestamp: -1 })
        .skip((outboundPage - 1) * limitMessages)
        .limit(limitMessages)
        .lean(),
    ]);

    const webhookTotals = { processed: 0, failed: 0, skipped: 0, pending: 0 };
    eventStatusAgg.forEach((row) => { webhookTotals[row._id] = row.count; });

    const messageTotals = { queued: 0, sent: 0, delivered: 0, read: 0, failed: 0 };
    messageStatusAgg.forEach((row) => { messageTotals[row._id] = row.count; });

    const diagnostics = [];
    const metaWebhook = {
      app_id: config.meta.appId || null,
      waba_id: waAccount?.waba_id || null,
      phone_number_id: waAccount?.phone_number_id || null,
      app_subscription: null,
      waba_subscription: null,
      lookup_error: null,
    };

    if (!lastWebhook) {
      diagnostics.push({
        level: 'warning',
        title: 'No webhook callbacks recorded yet',
        message: 'Meta can accept sends without delivering status updates back to this app. Verify your webhook subscription, callback URL, and app signature setup.',
      });
    } else {
      diagnostics.push({
        level: webhookTotals.failed > 0 ? 'warning' : 'success',
        title: 'Webhook callbacks are reaching the app',
        message: `Last webhook received at ${new Date(lastWebhook.created_at).toLocaleString()}.`,
      });
    }

    if (!waAccount) {
      diagnostics.push({
        level: 'error',
        title: 'No connected WhatsApp account found',
        message: 'This tenant does not have a saved WABA connection, so Meta webhook status cannot be checked yet.',
      });
    } else {
      try {
        const [appSubscriptions, wabaSubscribedApps] = await Promise.all([
          metaService.getAppSubscriptions(),
          metaService.getWabaSubscribedApps(waAccount.waba_id, decrypt(waAccount.access_token_encrypted)),
        ]);

        const appSubscription = (appSubscriptions || []).find((item) => item.object === 'whatsapp_business_account') || null;
        const callbackDetails = getCallbackDetails(appSubscription?.callback_url || null);
        const normalizedWabaApps = (wabaSubscribedApps || []).map((item) => ({
          app_id: extractAppId(item),
          name: extractAppName(item),
          subscribed_fields: normalizeSubscriptionFields(Array.isArray(item?.subscribed_fields) ? item.subscribed_fields : item?.fields),
          raw: item,
        }));
        const currentAppSubscription = normalizedWabaApps.find((item) => item.app_id && String(item.app_id) === String(config.meta.appId)) || null;
        const appFields = normalizeSubscriptionFields(appSubscription?.fields);

        metaWebhook.app_subscription = appSubscription ? {
          object: appSubscription.object,
          active: appSubscription.active !== false,
          fields: appFields,
          ...callbackDetails,
        } : null;
        metaWebhook.waba_subscription = {
          is_current_app_subscribed: Boolean(currentAppSubscription),
          subscribed_apps: normalizedWabaApps,
        };

        if (!appSubscription) {
          diagnostics.push({
            level: 'error',
            title: 'Meta app webhook subscription is missing',
            message: 'The Meta app does not currently show a whatsapp_business_account webhook subscription, so inbound chats and delivery updates will never reach this server.',
          });
        } else {
          diagnostics.push({
            level: appSubscription.active === false ? 'warning' : 'success',
            title: 'Meta app webhook subscription found',
            message: callbackDetails.callback_url
              ? `Meta currently points whatsapp_business_account webhooks to ${callbackDetails.callback_url}.`
              : 'Meta currently shows a whatsapp_business_account webhook subscription.',
          });

          if (!appFields.includes('messages')) {
            diagnostics.push({
              level: 'error',
              title: 'Meta webhook is not subscribed to messages',
              message: 'The app subscription does not include the messages field, so inbound messages and delivery status updates will not be delivered to this app.',
            });
          }

          if (!appFields.includes('message_template_status_update')) {
            diagnostics.push({
              level: 'warning',
              title: 'Template approval callbacks are not subscribed',
              message: 'The app subscription does not include the message_template_status_update field, so template approved/rejected notifications may not arrive in real time.',
            });
          }

          if (callbackDetails.invalid_url) {
            diagnostics.push({
              level: 'warning',
              title: 'Meta callback URL looks invalid',
              message: `Meta returned a callback URL that could not be parsed: ${callbackDetails.callback_url}.`,
            });
          } else if (callbackDetails.is_localhost || callbackDetails.is_private_network) {
            diagnostics.push({
              level: 'error',
              title: 'Meta callback URL is not publicly reachable',
              message: `Meta is sending webhooks to ${callbackDetails.callback_url}. Localhost or private-network URLs cannot receive Meta callbacks from the internet, so Live Chat will stay empty until you use a public HTTPS webhook URL.`,
            });
          }
        }

        if (!currentAppSubscription) {
          diagnostics.push({
            level: 'error',
            title: 'This WABA is not subscribed to the current Meta app',
            message: 'Meta does not show the current app attached to this WhatsApp Business Account. Sends can still work with tokens, but webhook events will not be forwarded here until the WABA is subscribed.',
          });
        } else {
          diagnostics.push({
            level: 'success',
            title: 'Meta shows this WABA subscribed to the app',
            message: 'The current WhatsApp Business Account is linked to the app on Meta.',
          });
        }

        if (!lastWebhook && currentAppSubscription && appSubscription && callbackDetails.is_publicly_reachable) {
          diagnostics.push({
            level: 'warning',
            title: 'Meta shows a valid subscription but this server has not received callbacks',
            message: 'Meta-side subscription looks present, but no webhook event has been stored locally yet. Double-check your deployed HTTPS endpoint, request signature handling, and whether Meta can reach the callback URL from the public internet.',
          });
        }
      } catch (error) {
        metaWebhook.lookup_error = error.message;
        diagnostics.push({
          level: 'warning',
          title: 'Unable to read Meta webhook status live',
          message: `Local logs are available, but the live Meta subscription lookup failed: ${error.message}`,
        });
      }
    }

    if (pendingDeliveryUpdates > 0) {
      diagnostics.push({
        level: 'warning',
        title: 'Accepted but still waiting for delivery callbacks',
        message: `${pendingDeliveryUpdates} outbound message(s) are still only marked as sent/queued after 5 minutes. That usually means delivery is still pending or webhook status updates are not arriving.`,
      });
    }

    if (messageTotals.failed > 0) {
      diagnostics.push({
        level: 'error',
        title: 'Outbound failures detected',
        message: `${messageTotals.failed} outbound message(s) failed. Review the Meta error details in the message log below.`,
      });
    }

    if (messageTotals.delivered + messageTotals.read > 0) {
      diagnostics.push({
        level: 'success',
        title: 'Delivery callbacks are updating message state',
        message: `${messageTotals.delivered} delivered and ${messageTotals.read} read status update(s) were recorded in the selected time window.`,
      });
    }

    return apiResponse(res, {
      data: {
        summary: {
          window_hours: hours,
          webhook_events: totalWebhookEvents,
          processed_webhooks: webhookTotals.processed,
          failed_webhooks: webhookTotals.failed,
          skipped_webhooks: webhookTotals.skipped,
          outbound_sent: messageTotals.sent,
          outbound_delivered: messageTotals.delivered,
          outbound_read: messageTotals.read,
          outbound_failed: messageTotals.failed,
          pending_delivery_updates: pendingDeliveryUpdates,
          last_webhook_at: lastWebhook?.created_at || null,
          meta_app_subscription_active: metaWebhook.app_subscription?.active ?? null,
          meta_current_app_subscribed: metaWebhook.waba_subscription?.is_current_app_subscribed ?? null,
          meta_messages_field_subscribed: metaWebhook.app_subscription?.fields?.includes('messages') ?? null,
          meta_template_status_field_subscribed: metaWebhook.app_subscription?.fields?.includes('message_template_status_update') ?? null,
        },
        diagnostics,
        meta_webhook: metaWebhook,
        webhook_events: events.map(summarizeWebhookEvent),
        outbound_messages: outboundMessages,
        pagination: {
          webhook_events: {
            page: webhookPage,
            limit: limitEvents,
            total: totalWebhookEvents,
            pages: webhookPages,
          },
          outbound_messages: {
            page: outboundPage,
            limit: limitMessages,
            total: totalOutboundMessages,
            pages: outboundPages,
          },
        },
      },
    });
  } catch (error) {
    console.error('WhatsApp logs fetch error:', error);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to fetch WhatsApp logs' });
  }
});

module.exports = router;
