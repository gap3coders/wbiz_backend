const AutoResponseRule = require('../models/AutoResponseRule');
const AutoResponseLog = require('../models/AutoResponseLog');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const Contact = require('../models/Contact');
const Message = require('../models/Message');
const Notification = require('../models/Notification');
const metaService = require('./metaService');
const { decrypt } = require('./encryptionService');
const { parsePhoneInput } = require('../utils/phone');

const normalizePhone = (value = '') => String(value || '').replace(/[^\d]/g, '');
const normalizeText = (value = '') => String(value || '').trim().toLowerCase();

const extractInboundText = (message = {}) => {
  if (message.type === 'text') return message.text?.body || '';
  if (message.type === 'button') return message.button?.text || '';
  if (message.type === 'interactive') {
    return (
      message.interactive?.button_reply?.title ||
      message.interactive?.list_reply?.title ||
      message.interactive?.list_reply?.description ||
      ''
    );
  }
  if (message.type === 'image') return message.image?.caption || '';
  if (message.type === 'document') return message.document?.caption || '';
  if (message.type === 'video') return message.video?.caption || '';
  return '';
};

const interpolateText = (template = '', context = {}) =>
  String(template || '').replace(/\{\{\s*(contact_name|contact_phone|contact_email|incoming_text)\s*\}\}/gi, (_, token) => {
    if (token === 'contact_name') return context.contact_name || 'Customer';
    if (token === 'contact_phone') return context.contact_phone || '';
    if (token === 'contact_email') return context.contact_email || '';
    if (token === 'incoming_text') return context.incoming_text || '';
    return '';
  });

const buildTemplateComponents = (rule, context) => {
  const variables = Array.isArray(rule.template_variables) ? rule.template_variables : [];
  const components = [];

  if (['image', 'video', 'document'].includes(String(rule.template_header_type || '').toLowerCase()) && String(rule.template_header_media_url || '').trim()) {
    const headerType = String(rule.template_header_type || '').toLowerCase();
    components.push({
      type: 'header',
      parameters: [
        {
          type: headerType,
          [headerType]: { link: String(rule.template_header_media_url || '').trim() },
        },
      ],
    });
  }

  if (!variables.length) return components;

  const bodyParameters = variables
    .filter((variable) => !String(variable.key || '').startsWith('header_'))
    .sort((left, right) => Number(left.key) - Number(right.key))
    .map((variable) => {
      let value = String(variable.value || '');
      if (variable.source === 'contact_name') value = context.contact_name || 'Customer';
      if (variable.source === 'contact_phone') value = context.contact_phone || '';
      if (variable.source === 'contact_email') value = context.contact_email || '';
      if (variable.source === 'incoming_text') value = context.incoming_text || '';
      return { type: 'text', text: value || `{{${variable.key}}}` };
    });

  if (bodyParameters.length) components.push({ type: 'body', parameters: bodyParameters });
  return components;
};

const parseMinutes = (value) => {
  const [hours, minutes] = String(value || '00:00').split(':').map((item) => Number.parseInt(item, 10));
  return ((Number.isFinite(hours) ? hours : 0) * 60) + (Number.isFinite(minutes) ? minutes : 0);
};

const getLocalParts = (date, timezone) => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || 'Asia/Kolkata',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const weekday = parts.find((part) => part.type === 'weekday')?.value || 'Mon';
  const hour = parts.find((part) => part.type === 'hour')?.value || '00';
  const minute = parts.find((part) => part.type === 'minute')?.value || '00';
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    day: weekdayMap[weekday] ?? 1,
    minutes: parseMinutes(`${hour}:${minute}`),
  };
};

const isWithinBusinessHours = (rule, date = new Date()) => {
  const config = rule.business_hours || {};
  const timezone = config.timezone || 'Asia/Kolkata';
  const days = Array.isArray(config.days) && config.days.length ? config.days : [1, 2, 3, 4, 5];
  const startMinutes = parseMinutes(config.start_time || '09:00');
  const endMinutes = parseMinutes(config.end_time || '18:00');
  const local = getLocalParts(date, timezone);

  if (!days.includes(local.day)) return false;
  if (endMinutes >= startMinutes) {
    return local.minutes >= startMinutes && local.minutes <= endMinutes;
  }
  return local.minutes >= startMinutes || local.minutes <= endMinutes;
};

const keywordMatches = (rule, incomingText) => {
  const normalizedIncoming = normalizeText(incomingText);
  if (!normalizedIncoming) return false;
  const keywords = Array.isArray(rule.keywords) ? rule.keywords : [];
  if (!keywords.length) return false;

  return keywords.some((keyword) => {
    const normalizedKeyword = normalizeText(keyword);
    if (!normalizedKeyword) return false;
    if (rule.keyword_match_type === 'exact') return normalizedIncoming === normalizedKeyword;
    if (rule.keyword_match_type === 'starts_with') return normalizedIncoming.startsWith(normalizedKeyword);
    return normalizedIncoming.includes(normalizedKeyword);
  });
};

const shouldSkipForCooldown = async (tenantId, rule, contactPhone) => {
  const latestLog = await AutoResponseLog.findOne({
    tenant_id: tenantId,
    rule_id: rule._id,
    contact_phone: contactPhone,
    status: 'sent',
  })
    .sort({ created_at: -1 })
    .lean();

  if (!latestLog) return null;

  if (rule.send_once_per_contact) {
    return 'Rule is configured to send only once per contact';
  }

  const cooldownMinutes = Number(rule.cooldown_minutes || 0);
  if (!cooldownMinutes) return null;

  const threshold = new Date(Date.now() - cooldownMinutes * 60 * 1000);
  if (new Date(latestLog.created_at).getTime() > threshold.getTime()) {
    return `Cooldown active for ${cooldownMinutes} minute(s)`;
  }

  return null;
};

const storeOutboundMessage = async ({
  tenantId,
  phone,
  messageType,
  content,
  waMessageId,
  templateName = null,
  templateParams = null,
}) => {
  const parsedPhone = parsePhoneInput({ phone });
  const normalizedPhone = parsedPhone.phone || normalizePhone(phone);
  const contact = await Contact.findOneAndUpdate(
    {
      tenant_id: tenantId,
      phone: normalizedPhone,
    },
    {
      $set: {
        phone: normalizedPhone,
        country_code: parsedPhone.country_code || '',
        phone_number: parsedPhone.phone_number || '',
        whatsapp_id: normalizedPhone,
        wa_exists: 'yes',
        last_message_at: new Date(),
      },
      $setOnInsert: { tenant_id: tenantId },
    },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: false }
  );

  return Message.create({
    tenant_id: tenantId,
    contact_phone: normalizedPhone,
    contact_name: contact.name || contact.wa_name || '',
    direction: 'outbound',
    message_type: messageType,
    content,
    template_name: templateName,
    template_params: templateParams,
    wa_message_id: waMessageId,
    status: 'sent',
    timestamp: new Date(),
  });
};

const evaluateRule = async ({ tenantId, rule, message, phone }) => {
  if (rule.trigger_type === 'keyword') {
    return keywordMatches(rule, extractInboundText(message));
  }

  if (rule.trigger_type === 'welcome') {
    const inboundCount = await Message.countDocuments({
      tenant_id: tenantId,
      contact_phone: phone,
      direction: 'inbound',
    });
    return inboundCount <= 1;
  }

  if (rule.trigger_type === 'away') {
    return !isWithinBusinessHours(rule, new Date());
  }

  if (rule.trigger_type === 'fallback') {
    return true;
  }

  return false;
};

const executeRule = async ({ tenantId, rule, inboundMessage, waAccount, contact }) => {
  const contactPhone = normalizePhone(inboundMessage.from);
  const context = {
    contact_name: contact?.wa_name || contact?.name || 'Customer',
    contact_phone: contactPhone,
    contact_email: contact?.email || '',
    incoming_text: extractInboundText(inboundMessage),
  };

  const cooldownReason = await shouldSkipForCooldown(tenantId, rule, contactPhone);
  if (cooldownReason) {
    await AutoResponseLog.create({
      tenant_id: tenantId,
      rule_id: rule._id,
      rule_name: rule.name,
      trigger_type: rule.trigger_type,
      response_type: rule.response_type,
      contact_phone: contactPhone,
      contact_name: context.contact_name,
      inbound_message_id: inboundMessage.id || null,
      matched_text: context.incoming_text,
      status: 'skipped',
      reason: cooldownReason,
    });
    return { matched: true, sent: false, reason: cooldownReason };
  }

  const accessToken = decrypt(waAccount.access_token_encrypted);

  try {
    let waMessageId = null;
    let storedMessage = null;

    if (rule.response_type === 'template') {
      const templateComponents = buildTemplateComponents(rule, context);
      const result = await metaService.sendTemplateMessage(
        waAccount.phone_number_id,
        accessToken,
        contactPhone,
        rule.template_name,
        rule.template_language || 'en',
        templateComponents
      );
      waMessageId = result.messages?.[0]?.id || null;
      const bodyValues = templateComponents
        .filter((item) => String(item?.type || '').toLowerCase() === 'body')
        .flatMap((item) => item.parameters || [])
        .map((item) => String(item?.text || '').trim());
      storedMessage = await storeOutboundMessage({
        tenantId,
        phone: contactPhone,
        messageType: 'template',
        content: bodyValues.join(' ') || `[Template: ${rule.template_name}]`,
        waMessageId,
        templateName: rule.template_name,
        templateParams: {
          components: templateComponents,
          preview: {
            body_text: bodyValues.join(' '),
            template_body_text: '',
            header_link: templateComponents
              .filter((item) => String(item?.type || '').toLowerCase() === 'header')
              .flatMap((item) => item.parameters || [])
              .map((item) => item?.document?.link || item?.image?.link || item?.video?.link || '')
              .find(Boolean) || '',
            header_type: templateComponents
              .filter((item) => String(item?.type || '').toLowerCase() === 'header')
              .flatMap((item) => item.parameters || [])
              .map((item) => item?.type || '')
              .find(Boolean) || '',
          },
        },
      });
    } else {
      const text = interpolateText(rule.text_body, context);
      const result = await metaService.sendTextMessage(waAccount.phone_number_id, accessToken, contactPhone, text);
      waMessageId = result.messages?.[0]?.id || null;
      storedMessage = await storeOutboundMessage({
        tenantId,
        phone: contactPhone,
        messageType: 'text',
        content: text,
        waMessageId,
      });
    }

    await AutoResponseLog.create({
      tenant_id: tenantId,
      rule_id: rule._id,
      rule_name: rule.name,
      trigger_type: rule.trigger_type,
      response_type: rule.response_type,
      contact_phone: contactPhone,
      contact_name: context.contact_name,
      inbound_message_id: inboundMessage.id || null,
      matched_text: context.incoming_text,
      status: 'sent',
      reason: '',
      outbound_message_id: storedMessage?._id || null,
      wa_message_id: waMessageId,
      meta_data: {
        response_type: rule.response_type,
        template_name: rule.template_name || null,
      },
    });

    return { matched: true, sent: true };
  } catch (error) {
    await AutoResponseLog.create({
      tenant_id: tenantId,
      rule_id: rule._id,
      rule_name: rule.name,
      trigger_type: rule.trigger_type,
      response_type: rule.response_type,
      contact_phone: contactPhone,
      contact_name: context.contact_name,
      inbound_message_id: inboundMessage.id || null,
      matched_text: context.incoming_text,
      status: 'failed',
      reason: error.message || 'Meta send failed',
      meta_data: {
        code: error.metaError?.code || null,
        type: error.metaError?.type || null,
      },
    });

    await Notification.create({
      tenant_id: tenantId,
      type: 'system',
      title: `Auto response failed: ${rule.name}`,
      message: `[Meta] Auto response could not be delivered.${error.message ? ` ${error.message}` : ''}`,
      source: error.source === 'meta' ? 'meta' : 'platform',
      severity: 'error',
      link: '/portal/auto-responses',
      meta_data: {
        rule_id: rule._id,
        code: error.metaError?.code || null,
      },
    }).catch(() => null);

    return { matched: true, sent: false, reason: error.message || 'Meta send failed' };
  }
};

const processInboundAutoResponses = async ({ tenantId, inboundMessage }) => {
  const contactPhone = normalizePhone(inboundMessage.from);
  if (!tenantId || !contactPhone) return;

  const [waAccount, contact, rules] = await Promise.all([
    WhatsAppAccount.findOne({ tenant_id: tenantId, account_status: 'active' }),
    Contact.findOne({
      tenant_id: tenantId,
      phone: contactPhone,
    }),
    AutoResponseRule.find({ tenant_id: tenantId, active: true }).sort({ priority: 1, created_at: 1 }),
  ]);

  if (!waAccount || !rules.length) return;

  const nonFallbackRules = rules.filter((rule) => rule.trigger_type !== 'fallback');
  const fallbackRules = rules.filter((rule) => rule.trigger_type === 'fallback');

  let matchedAnyRule = false;

  for (const rule of nonFallbackRules) {
    const matched = await evaluateRule({ tenantId, rule, message: inboundMessage, phone: contactPhone });
    if (!matched) continue;
    matchedAnyRule = true;
    const result = await executeRule({ tenantId, rule, inboundMessage, waAccount, contact });
    if (rule.stop_after_match || result.sent || result.reason) break;
  }

  if (matchedAnyRule) return;

  for (const rule of fallbackRules) {
    const result = await executeRule({ tenantId, rule, inboundMessage, waAccount, contact });
    if (rule.stop_after_match || result.sent || result.reason) break;
  }
};

module.exports = {
  processInboundAutoResponses,
  extractInboundText,
  interpolateText,
};
