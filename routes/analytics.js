const express = require('express');
const config = require('../config');
const { authenticate, requireStatus } = require('../middleware/auth');
const Message = require('../models/Message');
const Contact = require('../models/Contact');
const Campaign = require('../models/Campaign');
const Notification = require('../models/Notification');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const { apiResponse } = require('../utils/helpers');
const { decrypt } = require('../services/encryptionService');
const metaService = require('../services/metaService');

const router = express.Router();

const startOfToday = () => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
};

const clamp = (value, min, max, fallback) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
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
      is_publicly_reachable: !(isLocalhost || isPrivateNetwork),
      invalid_url: false,
    };
  } catch (error) {
    return {
      callback_url: callbackUrl,
      host: null,
      is_publicly_reachable: null,
      invalid_url: true,
    };
  }
};

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

const extractAppId = (item) => item?.id || item?.app_id || item?.application?.id || item?.whatsapp_business_api_data?.id || null;

const normalizeQualityRating = (...values) => {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim().toLowerCase();
    if (['green', 'yellow', 'red', 'unknown'].includes(normalized)) return normalized;
  }
  return 'unknown';
};

const normalizeUpper = (value) => String(value || '').trim().toUpperCase();

const summarizeStatus = (checks = []) => {
  if (checks.some((check) => check?.status === 'error')) return 'error';
  if (checks.some((check) => check?.status === 'warning')) return 'warning';
  return 'success';
};

const buildOverviewMetrics = async (tenantId) => {
  const today = startOfToday();

  const [
    totalMessages,
    sentToday,
    deliveredToday,
    readToday,
    failedToday,
    totalContacts,
    activeCampaigns,
    waVerified,
    waNotAvailable,
    openConversations,
  ] = await Promise.all([
    Message.countDocuments({ tenant_id: tenantId }),
    Message.countDocuments({ tenant_id: tenantId, direction: 'outbound', timestamp: { $gte: today } }),
    Message.countDocuments({ tenant_id: tenantId, direction: 'outbound', status: 'delivered', timestamp: { $gte: today } }),
    Message.countDocuments({ tenant_id: tenantId, direction: 'outbound', status: 'read', timestamp: { $gte: today } }),
    Message.countDocuments({ tenant_id: tenantId, status: 'failed', timestamp: { $gte: today } }),
    Contact.countDocuments({ tenant_id: tenantId }),
    Campaign.countDocuments({ tenant_id: tenantId, status: { $in: ['running', 'scheduled'] } }),
    Contact.countDocuments({ tenant_id: tenantId, wa_exists: 'yes' }),
    Contact.countDocuments({ tenant_id: tenantId, wa_exists: 'no' }),
    Message.aggregate([
      {
        $match: {
          tenant_id: tenantId,
          direction: 'inbound',
          status: { $ne: 'read' },
        },
      },
      { $group: { _id: '$contact_phone' } },
      { $count: 'count' },
    ]),
  ]);

  return {
    total_messages: totalMessages,
    sent_today: sentToday,
    delivered_today: deliveredToday,
    read_today: readToday,
    failed_today: failedToday,
    delivery_rate: sentToday > 0 ? Math.round(((deliveredToday + readToday) / sentToday) * 100) : 0,
    read_rate: sentToday > 0 ? Math.round((readToday / sentToday) * 100) : 0,
    total_contacts: totalContacts,
    active_campaigns: activeCampaigns,
    open_conversations: openConversations[0]?.count || 0,
    wa_verified: waVerified,
    wa_not_available: waNotAvailable,
  };
};

const buildRecentNotifications = async (tenantId, limit = 5) => {
  const rawItems = await Notification.find({ tenant_id: tenantId })
    .sort({ created_at: -1 })
    .limit(Math.min(limit * 8, 80))
    .lean();

  return dedupeNotifications(rawItems).slice(0, limit);
};

const buildUnreadConversations = async (tenantId, limit = 5) => {
  const unreadRows = await Message.aggregate([
    {
      $match: {
        tenant_id: tenantId,
        direction: 'inbound',
        status: { $ne: 'read' },
      },
    },
    { $sort: { timestamp: -1 } },
    {
      $group: {
        _id: '$contact_phone',
        contact_phone: { $first: '$contact_phone' },
        contact_name: { $first: '$contact_name' },
        last_message: { $first: '$content' },
        last_message_type: { $first: '$message_type' },
        last_message_at: { $first: '$timestamp' },
        unread_count: { $sum: 1 },
      },
    },
    { $sort: { last_message_at: -1 } },
    { $limit: Math.max(1, Math.min(limit, 10)) },
  ]);

  return unreadRows;
};

const buildWabaReadiness = async (tenantId) => {
  const waAccount = await WhatsAppAccount.findOne({ tenant_id: tenantId }).lean();
  const checkedAt = new Date().toISOString();

  if (!waAccount) {
    return {
      overall_status: 'error',
      summary: 'No connected WhatsApp Business Account found.',
      data_source: 'meta',
      history_affects_blocking: false,
      send_status: 'error',
      send_ready: false,
      receive_status: 'error',
      receive_ready: false,
      sender_count: 0,
      approved_template_count: 0,
      active_phone: null,
      checks: [
        {
          id: 'connection',
          label: 'WhatsApp connection',
          status: 'error',
          detail: 'Complete Meta Embedded Signup and save the sender configuration first.',
        },
      ],
      recent_failures: [],
      checked_at: checkedAt,
    };
  }

  const accessToken = decrypt(waAccount.access_token_encrypted);
  const recentFailureNotificationsPromise = Notification.find({
    tenant_id: tenantId,
    type: { $in: ['message_failed', 'account_warning', 'meta_error'] },
  })
    .sort({ created_at: -1 })
    .limit(8)
    .lean();

  const [
    healthResult,
    billingInfo,
    phoneResult,
    appSubscriptionsResult,
    wabaSubscriptionsResult,
    templatesResult,
    recentFailureNotifications,
  ] = await Promise.all([
    metaService.getAccountHealth(waAccount.waba_id, waAccount.phone_number_id, accessToken).catch(() => null),
    metaService.fetchWABABillingInfo(waAccount.waba_id, accessToken).catch(() => null),
    metaService.fetchPhoneNumbers(waAccount.waba_id, accessToken).catch(() => []),
    metaService.getAppSubscriptions().catch(() => []),
    metaService.getWabaSubscribedApps(waAccount.waba_id, accessToken).catch(() => []),
    metaService.getTemplates(waAccount.waba_id, accessToken).catch(() => []),
    recentFailureNotificationsPromise,
  ]);

  const appSubscription = (appSubscriptionsResult || []).find((item) => item.object === 'whatsapp_business_account') || null;
  const appFields = normalizeSubscriptionFields(appSubscription?.fields);
  const callback = getCallbackDetails(appSubscription?.callback_url || null);
  const currentAppLinked = (wabaSubscriptionsResult || []).some(
    (item) => String(extractAppId(item) || '') === String(config.meta.appId || '')
  );
  const senderNumbers = Array.isArray(phoneResult) ? phoneResult : [];
  const activePhone =
    senderNumbers.find((item) => String(item.id) === String(waAccount.phone_number_id)) ||
    (healthResult?.phone
      ? {
          id: waAccount.phone_number_id,
          display_phone_number: waAccount.display_phone_number,
          verified_name: waAccount.display_name,
          quality_rating: healthResult.phone.quality_rating,
          messaging_limit_tier: healthResult.phone.messaging_limit_tier,
          code_verification_status: healthResult.phone.code_verification_status || null,
          status: healthResult.phone.status || null,
          name_status: healthResult.phone.name_status || null,
        }
      : null);

  const tokenExpiry = waAccount.token_expires_at ? new Date(waAccount.token_expires_at) : null;
  const expiresSoon = tokenExpiry ? tokenExpiry.getTime() - Date.now() < 3 * 24 * 60 * 60 * 1000 : false;
  const qualityRating = normalizeQualityRating(activePhone?.quality_rating, healthResult?.phone?.quality_rating, waAccount.quality_rating);
  const approvedTemplateCount = (templatesResult || []).filter((template) => String(template.status || '').toUpperCase() === 'APPROVED').length;
  const liveHealthAvailable = Boolean(healthResult?.waba || healthResult?.phone);
  const reviewStatus = normalizeUpper(healthResult?.waba?.account_review_status || billingInfo?.account_review_status);
  const senderVerificationStatus = normalizeUpper(activePhone?.code_verification_status);
  const senderOperationalStatus = normalizeUpper(activePhone?.status);
  const liveFundingId = billingInfo?.primary_funding_id || null;

  const checks = [
    {
      id: 'connection',
      label: 'Connected WABA',
      status: waAccount.account_status !== 'active' ? 'error' : liveHealthAvailable ? 'success' : 'warning',
      detail: waAccount.account_status !== 'active'
        ? `Current saved WABA status is ${waAccount.account_status || 'unknown'}.`
        : liveHealthAvailable
          ? `Meta live lookup succeeded for ${waAccount.display_phone_number || waAccount.phone_number_id}.`
          : 'Saved connection is active, but Meta did not return a live health snapshot just now.',
    },
    {
      id: 'waba_review',
      label: 'WABA review status',
      status: !reviewStatus ? 'warning' : reviewStatus === 'APPROVED' ? 'success' : reviewStatus === 'REJECTED' ? 'error' : 'warning',
      detail: !reviewStatus
        ? 'Meta did not return a live review status for this WABA.'
        : reviewStatus === 'APPROVED'
          ? 'Meta currently reports this WABA as approved.'
          : `Meta currently reports the WABA review status as ${reviewStatus}.`,
    },
    {
      id: 'sender_registration',
      label: 'Sender registration',
      status: !activePhone
        ? 'error'
        : senderVerificationStatus && senderVerificationStatus !== 'VERIFIED'
          ? 'warning'
          : senderOperationalStatus && !['CONNECTED', 'ACTIVE'].includes(senderOperationalStatus)
            ? 'warning'
            : 'success',
      detail: !activePhone
        ? 'Meta did not return the active sender in the live phone-number lookup.'
        : senderVerificationStatus && senderVerificationStatus !== 'VERIFIED'
          ? `Meta reports sender verification status ${senderVerificationStatus}.`
          : senderOperationalStatus && !['CONNECTED', 'ACTIVE'].includes(senderOperationalStatus)
            ? `Meta reports sender status ${senderOperationalStatus}.`
            : 'Meta returned the active sender in the live phone-number lookup.',
      action_link: '/portal/settings',
    },
    {
      id: 'billing',
      label: 'Billing eligibility',
      status: billingInfo ? (liveFundingId ? 'success' : 'warning') : 'warning',
      detail: !billingInfo
        ? 'Meta did not expose a live billing snapshot in this check, so payment readiness could not be fully confirmed.'
        : liveFundingId
          ? `Meta currently returns primary funding ID ${liveFundingId} for this WABA.`
          : 'Meta did not return a primary funding ID for this WABA in the live lookup.',
      action_link: '/portal/billing',
    },
    {
      id: 'webhook_messages',
      label: 'Messages webhook field',
      status: appSubscription ? (appFields.includes('messages') ? 'success' : 'error') : 'warning',
      detail: !appSubscription
        ? 'Could not read the Meta app webhook subscription live.'
        : appFields.includes('messages')
          ? 'Inbound messages and status updates are subscribed.'
          : 'The messages field is missing from the Meta app webhook subscription.',
      action_link: '/portal/logs',
    },
    {
      id: 'waba_app_link',
      label: 'WABA linked to app',
      status: currentAppLinked ? 'success' : 'error',
      detail: currentAppLinked
        ? 'Meta shows this WABA subscribed to the current app.'
        : 'Meta does not show this WABA subscribed to the current app.',
      action_link: '/portal/logs',
    },
    {
      id: 'callback_url',
      label: 'Webhook callback reachability',
      status: callback.invalid_url ? 'warning' : callback.is_publicly_reachable === false ? 'error' : 'success',
      detail: callback.invalid_url
        ? 'Meta returned an invalid callback URL.'
        : callback.callback_url
          ? `Meta callback URL: ${callback.callback_url}`
          : 'No callback URL returned from Meta subscription lookup.',
      action_link: '/portal/logs',
    },
    {
      id: 'quality',
      label: 'Phone quality rating',
      status: qualityRating === 'red' ? 'error' : qualityRating === 'yellow' ? 'warning' : 'success',
      detail: `Current quality rating is ${qualityRating}.`,
      action_link: '/portal/settings',
    },
    {
      id: 'token',
      label: 'Access token health',
      status: !tokenExpiry ? 'warning' : expiresSoon ? 'warning' : 'success',
      detail: !tokenExpiry
        ? 'Token expiry is not available in the saved account record.'
        : expiresSoon
          ? `Access token expires on ${tokenExpiry.toLocaleString()}.`
          : `Access token is valid until ${tokenExpiry.toLocaleString()}.`,
    },
  ];

  const checksById = Object.fromEntries(checks.map((check) => [check.id, check]));
  const overallStatus = summarizeStatus(checks);
  const sendStatus = summarizeStatus([
    checksById.connection,
    checksById.waba_review,
    checksById.sender_registration,
    checksById.billing,
    checksById.quality,
    checksById.token,
  ]);
  const receiveStatus = summarizeStatus([
    checksById.connection,
    checksById.webhook_messages,
    checksById.waba_app_link,
    checksById.callback_url,
    checksById.token,
  ]);
  const hasBlockingIssue = overallStatus === 'error';
  const hasWarnings = overallStatus === 'warning';

  return {
    overall_status: overallStatus,
    summary: hasBlockingIssue
      ? 'Live Meta checks found blocking issues. Fix the items below before sending live traffic.'
      : hasWarnings
        ? 'Live Meta snapshot did not show a hard block everywhere, but some checks are still unconfirmed or need attention.'
        : 'Live Meta checks look healthy for normal sending and webhook delivery.',
    data_source: 'meta',
    history_affects_blocking: false,
    send_status: sendStatus,
    send_ready: sendStatus === 'success',
    receive_status: receiveStatus,
    receive_ready: receiveStatus === 'success',
    sender_count: senderNumbers.length,
    approved_template_count: approvedTemplateCount,
    billing: {
      live_confirmed: Boolean(billingInfo),
      primary_funding_id: liveFundingId,
      currency: billingInfo?.currency || null,
      purchase_order_number: billingInfo?.purchase_order_number || null,
    },
    active_phone: activePhone
      ? {
          id: activePhone.id || waAccount.phone_number_id,
          display_phone_number: activePhone.display_phone_number || waAccount.display_phone_number,
          verified_name: activePhone.verified_name || waAccount.display_name,
          quality_rating: qualityRating,
          messaging_limit_tier: activePhone.messaging_limit_tier || healthResult?.phone?.messaging_limit_tier || waAccount.messaging_limit_tier,
          code_verification_status: activePhone.code_verification_status || null,
          status: activePhone.status || null,
        }
      : null,
    checks,
    history_note: 'Recent failures below are historical only. They do not change the live readiness badges by themselves.',
    recent_failures: recentFailureNotifications
      .slice(0, 3)
      .map((item) => ({
        _id: item._id,
        title: item.title,
        message: item.message,
        created_at: item.created_at,
        code: item.meta_data?.code || null,
        action_link: item.meta_data?.href || item.link || null,
      })),
    checked_at: checkedAt,
  };
};

router.get('/dashboard', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const tenantId = req.tenant._id;
    const [overview, readiness, notifications, unreadConversations] = await Promise.all([
      buildOverviewMetrics(tenantId),
      buildWabaReadiness(tenantId),
      buildRecentNotifications(tenantId, 5),
      buildUnreadConversations(tenantId, 6),
    ]);

    return apiResponse(res, {
      data: {
        overview,
        readiness,
        notifications,
        unread_conversations: unreadConversations,
      },
    });
  } catch (error) {
    return apiResponse(res, {
      status: 500,
      success: false,
      error: error.message || 'Failed to load dashboard snapshot',
    });
  }
});

router.get('/overview', authenticate, requireStatus('active'), async (req, res) => {
  try {
    return apiResponse(res, { data: await buildOverviewMetrics(req.tenant._id) });
  } catch (error) {
    return apiResponse(res, { status: 500, success: false, error: 'Failed' });
  }
});

router.get('/volume', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const days = clamp(req.query.days, 1, 90, 7);
    const start = new Date(Date.now() - days * 86400000);
    const volume = await Message.aggregate([
      { $match: { tenant_id: req.tenant._id, timestamp: { $gte: start } } },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
            direction: '$direction',
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.date': 1 } },
    ]);

    const map = {};
    for (let index = 0; index < days; index += 1) {
      const date = new Date(Date.now() - (days - 1 - index) * 86400000).toISOString().split('T')[0];
      map[date] = { date, inbound: 0, outbound: 0 };
    }

    volume.forEach((item) => {
      if (map[item._id.date]) {
        map[item._id.date][item._id.direction] = item.count;
      }
    });

    return apiResponse(res, { data: { volume: Object.values(map) } });
  } catch (error) {
    return apiResponse(res, { status: 500, success: false, error: 'Failed' });
  }
});

router.get('/message-types', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const breakdown = await Message.aggregate([
      { $match: { tenant_id: req.tenant._id } },
      { $group: { _id: '$message_type', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);
    return apiResponse(res, { data: { breakdown } });
  } catch (error) {
    return apiResponse(res, { status: 500, success: false, error: 'Failed' });
  }
});

router.get('/campaigns', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const campaigns = await Campaign.find({ tenant_id: req.tenant._id })
      .sort({ created_at: -1 })
      .limit(20)
      .lean();
    return apiResponse(res, { data: { campaigns } });
  } catch (error) {
    return apiResponse(res, { status: 500, success: false, error: 'Failed' });
  }
});

module.exports = router;
