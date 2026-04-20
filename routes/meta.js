const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const { authenticate, requireStatus } = require('../middleware/auth');
const metaService = require('../services/metaService');
const { encrypt, decrypt } = require('../services/encryptionService');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const Contact = require('../models/Contact');
const Message = require('../models/Message');
const User = require('../models/User');
const Notification = require('../models/Notification');
const Conversation = require('../models/Conversation');
const Campaign = require('../models/Campaign');
const MediaAsset = require('../models/MediaAsset');
const WebhookEvent = require('../models/WebhookEvent');
const AuditLog = require('../models/AuditLog');
const AutoResponseRule = require('../models/AutoResponseRule');
const AutoResponseLog = require('../models/AutoResponseLog');
const { apiResponse } = require('../utils/helpers');
const router = express.Router();
const STORAGE_ROOT = path.join(__dirname, '..', 'storage');

const pendingTokens = new Map();
const verboseLogs =
  process.env.NODE_ENV !== 'production' ||
  ['true', '1', 'yes', 'y', 'on'].includes(String(process.env.ENABLE_VERBOSE_LOGS || '').trim().toLowerCase());
const calcExpiry = (s) => { const p=Number(s); if(!Number.isFinite(p)||p<=0) return null; const d=new Date(Date.now()+p*1000); return Number.isNaN(d.getTime())?null:d; };
const normalizeQualityRating = (...values) => {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim().toLowerCase();
    if (['green', 'yellow', 'red', 'unknown'].includes(normalized)) return normalized;
  }
  return 'unknown';
};

const getWA = async (tenantId, accountId) => {
  let wa;
  if (accountId) {
    wa = await WhatsAppAccount.findOne({ _id: accountId, tenant_id: tenantId });
  } else {
    // Prefer the default account; fall back to any account for backward compat
    wa = await WhatsAppAccount.findOne({ tenant_id: tenantId, is_default: true })
      || await WhatsAppAccount.findOne({ tenant_id: tenantId });
  }
  if (!wa) throw { status:404, message:'No WhatsApp account connected. Complete setup first.', source:'platform' };
  return { wa, token: decrypt(wa.access_token_encrypted) };
};

const ensureContact = async (tenantId, phone, waExists = 'unknown') => {
  const setFields = {
    phone,
    whatsapp_id: phone,
    last_message_at: new Date(),
  };
  if (waExists === 'yes') setFields.wa_exists = 'yes';

  const contact = await Contact.findOneAndUpdate(
    {
      tenant_id: tenantId,
      phone,
    },
    {
      $set: setFields,
      $setOnInsert: { tenant_id: tenantId, name: '' },
    },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: false }
  );
  return contact;
};

const storeOutboundMessage = async ({ tenantId, userId, phone, messageType, content, waMessageId, templateName = null, templateParams = null, mediaUrl = null, mediaFilename = null }) => {
  const contact = await ensureContact(tenantId, phone, waMessageId ? 'yes' : 'unknown');
  return Message.create({
    tenant_id: tenantId,
    contact_phone: phone,
    contact_name: contact.name || contact.wa_name || '',
    direction: 'outbound',
    message_type: messageType,
    content,
    template_name: templateName,
    template_params: templateParams,
    media_url: mediaUrl,
    media_filename: mediaFilename,
    wa_message_id: waMessageId,
    status: 'sent',
    sent_by: userId,
    timestamp: new Date(),
  });
};

// Wrap Meta errors with clear source
const handleError = (res, error, fallback) => {
  if (error.source === 'meta') {
    const detail =
      error.metaError?.error_data?.details ||
      error.metaError?.error_user_msg ||
      '';
    const renderedMessage = detail ? `${error.message} | ${detail}` : error.message;
    console.error('[Meta Route][Meta Error]', {
      fallback,
      message: error.message,
      detail: detail || null,
      code: error.metaError?.code || null,
      subcode: error.metaError?.error_subcode || null,
      type: error.metaError?.type || null,
    });
    return apiResponse(res, { status: error.statusCode||500, success:false, error: `[Meta API Error] ${renderedMessage}`, error_source:'meta', meta_error: error.metaError });
  }
  console.error('[Meta Route][Platform Error]', {
    fallback,
    message: error.message,
    status: error.status || 500,
  });
  if (error.status) return apiResponse(res, { status:error.status, success:false, error: `[Platform] ${error.message}`, error_source:'platform' });
  return apiResponse(res, { status:500, success:false, error: `[Platform] ${fallback}: ${error.message}`, error_source:'platform' });
};

const reconcileTemplateNotifications = async (tenantId, templates = []) => {
  const actionableTemplates = templates.filter((template) =>
    ['APPROVED', 'REJECTED', 'PAUSED'].includes(String(template.status || '').toUpperCase())
  );

  for (const template of actionableTemplates) {
    const normalizedStatus = String(template.status || '').toUpperCase();
    const existing = await Notification.findOne({
      tenant_id: tenantId,
      type:
        normalizedStatus === 'APPROVED'
          ? 'template_approved'
          : normalizedStatus === 'REJECTED'
            ? 'template_rejected'
            : 'template_paused',
      'meta_data.template_id': template.id || null,
      'meta_data.template_status': normalizedStatus,
    }).lean();

    if (existing) continue;

    await Notification.create({
      tenant_id: tenantId,
      type:
        normalizedStatus === 'APPROVED'
          ? 'template_approved'
          : normalizedStatus === 'REJECTED'
            ? 'template_rejected'
            : 'template_paused',
      title: `Template ${normalizedStatus.toLowerCase()}: ${template.name || 'Unknown template'}`,
      message:
        normalizedStatus === 'APPROVED'
          ? `[Meta] Template "${template.name}" is now approved and ready to send.`
          : normalizedStatus === 'REJECTED'
            ? `[Meta] Template "${template.name}" was rejected.${template.rejected_reason ? ` Reason: ${template.rejected_reason}` : ''}`
            : `[Meta] Template "${template.name}" is now paused on Meta.`,
      source: 'meta',
      severity:
        normalizedStatus === 'APPROVED'
          ? 'success'
          : normalizedStatus === 'REJECTED'
            ? 'error'
            : 'warning',
      link: '/portal/templates',
      meta_data: {
        template_id: template.id || null,
        template_name: template.name || null,
        template_status: normalizedStatus,
      },
    });

    if (verboseLogs) {
      console.info('[Meta Route][Template Notification Reconciled]', {
        tenant_id: String(tenantId),
        template_id: template.id || null,
        template_name: template.name || null,
        template_status: normalizedStatus,
      });
    }
  }
};

const notifyMetaSendFailure = async (tenantId, title, error, context = {}) => {
  if (error?.source !== 'meta') return;

  await Notification.create({
    tenant_id: tenantId,
    type: 'message_failed',
    title,
    message: `[Meta] ${error.message}${error.metaError?.code ? ` (Code: ${error.metaError.code})` : ''}`,
    source: 'meta',
    severity: 'error',
    meta_data: {
      ...context,
      code: error.metaError?.code || null,
      subcode: error.metaError?.error_subcode || null,
      type: error.metaError?.type || null,
    },
  }).catch(() => null);
};

// ─── EXCHANGE TOKEN ─────────────────
router.post('/exchange-token', authenticate, requireStatus('pending_setup','active'), async (req, res) => {
  try {
    const { code, waba_id, phone_number_id, business_id } = req.body;
    if (!code) return apiResponse(res, { status:400, success:false, error:'[Platform] Facebook auth code is required', error_source:'platform' });
    const { accessToken, expiresIn } = await metaService.exchangeCodeForToken(code);
    let wabasWithPhones = [];
    if (waba_id) {
      const wabaDetail = await metaService.fetchWABADetail(waba_id, accessToken).catch(()=>null);
      let phones = [];
      if (phone_number_id) { const pd = await metaService.fetchPhoneDetail(phone_number_id, accessToken); phones = [{ id:phone_number_id, display_phone_number:pd.display_phone_number, verified_name:pd.verified_name, quality_rating:pd.quality_rating, status:pd.status }]; }
      else { phones = await metaService.fetchPhoneNumbers(waba_id, accessToken); }
      wabasWithPhones = [{ id:waba_id, name:wabaDetail?.name||'WhatsApp Business Account', currency:wabaDetail?.currency, account_review_status:wabaDetail?.account_review_status||'unknown', business_id:business_id||null, phone_numbers:phones }];
    } else {
      const wabas = await metaService.fetchWABAs(accessToken);
      wabasWithPhones = await Promise.all(wabas.map(async w => ({ ...w, phone_numbers: await metaService.fetchPhoneNumbers(w.id, accessToken) })));
    }
    pendingTokens.set(req.user._id.toString(), { token:encrypt(accessToken), expiresIn, tokenExpiresAt:calcExpiry(expiresIn), storedAt:Date.now() });
    setTimeout(() => pendingTokens.delete(req.user._id.toString()), 10*60*1000);
    return apiResponse(res, { data: { waba_accounts: wabasWithPhones } });
  } catch(e) { return handleError(res, e, 'Token exchange failed'); }
});

// ─── SAVE CONFIG ─────────────────
router.post('/save-config', authenticate, requireStatus('pending_setup','active'), async (req, res) => {
  try {
    const { waba_id, phone_number_id } = req.body;
    if (!waba_id || !phone_number_id) return apiResponse(res, { status:400, success:false, error:'[Platform] WABA ID and Phone Number ID required', error_source:'platform' });
    const pending = pendingTokens.get(req.user._id.toString());
    if (!pending) return apiResponse(res, { status:400, success:false, error:'[Platform] Session expired. Please reconnect.', error_source:'platform' });
    const accessToken = decrypt(pending.token);
    const phoneDetail = await metaService.fetchPhoneDetail(phone_number_id, accessToken);
    const existingCount = await WhatsAppAccount.countDocuments({ tenant_id: req.tenant._id });
    const isFirstAccount = existingCount === 0;
    await WhatsAppAccount.findOneAndUpdate(
      { tenant_id: req.tenant._id, phone_number_id },
      {
        tenant_id: req.tenant._id,
        waba_id,
        phone_number_id,
        display_phone_number: phoneDetail.display_phone_number,
        display_name: phoneDetail.verified_name,
        access_token_encrypted: encrypt(accessToken),
        token_expires_at: pending.tokenExpiresAt,
        account_status: 'active',
        quality_rating: normalizeQualityRating(phoneDetail.quality_rating),
        webhook_verified: true,
        ...(isFirstAccount ? { is_default: true } : {}),
      },
      { upsert: true, new: true }
    );
    try { await metaService.subscribeWebhook(waba_id, accessToken); } catch(e) { console.error('Webhook sub error:', e.message); }
    // Mark user as active (for first-time onboarding)
    if (req.user.status === 'pending_setup') {
      await User.findByIdAndUpdate(req.user._id, { status: 'active' });
    }
    // Update tenant name from Meta verified business name (replaces placeholder)
    const tenantUpdate = { setup_status: 'active' };
    if (phoneDetail.verified_name) {
      tenantUpdate.name = phoneDetail.verified_name;
    }
    await Tenant.findByIdAndUpdate(req.tenant._id, tenantUpdate);
    pendingTokens.delete(req.user._id.toString());
    return apiResponse(res, { data: { message:'Connected successfully', redirect_to:'/portal/dashboard' } });
  } catch(e) { return handleError(res, e, 'Save config failed'); }
});

// ─── ACCOUNT HEALTH ─────────────────
router.get('/account-health', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { wa, token } = await getWA(req.tenant._id, req.query.account_id);
    const health = await metaService.getAccountHealth(wa.waba_id, wa.phone_number_id, token);
    const qualityRating = normalizeQualityRating(health.phone?.quality_rating, wa.quality_rating);
    const nextMessagingTier = Number(health.phone?.messaging_limit_tier);
    const hasFreshMessagingTier = Number.isFinite(nextMessagingTier);

    if (qualityRating !== wa.quality_rating || (hasFreshMessagingTier && nextMessagingTier !== wa.messaging_limit_tier)) {
      wa.quality_rating = qualityRating;
      if (hasFreshMessagingTier) wa.messaging_limit_tier = nextMessagingTier;
      await wa.save();
    }

    return apiResponse(res, { data: { waba_id:wa.waba_id, display_name:wa.display_name, display_phone_number:wa.display_phone_number, account_status:wa.account_status, quality_rating:qualityRating, messaging_limit_tier:hasFreshMessagingTier ? nextMessagingTier : wa.messaging_limit_tier, business_verification_status:health.waba?.account_review_status||'unknown', webhook_verified:wa.webhook_verified, token_expires_at:wa.token_expires_at } });
  } catch(e) { return handleError(res, e, 'Health check failed'); }
});

// ─── BUSINESS PROFILE ─────────────────
router.get('/business-profile', authenticate, requireStatus('active'), async (req, res) => {
  try { const { wa, token } = await getWA(req.tenant._id, req.query.account_id); const p = await metaService.getBusinessProfile(wa.phone_number_id, token); return apiResponse(res, { data: p }); }
  catch(e) { return handleError(res, e, 'Profile fetch failed'); }
});
router.put('/business-profile', authenticate, requireStatus('active'), async (req, res) => {
  try { const { wa, token } = await getWA(req.tenant._id, req.query.account_id); const r = await metaService.updateBusinessProfile(wa.phone_number_id, token, req.body); return apiResponse(res, { data: r }); }
  catch(e) { return handleError(res, e, 'Profile update failed'); }
});

// ─── RECONNECT ─────────────────
router.post('/reconnect', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const wa = req.body.account_id
      ? await WhatsAppAccount.findOne({ _id: req.body.account_id, tenant_id: req.tenant._id })
      : (await WhatsAppAccount.findOne({ tenant_id: req.tenant._id, is_default: true })
        || await WhatsAppAccount.findOne({ tenant_id: req.tenant._id }));
    if (wa) { wa.account_status='disconnected'; await wa.save(); }
    const remaining = await WhatsAppAccount.countDocuments({ tenant_id: req.tenant._id, account_status: 'active' });
    if (remaining === 0) {
      await Tenant.findByIdAndUpdate(req.tenant._id, { setup_status: 'pending_setup' });
      // Only change user status if this is their only/active tenant
      if (req.user.status === 'active') {
        await User.findByIdAndUpdate(req.user._id, { status: 'pending_setup' });
      }
    }
    return apiResponse(res, { data: { message:'Disconnected. Reconnect now.', redirect_to:'/portal/setup' } });
  } catch(e) { return handleError(res, e, 'Reconnect failed'); }
});

router.post('/maintenance/clear-tenant-data', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const confirmText = String(req.body?.confirm_text || '').trim().toUpperCase();
    if (confirmText !== 'CLEAR') {
      return apiResponse(res, { status: 400, success: false, error: '[Platform] confirm_text must be CLEAR', error_source: 'platform' });
    }
    const tenantId = req.tenant._id;
    const mediaAssets = await MediaAsset.find({ tenant_id: tenantId }).select('relative_path').lean();
    for (const asset of mediaAssets) {
      const relativePath = String(asset.relative_path || '').trim();
      if (!relativePath) continue;
      await fs.unlink(path.join(STORAGE_ROOT, relativePath)).catch(() => null);
    }
    await fs.rm(path.join(STORAGE_ROOT, 'media', String(tenantId)), { recursive: true, force: true }).catch(() => null);

    const [contacts, conversations, messages, campaigns, notifications, webhookEvents, auditLogs, autoResponseRules, autoResponseLogs, media] = await Promise.all([
      Contact.deleteMany({ tenant_id: tenantId }),
      Conversation.deleteMany({ tenant_id: tenantId }),
      Message.deleteMany({ tenant_id: tenantId }),
      Campaign.deleteMany({ tenant_id: tenantId }),
      Notification.deleteMany({ tenant_id: tenantId }),
      WebhookEvent.deleteMany({ tenant_id: tenantId }),
      AuditLog.deleteMany({ tenant_id: tenantId }),
      AutoResponseRule.deleteMany({ tenant_id: tenantId }),
      AutoResponseLog.deleteMany({ tenant_id: tenantId }),
      MediaAsset.deleteMany({ tenant_id: tenantId }),
    ]);

    return apiResponse(res, {
      data: {
        contacts: contacts.deletedCount || 0,
        conversations: conversations.deletedCount || 0,
        messages: messages.deletedCount || 0,
        campaigns: campaigns.deletedCount || 0,
        notifications: notifications.deletedCount || 0,
        webhook_events: webhookEvents.deletedCount || 0,
        audit_logs: auditLogs.deletedCount || 0,
        auto_response_rules: autoResponseRules.deletedCount || 0,
        auto_response_logs: autoResponseLogs.deletedCount || 0,
        media_assets: media.deletedCount || 0,
        note: 'WhatsApp account connection and users are preserved.',
      },
    });
  } catch (e) {
    return handleError(res, e, 'Tenant data cleanup failed');
  }
});

// ═══════════════════════════════════════
// ACCOUNTS (Multi-phone management)
// ═══════════════════════════════════════
router.get('/accounts', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const accounts = await WhatsAppAccount.find({ tenant_id: req.tenant._id })
      .select('-access_token_encrypted')
      .sort({ is_default: -1, created_at: 1 })
      .lean();
    return apiResponse(res, { data: { accounts } });
  } catch (e) { return handleError(res, e, 'Fetch accounts failed'); }
});

router.post('/accounts/:id/set-default', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const account = await WhatsAppAccount.findOne({ _id: req.params.id, tenant_id: req.tenant._id });
    if (!account) return apiResponse(res, { status: 404, success: false, error: '[Platform] Account not found', error_source: 'platform' });
    // Unset all defaults for this tenant
    await WhatsAppAccount.updateMany({ tenant_id: req.tenant._id }, { $set: { is_default: false } });
    // Set the chosen one as default
    account.is_default = true;
    await account.save();
    return apiResponse(res, { data: { message: 'Default account updated', account_id: account._id } });
  } catch (e) { return handleError(res, e, 'Set default failed'); }
});

router.patch('/accounts/:id', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { label } = req.body;
    const account = await WhatsAppAccount.findOne({ _id: req.params.id, tenant_id: req.tenant._id });
    if (!account) return apiResponse(res, { status: 404, success: false, error: '[Platform] Account not found', error_source: 'platform' });
    if (typeof label === 'string') account.label = label.trim();
    await account.save();
    return apiResponse(res, { data: { message: 'Account updated', account_id: account._id, label: account.label } });
  } catch (e) { return handleError(res, e, 'Update account failed'); }
});

// ═══════════════════════════════════════
// PHONE NUMBERS (Meta-direct)
// ═══════════════════════════════════════
router.get('/phone-numbers', authenticate, requireStatus('active'), async (req, res) => {
  try { const { wa, token } = await getWA(req.tenant._id, req.query.account_id); const phones = await metaService.fetchPhoneNumbers(wa.waba_id, token); return apiResponse(res, { data: { phone_numbers:phones, active_phone_id:wa.phone_number_id } }); }
  catch(e) { return handleError(res, e, 'Phone fetch failed'); }
});

router.post('/phone-numbers/register', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { country_code, phone_number, verified_name } = req.body;
    if (!country_code || !phone_number || !verified_name?.trim()) return apiResponse(res, { status:400, success:false, error:'[Platform] country_code, phone_number, and verified_name required', error_source:'platform' });
    const { wa, token } = await getWA(req.tenant._id, req.query.account_id || req.body?.account_id);
    const name = verified_name.trim();
    const result = await metaService.registerPhoneNumber(wa.waba_id, token, { country_code, phone_number, verified_name: name });
    await Notification.create({ tenant_id:req.tenant._id, type:'system', title:'Phone Number Added', message:`New number +${country_code}${phone_number} (${name}) added on Meta. Request a verification code to finish setup.`, source:'meta', severity:'info' });
    return apiResponse(res, { data: result });
  } catch(e) { return handleError(res, e, 'Registration failed'); }
});

router.post('/phone-numbers/request-code', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { phone_number_id, code_method, locale, language } = req.body;
    if (!phone_number_id) return apiResponse(res, { status:400, success:false, error:'[Platform] phone_number_id required', error_source:'platform' });
    const method = String(code_method || 'SMS').trim().toUpperCase();
    if (!['SMS', 'VOICE'].includes(method)) return apiResponse(res, { status:400, success:false, error:'[Platform] code_method must be SMS or VOICE', error_source:'platform' });
    const requestedLocale = typeof locale === 'string' && locale.trim()
      ? locale.trim()
      : (typeof language === 'string' && language.trim() ? language.trim() : 'en_US');
    const { wa, token } = await getWA(req.tenant._id, req.query.account_id || req.body?.account_id);
    const result = await metaService.requestVerificationCode(phone_number_id, token, method, requestedLocale);
    return apiResponse(res, { data: { ...result, requested:true, code_method:method, locale:requestedLocale } });
  }
  catch(e) { return handleError(res, e, 'Code request failed'); }
});

router.post('/phone-numbers/verify', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { phone_number_id, code, pin, data_localization_region } = req.body;
    if (!phone_number_id || !code) return apiResponse(res, { status:400, success:false, error:'[Platform] phone_number_id and code required', error_source:'platform' });
    if (!pin || !/^\d{6}$/.test(String(pin).replace(/\D/g,''))) return apiResponse(res, { status:400, success:false, error:'[Platform] pin must be a 6-digit number', error_source:'platform' });
    const { wa, token } = await getWA(req.tenant._id, req.query.account_id || req.body?.account_id);
    const verifyResult = await metaService.verifyPhoneCode(phone_number_id, token, code);
    const registerResult = pin ? await metaService.registerVerifiedPhone(phone_number_id, token, pin, data_localization_region) : null;
    const phone = await metaService.fetchPhoneDetail(phone_number_id, token).catch(() => null);
    await Notification.create({
      tenant_id:req.tenant._id,
      type:'phone_verified',
      title: registerResult ? 'Phone Verified & Registered' : 'Phone Verified',
      message: registerResult
        ? `Phone number ${phone?.display_phone_number || ''} verified and registered on Meta successfully.`
        : 'Phone number verified on Meta successfully.',
      source:'meta',
      severity:'success',
    });
    return apiResponse(res, { data: { verify_result: verifyResult, register_result: registerResult, phone } });
  } catch(e) { return handleError(res, e, 'Verification failed'); }
});

router.post('/phone-numbers/switch', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { phone_number_id } = req.body;
    const { wa, token } = await getWA(req.tenant._id, req.query.account_id || req.body?.account_id);
    const pd = await metaService.fetchPhoneDetail(phone_number_id, token);
    wa.phone_number_id=phone_number_id; wa.display_phone_number=pd.display_phone_number; wa.display_name=pd.verified_name; wa.quality_rating=normalizeQualityRating(pd.quality_rating); wa.messaging_limit_tier=pd.messaging_limit_tier||1; await wa.save();
    return apiResponse(res, { data: { message:'Switched', phone:pd } });
  } catch(e) { return handleError(res, e, 'Switch failed'); }
});

router.post('/phone-numbers/deregister', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { phone_number_id, next_phone_number_id } = req.body;
    if (!phone_number_id) {
      return apiResponse(res, {
        status:400,
        success:false,
        error:'[Platform] phone_number_id required',
        error_source:'platform',
      });
    }

    const { wa, token } = await getWA(req.tenant._id, req.query.account_id || req.body?.account_id);
    const currentPhones = await metaService.fetchPhoneNumbers(wa.waba_id, token);
    const currentPhone = currentPhones.find((phone) => phone.id === phone_number_id) || null;
    const remainingPhones = currentPhones.filter((phone) => phone.id !== phone_number_id);
    const isActivePhone = String(wa.phone_number_id) === String(phone_number_id);

    if (isActivePhone && !remainingPhones.length) {
      return apiResponse(res, {
        status:400,
        success:false,
        error:'[Platform] This is the only active sender number. Add another sender first or reconnect the whole WhatsApp account before removing it.',
        error_source:'platform',
      });
    }

    if (next_phone_number_id && !remainingPhones.some((phone) => phone.id === next_phone_number_id)) {
      return apiResponse(res, {
        status:400,
        success:false,
        error:'[Platform] next_phone_number_id must belong to another existing sender on this WABA',
        error_source:'platform',
      });
    }

    if (verboseLogs) {
      console.info('[Meta Route][Phone Deregister Requested]', {
        tenant_id: String(req.tenant._id),
        phone_number_id,
        is_active_phone: isActivePhone,
        next_phone_number_id: next_phone_number_id || null,
      });
    }

    const deregisterResult = await metaService.deregisterPhone(phone_number_id, token);

    let nextActivePhoneId = wa.phone_number_id;
    let nextActivePhone = null;

    if (isActivePhone) {
      nextActivePhone =
        remainingPhones.find((phone) => phone.id === next_phone_number_id) ||
        remainingPhones[0] ||
        null;

      if (nextActivePhone) {
        const nextPhoneDetail = await metaService.fetchPhoneDetail(nextActivePhone.id, token).catch(() => nextActivePhone);
        wa.phone_number_id = nextActivePhone.id;
        wa.display_phone_number = nextPhoneDetail.display_phone_number || nextActivePhone.display_phone_number || '';
        wa.display_name = nextPhoneDetail.verified_name || nextActivePhone.verified_name || '';
        wa.quality_rating = normalizeQualityRating(nextPhoneDetail.quality_rating, nextActivePhone.quality_rating);
        wa.messaging_limit_tier = nextPhoneDetail.messaging_limit_tier || nextActivePhone.messaging_limit_tier || wa.messaging_limit_tier;
        wa.account_status = 'active';
        nextActivePhoneId = nextActivePhone.id;
      }
    }

    await wa.save();

    await Notification.create({
      tenant_id:req.tenant._id,
      type:'system',
      title:'Sender number deregistered',
      message:isActivePhone
        ? `Meta removed sender ${currentPhone?.display_phone_number || phone_number_id}. Portal switched the active sender to ${wa.display_phone_number || nextActivePhoneId}.`
        : `Meta removed sender ${currentPhone?.display_phone_number || phone_number_id} from this WhatsApp account.`,
      source:'meta',
      severity:isActivePhone ? 'warning' : 'info',
      meta_data:{
        removed_phone_number_id: phone_number_id,
        replacement_phone_number_id: isActivePhone ? nextActivePhoneId : null,
      },
      link:'/portal/settings',
    }).catch(() => null);

    if (verboseLogs) {
      console.info('[Meta Route][Phone Deregistered]', {
        tenant_id: String(req.tenant._id),
        removed_phone_number_id: phone_number_id,
        next_active_phone_number_id: isActivePhone ? nextActivePhoneId : wa.phone_number_id,
      });
    }

    const refreshedPhones = await metaService.fetchPhoneNumbers(wa.waba_id, token).catch(() => remainingPhones);

    return apiResponse(res, {
      data: {
        message:isActivePhone ? 'Sender removed and active sender switched' : 'Sender removed from Meta',
        result:deregisterResult,
        removed_phone_number_id: phone_number_id,
        active_phone_id: nextActivePhoneId,
        phone_numbers: refreshedPhones,
      },
    });
  } catch(e) { return handleError(res, e, 'Phone deregister failed'); }
});

// ═══════════════════════════════════════
// TEMPLATES (Meta = source of truth)
// ═══════════════════════════════════════
const parseTemplatePlaceholders = (value = '') => {
  const found = [];
  const re = /\{\{(\d+)\}\}/g;
  let match;
  while ((match = re.exec(String(value || '')))) {
    found.push(Number(match[1]));
  }
  return Array.from(new Set(found)).sort((a, b) => a - b);
};

const ensureTemplateVariables = (text = '', label = 'BODY') => {
  const invalidTokens = String(text || '').match(/\{\{[^}]+\}\}/g) || [];
  invalidTokens.forEach((token) => {
    if (!/^\{\{\d+\}\}$/.test(token)) {
      throw new Error(`${label} supports only numeric placeholders like {{1}}, {{2}}`);
    }
  });
  const indexes = parseTemplatePlaceholders(text);
  indexes.forEach((value, index) => {
    if (value !== index + 1) {
      throw new Error(`${label} placeholders must be sequential: {{1}}, {{2}}, ...`);
    }
  });
};

const normalizeMetaUrl = (value = '') => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const placeholderTokens = withProtocol.match(/\{\{\d+\}\}/g) || [];
  const hasPlaceholder = placeholderTokens.length > 0;
  if (hasPlaceholder) {
    if (placeholderTokens.length > 1 || placeholderTokens[0] !== '{{1}}' || !withProtocol.endsWith('{{1}}')) {
      throw new Error('URL button supports only one dynamic placeholder {{1}} at the end');
    }
  }
  const candidate = hasPlaceholder ? withProtocol.replace('{{1}}', 'sample') : withProtocol;
  const parsed = new URL(candidate);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('URL button requires http/https URL');
  if (!parsed.hostname) throw new Error('URL button requires host');
  const hostname = String(parsed.hostname || '').toLowerCase();
  if (hostname === 'localhost' || /^[\d.]+$/.test(hostname)) throw new Error('URL button requires public domain URL');
  const encodedPath = parsed.pathname ? encodeURI(parsed.pathname) : '';
  const encodedSearch = parsed.search ? encodeURI(parsed.search) : '';
  const suffix = hasPlaceholder ? '{{1}}' : '';
  return `${parsed.protocol}//${parsed.host}${encodedPath}${encodedSearch}${suffix}`;
};

const ensureTemplateComponents = (components) => {
  if (!Array.isArray(components) || components.length === 0) {
    throw new Error('components must be a non-empty array');
  }
  const body = components.find((item) => String(item?.type || '').toUpperCase() === 'BODY');
  if (!body || !String(body.text || '').trim()) throw new Error('BODY component is required');
  ensureTemplateVariables(body.text, 'BODY');

  const header = components.find((item) => String(item?.type || '').toUpperCase() === 'HEADER');
  if (header) {
    const format = String(header.format || 'TEXT').toUpperCase();
    if (!['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT'].includes(format)) {
      throw new Error('HEADER format must be TEXT, IMAGE, VIDEO, or DOCUMENT');
    }
    if (format === 'TEXT') {
      if (!String(header.text || '').trim()) throw new Error('TEXT header requires text');
      ensureTemplateVariables(header.text, 'HEADER');
    } else if (!Array.isArray(header.example?.header_handle) || !header.example.header_handle.length) {
      throw new Error(`${format} header requires example.header_handle`);
    } else {
      const firstHandle = String(header.example.header_handle[0] || '').trim();
      if (/^https?:\/\//i.test(firstHandle)) {
        throw new Error(`${format} header expects Meta media handle, not public URL`);
      }
    }
  }

  const buttonsComp = components.find((item) => String(item?.type || '').toUpperCase() === 'BUTTONS');
  if (buttonsComp) {
    const buttons = Array.isArray(buttonsComp.buttons) ? buttonsComp.buttons : [];
    if (!buttons.length || buttons.length > 3) throw new Error('BUTTONS supports 1 to 3 buttons');
    buttons.forEach((button) => {
      const type = String(button?.type || '').toUpperCase();
      const text = String(button?.text || '').trim();
      if (!text) throw new Error('Button text is required');
      if (!['QUICK_REPLY', 'URL', 'PHONE_NUMBER'].includes(type)) throw new Error(`Unsupported button type: ${type}`);
      if (type === 'URL') {
        if (!String(button?.url || '').trim()) throw new Error('URL button requires url');
        try {
          button.url = normalizeMetaUrl(button.url);
        } catch {
          throw new Error(`Button "${text}" requires a valid URL`);
        }
      }
      if (type === 'PHONE_NUMBER' && !String(button?.phone_number || '').trim()) throw new Error('PHONE button requires phone_number');
    });
  }
};

const inferMimeFromFormat = (format = '') => {
  const normalized = String(format || '').toUpperCase();
  if (normalized === 'IMAGE') return 'image/jpeg';
  if (normalized === 'VIDEO') return 'video/mp4';
  if (normalized === 'DOCUMENT') return 'application/pdf';
  return 'application/octet-stream';
};

const normalizeTemplateSampleMimeType = (format = '', upstreamMimeType = '') => {
  const normalizedFormat = String(format || '').toUpperCase();
  const mime = String(upstreamMimeType || '').toLowerCase();
  if (normalizedFormat === 'DOCUMENT') {
    if (mime.includes('pdf')) return 'application/pdf';
    return 'application/pdf';
  }
  if (normalizedFormat === 'IMAGE') {
    if (mime.startsWith('image/')) return mime;
    return 'image/jpeg';
  }
  if (normalizedFormat === 'VIDEO') {
    if (mime.startsWith('video/')) return mime;
    return 'video/mp4';
  }
  return inferMimeFromFormat(normalizedFormat);
};

// ─── CAROUSEL VALIDATION ──────────────────────────────────
const validateCarouselCards = (cards) => {
  if (!Array.isArray(cards) || cards.length < 2) {
    throw new Error('Carousel requires at least 2 cards');
  }
  if (cards.length > 10) {
    throw new Error('Carousel supports a maximum of 10 cards');
  }

  cards.forEach((card, index) => {
    const label = `Card ${index + 1}`;

    // Header is required for carousel cards (IMAGE type)
    if (!card.header_media_handle) {
      throw new Error(`${label}: header_media_handle is required (IMAGE header)`);
    }
    const handle = String(card.header_media_handle).trim();
    if (/^https?:\/\//i.test(handle)) {
      throw new Error(`${label}: header_media_handle expects a Meta media handle, not a URL`);
    }

    // Body text is required
    if (!card.body_text || !String(card.body_text).trim()) {
      throw new Error(`${label}: body_text is required`);
    }
    ensureTemplateVariables(card.body_text, `${label} BODY`);

    // Buttons validation (optional, max 2 per card)
    if (card.buttons) {
      if (!Array.isArray(card.buttons)) {
        throw new Error(`${label}: buttons must be an array`);
      }
      if (card.buttons.length > 2) {
        throw new Error(`${label}: carousel cards support a maximum of 2 buttons`);
      }
      card.buttons.forEach((button, btnIndex) => {
        const btnLabel = `${label} Button ${btnIndex + 1}`;
        const type = String(button?.type || '').toUpperCase();
        if (!['URL', 'QUICK_REPLY'].includes(type)) {
          throw new Error(`${btnLabel}: type must be URL or QUICK_REPLY`);
        }
        if (!String(button?.text || '').trim()) {
          throw new Error(`${btnLabel}: text is required`);
        }
        if (type === 'URL') {
          if (!String(button?.url || '').trim()) {
            throw new Error(`${btnLabel}: URL button requires url`);
          }
          try {
            button.url = normalizeMetaUrl(button.url);
          } catch {
            throw new Error(`${btnLabel}: requires a valid URL`);
          }
        }
      });
    }
  });
};

const buildCarouselComponents = (cards, bodyText, bodyVariables) => {
  // Build the CAROUSEL component per Meta's API format
  const carouselCards = cards.map((card, index) => {
    const cardComponents = [];

    // HEADER component (IMAGE)
    cardComponents.push({
      type: 'HEADER',
      format: 'IMAGE',
      example: {
        header_handle: [String(card.header_media_handle).trim()],
      },
    });

    // BODY component
    const bodyComponent = { type: 'BODY', text: String(card.body_text).trim() };
    const placeholders = parseTemplatePlaceholders(card.body_text);
    if (placeholders.length > 0) {
      const variables = Array.isArray(card.body_variables) ? card.body_variables : [];
      if (variables.length < placeholders.length) {
        throw new Error(`Card ${index + 1}: body_variables must have ${placeholders.length} example value(s) for placeholders`);
      }
      bodyComponent.example = {
        body_text: [variables.slice(0, placeholders.length)],
      };
    }
    cardComponents.push(bodyComponent);

    // BUTTONS component (optional)
    if (Array.isArray(card.buttons) && card.buttons.length > 0) {
      const buttons = card.buttons.map((btn) => {
        const type = String(btn.type).toUpperCase();
        const base = { type, text: String(btn.text).trim() };
        if (type === 'URL') {
          base.url = btn.url;
          // Check for dynamic URL
          if (String(btn.url).includes('{{1}}')) {
            base.example = [String(btn.url_example || 'https://example.com/sample').trim()];
          }
        }
        return base;
      });
      cardComponents.push({ type: 'BUTTONS', buttons });
    }

    return { components: cardComponents };
  });

  // The top-level components for a carousel template
  const components = [];

  // BODY is still required at the template level
  if (bodyText && String(bodyText).trim()) {
    const topBody = { type: 'BODY', text: String(bodyText).trim() };
    const topPlaceholders = parseTemplatePlaceholders(bodyText);
    if (topPlaceholders.length > 0) {
      const vars = Array.isArray(bodyVariables) ? bodyVariables : [];
      topBody.example = { body_text: [vars.slice(0, topPlaceholders.length)] };
    }
    components.push(topBody);
  }

  // CAROUSEL component
  components.push({
    type: 'CAROUSEL',
    cards: carouselCards,
  });

  return components;
};

// ─── LTO (Limited Time Offer) COMPONENT ───────────────────
const buildLTOComponent = () => {
  return {
    type: 'LIMITED_TIME_OFFER',
    limited_time_offer: {
      has_expiration: true,
    },
  };
};

const renderTemplateBodyPreview = (bodyTemplate = '', bodyParameters = []) => {
  let rendered = String(bodyTemplate || '');
  bodyParameters.forEach((value, index) => {
    const token = new RegExp(`\\{\\{${index + 1}\\}\\}`, 'g');
    rendered = rendered.replace(token, String(value || ''));
  });
  return rendered.trim();
};

router.post('/templates/media-handle', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const mediaUrl = String(req.body?.media_url || '').trim();
    const format = String(req.body?.format || '').toUpperCase();
    if (!mediaUrl) {
      return apiResponse(res, { status: 400, success: false, error: '[Platform] media_url is required', error_source: 'platform' });
    }
    if (!['IMAGE', 'VIDEO', 'DOCUMENT'].includes(format)) {
      return apiResponse(res, { status: 400, success: false, error: '[Platform] format must be IMAGE, VIDEO, or DOCUMENT', error_source: 'platform' });
    }

    const { token } = await getWA(req.tenant._id, req.query.account_id || req.body?.account_id);
    const response = await fetch(mediaUrl);
    if (!response.ok) {
      return apiResponse(res, { status: 400, success: false, error: `[Platform] Could not fetch media URL (${response.status})`, error_source: 'platform' });
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const upstreamType = String(response.headers.get('content-type') || '').split(';')[0].trim();
    const contentType = normalizeTemplateSampleMimeType(format, upstreamType);
    if (format === 'DOCUMENT') {
      const lowerUrl = mediaUrl.toLowerCase();
      const looksLikePdf = lowerUrl.endsWith('.pdf') || contentType === 'application/pdf';
      if (!looksLikePdf) {
        return apiResponse(res, {
          status: 400,
          success: false,
          error: '[Platform] DOCUMENT template requires a PDF file URL',
          error_source: 'platform',
        });
      }
    }
    const defaultName =
      format === 'IMAGE' ? 'template-image.jpg' :
      format === 'VIDEO' ? 'template-video.mp4' :
      'template-document.pdf';
    const uploaded = await metaService.uploadTemplateSampleHandle(
      token,
      buffer,
      contentType,
      defaultName
    );
    const handle = String(uploaded?.handle || '').trim();
    if (!handle) {
      return apiResponse(res, { status: 500, success: false, error: '[Platform] Meta did not return media handle', error_source: 'platform' });
    }
    return apiResponse(res, { data: { handle, mime_type: contentType } });
  } catch (error) {
    return handleError(res, error, 'Template media handle generation failed');
  }
});

router.get('/templates', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { wa, token } = await getWA(req.tenant._id, req.query.account_id || req.body?.account_id);
    const templates = await metaService.getTemplates(wa.waba_id, token);
    await reconcileTemplateNotifications(req.tenant._id, templates);
    if (verboseLogs) {
      console.info('[Meta Route][Templates Synced]', {
        tenant_id: String(req.tenant._id),
        template_count: templates.length,
      });
    }
    return apiResponse(res, { data: { templates } });
  }
  catch(e) { return handleError(res, e, 'Templates fetch failed'); }
});

router.post('/templates', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const {
      name, category, language, components, allow_category_change,
      is_carousel, carousel_cards,
      is_lto,
    } = req.body;

    if (!name || !category) {
      return apiResponse(res, { status: 400, success: false, error: '[Platform] name and category are required', error_source: 'platform' });
    }

    let finalComponents;

    if (is_carousel) {
      // ─── CAROUSEL TEMPLATE ────────────────────────────
      if (!Array.isArray(carousel_cards) || carousel_cards.length < 2) {
        return apiResponse(res, { status: 400, success: false, error: '[Platform] Carousel requires carousel_cards array with at least 2 cards', error_source: 'platform' });
      }
      validateCarouselCards(carousel_cards);

      // Extract top-level body from components if provided
      const topBody = Array.isArray(components)
        ? components.find((c) => String(c?.type || '').toUpperCase() === 'BODY')
        : null;
      const bodyText = topBody?.text || '';
      const bodyVariables = topBody?.example?.body_text?.[0] || [];

      finalComponents = buildCarouselComponents(carousel_cards, bodyText, bodyVariables);

      // Preserve HEADER if provided at top level (non-carousel header)
      if (Array.isArray(components)) {
        const topHeader = components.find((c) => String(c?.type || '').toUpperCase() === 'HEADER');
        if (topHeader) {
          finalComponents.unshift(topHeader);
        }
        // Preserve FOOTER if provided
        const topFooter = components.find((c) => String(c?.type || '').toUpperCase() === 'FOOTER');
        if (topFooter) {
          finalComponents.push(topFooter);
        }
      }
    } else {
      // ─── STANDARD TEMPLATE ────────────────────────────
      if (!components) {
        return apiResponse(res, { status: 400, success: false, error: '[Platform] components are required', error_source: 'platform' });
      }
      ensureTemplateComponents(components);
      finalComponents = components;
    }

    // ─── LTO (Limited Time Offer) ─────────────────────
    if (is_lto) {
      // Ensure category is MARKETING for LTO
      if (String(category).toUpperCase() !== 'MARKETING') {
        return apiResponse(res, { status: 400, success: false, error: '[Platform] Limited Time Offer templates require MARKETING category', error_source: 'platform' });
      }

      // Add LIMITED_TIME_OFFER component
      const ltoComponent = buildLTOComponent();
      finalComponents.push(ltoComponent);

      // Ensure BUTTONS exist with at least one button that includes
      // the copy_code or URL for the offer — LTO requires a CTA button.
      // We don't enforce button presence here since Meta will validate,
      // but we add the expiration_time_ms parameter to the LTO component.
    }

    const { wa, token } = await getWA(req.tenant._id, req.query.account_id || req.body?.account_id);
    const result = await metaService.createTemplate(wa.waba_id, token, {
      name,
      category,
      language: language || 'en',
      components: finalComponents,
      allow_category_change: allow_category_change !== false,
    });

    const templateType = is_carousel ? 'Carousel template' : is_lto ? 'LTO template' : 'Template';
    await Notification.create({
      tenant_id: req.tenant._id,
      type: 'template_pending',
      title: 'Template Submitted',
      message: `${templateType} "${name}" submitted to Meta for approval.`,
      source: 'meta',
      severity: 'info',
      link: '/portal/templates',
    });

    return apiResponse(res, { status: 201, data: { template: result } });
  } catch (e) { return handleError(res, e, 'Template creation failed'); }
});

router.post('/templates/:id/edit', authenticate, requireStatus('active'), async (req, res) => {
  try { const { wa, token } = await getWA(req.tenant._id, req.query.account_id || req.body?.account_id); return apiResponse(res, { data: { template: await metaService.editTemplate(req.params.id, token, req.body) } }); }
  catch(e) { return handleError(res, e, 'Template edit failed'); }
});

router.delete('/templates/:name', authenticate, requireStatus('active'), async (req, res) => {
  try { const { wa, token } = await getWA(req.tenant._id, req.query.account_id || req.body?.account_id); await metaService.deleteTemplate(wa.waba_id, token, req.params.name); return apiResponse(res, { data: { message:'Deleted from Meta' } }); }
  catch(e) { return handleError(res, e, 'Template delete failed'); }
});

// ═══════════════════════════════════════
// MESSAGING (Meta Cloud API)
// ═══════════════════════════════════════
router.post('/messages/send', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { to, text } = req.body;
    if (!to||!text) return apiResponse(res, { status:400, success:false, error:'[Platform] to and text required', error_source:'platform' });
    const { wa, token } = await getWA(req.tenant._id, req.query.account_id || req.body?.account_id);
    const normalizedTo = to.replace(/[^0-9]/g,'');
    if (verboseLogs) {
      console.info('[Platform Send][Text][Request]', {
        tenant_id: String(req.tenant._id),
        to: normalizedTo,
        body_length: text.length,
        phone_number_id: wa.phone_number_id,
      });
    }
    const result = await metaService.sendTextMessage(wa.phone_number_id, token, normalizedTo, text);
    const waMessageId = result.messages?.[0]?.id || null;
    await storeOutboundMessage({ tenantId: req.tenant._id, userId: req.user._id, phone: normalizedTo, messageType: 'text', content: text, waMessageId });
    if (verboseLogs) {
      console.info('[Meta Send][Text][Accepted]', {
        tenant_id: String(req.tenant._id),
        to: normalizedTo,
        wa_message_id: waMessageId,
      });
    }
    return apiResponse(res, { data: { result, wa_message_id:waMessageId } });
  } catch(e) {
    await notifyMetaSendFailure(req.tenant._id, 'Text message rejected by Meta', e, {
      route: 'messages/send',
      channel: 'text',
      to: req.body?.to || null,
    });
    return handleError(res, e, 'Send failed');
  }
});

router.post('/messages/send-template', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { to, template_name, language, components, header_media_url, header_type, body_parameters } = req.body;
    if (!to||!template_name) return apiResponse(res, { status:400, success:false, error:'[Platform] to and template_name required', error_source:'platform' });
    const { wa, token } = await getWA(req.tenant._id, req.query.account_id || req.body?.account_id);
    const normalizedTo = to.replace(/[^0-9]/g,'');
    let resolvedComponents = Array.isArray(components) ? components : [];

    if (!resolvedComponents.length && header_media_url) {
      const normalizedHeaderType = String(header_type || 'document').toLowerCase();
      if (!['image', 'video', 'document'].includes(normalizedHeaderType)) {
        return apiResponse(res, {
          status: 400,
          success: false,
          error: '[Platform] header_type must be image, video, or document when header_media_url is provided',
          error_source: 'platform',
        });
      }
      resolvedComponents = [
        {
          type: 'header',
          parameters: [
            {
              type: normalizedHeaderType,
              [normalizedHeaderType]: { link: String(header_media_url).trim() },
            },
          ],
        },
      ];
    }

    if (Array.isArray(body_parameters) && body_parameters.length) {
      const bodyTexts = body_parameters
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .map((text) => ({ type: 'text', text }));
      if (bodyTexts.length) {
        const existingBodyIndex = resolvedComponents.findIndex((item) => String(item?.type || '').toLowerCase() === 'body');
        if (existingBodyIndex >= 0) {
          resolvedComponents[existingBodyIndex] = { type: 'body', parameters: bodyTexts };
        } else {
          resolvedComponents.push({ type: 'body', parameters: bodyTexts });
        }
      }
    }

    const templates = await metaService.getTemplates(wa.waba_id, token);
    const matching = templates.find((tpl) => String(tpl.name || '') === String(template_name || ''));

    if (!resolvedComponents.length) {
      const expectedHeader = matching?.components?.find((item) => String(item?.type || '').toUpperCase() === 'HEADER');
      const expectedFormat = String(expectedHeader?.format || '').toUpperCase();
      if (['DOCUMENT', 'IMAGE', 'VIDEO'].includes(expectedFormat)) {
        return apiResponse(res, {
          status: 400,
          success: false,
          error: `[Platform] Template "${template_name}" requires header ${expectedFormat}. Provide header_media_url and header_type in request.`,
          error_source: 'platform',
        });
      }
    }

    const resolvedBodyParameters = resolvedComponents
      .filter((item) => String(item?.type || '').toLowerCase() === 'body')
      .flatMap((item) => item.parameters || [])
      .map((item) => String(item?.text || '').trim());
    const templateBodyText = String(
      matching?.components?.find((item) => String(item?.type || '').toUpperCase() === 'BODY')?.text || ''
    );
    const renderedBodyText = renderTemplateBodyPreview(templateBodyText, resolvedBodyParameters);
    const headerMediaParam = resolvedComponents
      .filter((item) => String(item?.type || '').toLowerCase() === 'header')
      .flatMap((item) => item.parameters || [])
      .find((param) => param?.document?.link || param?.image?.link || param?.video?.link);
    const headerMediaLink = headerMediaParam?.document?.link || headerMediaParam?.image?.link || headerMediaParam?.video?.link || '';

    if (verboseLogs) {
      console.info('[Platform Send][Template][Request]', {
        tenant_id: String(req.tenant._id),
        to: normalizedTo,
        template_name,
        language: language || 'en',
        components_count: Array.isArray(resolvedComponents) ? resolvedComponents.length : 0,
        phone_number_id: wa.phone_number_id,
      });
    }
    const result = await metaService.sendTemplateMessage(wa.phone_number_id, token, normalizedTo, template_name, language||'en', resolvedComponents||[]);
    const waMessageId = result.messages?.[0]?.id || null;
    await storeOutboundMessage({
      tenantId: req.tenant._id,
      userId: req.user._id,
      phone: normalizedTo,
      messageType: 'template',
      content: renderedBodyText || `[Template: ${template_name}]`,
      waMessageId,
      templateName: template_name,
      templateParams: {
        components: resolvedComponents || [],
        preview: {
          body_text: renderedBodyText || '',
          template_body_text: templateBodyText || '',
          header_link: headerMediaLink || '',
          header_type: headerMediaParam?.type || '',
        },
      },
    });
    if (verboseLogs) {
      console.info('[Meta Send][Template][Accepted]', {
        tenant_id: String(req.tenant._id),
        to: normalizedTo,
        template_name,
        wa_message_id: waMessageId,
      });
    }
    return apiResponse(res, { data: { result, wa_message_id:waMessageId } });
  } catch(e) {
    await notifyMetaSendFailure(req.tenant._id, 'Template message rejected by Meta', e, {
      route: 'messages/send-template',
      channel: 'template',
      to: req.body?.to || null,
      template_name: req.body?.template_name || null,
    });
    return handleError(res, e, 'Template send failed');
  }
});

router.post('/messages/send-media', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { to, type, url, caption, filename } = req.body;
    if (!to||!type||!url) return apiResponse(res, { status:400, success:false, error:'[Platform] to, type, url required', error_source:'platform' });
    const { wa, token } = await getWA(req.tenant._id, req.query.account_id || req.body?.account_id);
    const normalizedTo = to.replace(/[^0-9]/g,'');
    if (verboseLogs) {
      console.info('[Platform Send][Media][Request]', {
        tenant_id: String(req.tenant._id),
        to: normalizedTo,
        type,
        has_caption: Boolean(caption),
        phone_number_id: wa.phone_number_id,
      });
    }
    const result = await metaService.sendMediaMessage(wa.phone_number_id, token, normalizedTo, type, { url, caption, filename });
    const waMessageId = result.messages?.[0]?.id || null;
    await storeOutboundMessage({
      tenantId: req.tenant._id,
      userId: req.user._id,
      phone: normalizedTo,
      messageType: type,
      content: caption?.trim() || `[${type}] ${filename || url}`,
      waMessageId,
      mediaUrl: url,
      mediaFilename: filename || null,
    });
    if (verboseLogs) {
      console.info('[Meta Send][Media][Accepted]', {
        tenant_id: String(req.tenant._id),
        to: normalizedTo,
        type,
        wa_message_id: waMessageId,
      });
    }
    return apiResponse(res, { data: { result, wa_message_id:waMessageId } });
  } catch(e) {
    await notifyMetaSendFailure(req.tenant._id, 'Media message rejected by Meta', e, {
      route: 'messages/send-media',
      channel: req.body?.type || null,
      to: req.body?.to || null,
    });
    return handleError(res, e, 'Media send failed');
  }
});

router.post('/messages/mark-read', authenticate, requireStatus('active'), async (req, res) => {
  try { const { wa_message_id } = req.body; const { wa, token } = await getWA(req.tenant._id, req.query.account_id || req.body?.account_id); return apiResponse(res, { data: await metaService.markMessageRead(wa.phone_number_id, token, wa_message_id) }); }
  catch(e) { return handleError(res, e, 'Mark read failed'); }
});

// ═══════════════════════════════════════
// ANALYTICS (Meta Conversation API)
// ═══════════════════════════════════════
router.get('/media/:mediaId', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { token } = await getWA(req.tenant._id, req.query.account_id || req.body?.account_id);
    const media = await metaService.getMediaDetails(req.params.mediaId, token);

    if (!media?.url) {
      return apiResponse(res, {
        status: 404,
        success: false,
        error: '[Meta API Error] Media URL was not returned by Meta',
        error_source: 'meta',
      });
    }

    const mediaResponse = await fetch(media.url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!mediaResponse.ok) {
      let responseText = '';
      try {
        responseText = await mediaResponse.text();
      } catch (error) {
        responseText = '';
      }

      throw {
        source: 'meta',
        statusCode: mediaResponse.status,
        message: responseText || `Meta media download failed with status ${mediaResponse.status}`,
      };
    }

    const buffer = Buffer.from(await mediaResponse.arrayBuffer());
    const contentType = media.mime_type || mediaResponse.headers.get('content-type') || 'application/octet-stream';
    const fileSize = media.file_size || mediaResponse.headers.get('content-length');
    const fileName = media.file_name || req.query.filename || `${req.params.mediaId}`;

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Content-Disposition', `inline; filename="${String(fileName).replace(/"/g, '')}"`);
    if (fileSize) {
      res.setHeader('Content-Length', String(fileSize));
    }

    return res.status(200).send(buffer);
  } catch (e) {
    return handleError(res, e, 'Media fetch failed');
  }
});

router.get('/analytics/conversations', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { start, end, granularity } = req.query;
    const { wa, token } = await getWA(req.tenant._id, req.query.account_id || req.body?.account_id);
    const now = new Date();
    return apiResponse(res, { data: { analytics: await metaService.getConversationAnalytics(wa.waba_id, token, start||new Date(now-30*86400000).toISOString(), end||now.toISOString(), granularity||'DAILY') } });
  } catch(e) { return handleError(res, e, 'Analytics failed'); }
});

module.exports = router;
