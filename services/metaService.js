const config = require('../config');
const { graphApiBase, appId, appSecret } = config.meta;

class MetaApiError extends Error {
  constructor(message, metaError, statusCode) {
    super(message);
    this.name = 'MetaApiError';
    this.source = 'meta';
    this.metaError = metaError;
    this.statusCode = statusCode;
  }
}

const fetchJson = async (url, options = {}) => {
  const response = await fetch(url, options);
  const data = await response.json();
  if (data.error) {
    const msg = data.error.message || JSON.stringify(data.error);
    throw new MetaApiError(msg, data.error, response.status);
  }
  return data;
};

const normalizeExpiresIn = (v) => { const p = Number(v); return Number.isFinite(p) && p > 0 ? p : null; };
const buildAppAccessToken = () => {
  if (!appId || !appSecret) throw new Error('Meta app credentials are not configured.');
  return `${appId}|${appSecret}`;
};

// ═══ AUTH ═══
const exchangeCodeForToken = async (code) => {
  const d1 = await fetchJson(`${graphApiBase}/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&code=${code}`);
  const d2 = await fetchJson(`${graphApiBase}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${d1.access_token}`);
  return { accessToken: d2.access_token, expiresIn: normalizeExpiresIn(d2.expires_in) };
};

// ═══ WABA DISCOVERY ═══
const fetchBusinesses = async (t) => { const d = await fetchJson(`${graphApiBase}/me/businesses?fields=id,name&limit=100&access_token=${t}`); return d.data || []; };
const fetchWABAs = async (t) => {
  const biz = await fetchBusinesses(t); if (!biz.length) return [];
  const seen = new Set(), all = [];
  for (const b of biz) { for (const edge of ['owned_whatsapp_business_accounts','client_whatsapp_business_accounts']) { try { const d = await fetchJson(`${graphApiBase}/${b.id}/${edge}?fields=id,name,currency,account_review_status&limit=100&access_token=${t}`); for (const w of d.data||[]) { if(!seen.has(w.id)){seen.add(w.id);all.push({...w,business_id:b.id,business_name:b.name});} } } catch(e){} } }
  return all;
};
const fetchWABADetail = async (id, t) => fetchJson(`${graphApiBase}/${id}?fields=id,name,currency,account_review_status&access_token=${t}`);

// ═══ PHONE NUMBERS ═══
const fetchPhoneNumbers = async (wabaId, t) => {
  const d = await fetchJson(`${graphApiBase}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,status,name_status,code_verification_status,is_official_business_account,messaging_limit_tier,throughput&limit=100&access_token=${t}`);
  return d.data || [];
};
const fetchPhoneDetail = async (phoneId, t) => fetchJson(`${graphApiBase}/${phoneId}?fields=id,display_phone_number,verified_name,quality_rating,status,name_status,code_verification_status,is_official_business_account,messaging_limit_tier,throughput&access_token=${t}`);
const digitsOnly = (value) => String(value || '').replace(/\D/g, '');

const registerPhoneNumber = async (wabaId, t, phoneData) => {
  return fetchJson(`${graphApiBase}/${wabaId}/phone_numbers`, {
    method: 'POST', headers: { 'Content-Type':'application/json', Authorization:`Bearer ${t}` },
    body: JSON.stringify({
      cc: digitsOnly(phoneData.country_code),
      phone_number: digitsOnly(phoneData.phone_number),
      verified_name: phoneData.verified_name,
      migrate_phone_number: false,
    }),
  });
};
const requestVerificationCode = async (phoneId, t, method='SMS', locale='en_US') => {
  const payloads = [
    { code_method: method, locale, language: locale },
    { code_method: method, language: locale },
    { code_method: method, locale },
  ];
  let lastError = null;

  for (const payload of payloads) {
    try {
      return await fetchJson(`${graphApiBase}/${phoneId}/request_code`, {
        method:'POST',
        headers:{'Content-Type':'application/json',Authorization:`Bearer ${t}`},
        body: JSON.stringify(payload),
      });
    } catch (error) {
      lastError = error;
      if (error?.source !== 'meta') throw error;

      const message = String(error.message || '').toLowerCase();
      const variantMismatch =
        message.includes('parameter language is required') ||
        message.includes('parameter locale is required') ||
        message.includes('unknown path components') ||
        message.includes('unexpected parameter');

      if (!variantMismatch) throw error;
    }
  }

  throw lastError;
};
const verifyPhoneCode = async (phoneId, t, code) => {
  return fetchJson(`${graphApiBase}/${phoneId}/verify_code`, {
    method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${t}`},
    body: JSON.stringify({ code: digitsOnly(code) }),
  });
};
const registerVerifiedPhone = async (phoneId, t, pin, dataLocalizationRegion) => {
  const payload = { messaging_product:'whatsapp', pin: digitsOnly(pin) };
  if (dataLocalizationRegion) payload.data_localization_region = dataLocalizationRegion;
  return fetchJson(`${graphApiBase}/${phoneId}/register`, {
    method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${t}`},
    body: JSON.stringify(payload),
  });
};
const deregisterPhone = async (phoneId, t) => {
  return fetchJson(`${graphApiBase}/${phoneId}/deregister`, {
    method:'POST',
    headers:{'Content-Type':'application/json',Authorization:`Bearer ${t}`},
    body: JSON.stringify({}),
  });
};

// ═══ WEBHOOK ═══
const subscribeWebhook = async (wabaId, t) => fetchJson(`${graphApiBase}/${wabaId}/subscribed_apps`, { method:'POST', headers:{Authorization:`Bearer ${t}`} });
const getAppSubscriptions = async () => {
  const d = await fetchJson(`${graphApiBase}/${appId}/subscriptions?access_token=${encodeURIComponent(buildAppAccessToken())}`);
  return d.data || [];
};
const getWabaSubscribedApps = async (wabaId, t) => {
  const d = await fetchJson(`${graphApiBase}/${wabaId}/subscribed_apps?access_token=${t}`);
  return d.data || [];
};

// ═══ HEALTH ═══
const getAccountHealth = async (wabaId, phoneId, t) => {
  const [waba, phone] = await Promise.all([
    fetchJson(`${graphApiBase}/${wabaId}?fields=account_review_status,name&access_token=${t}`),
    fetchJson(`${graphApiBase}/${phoneId}?fields=quality_rating,messaging_limit_tier,status,verified_name,is_official_business_account,throughput,name_status&access_token=${t}`),
  ]);
  return { waba, phone };
};

const fetchWABABillingInfo = async (wabaId, t) =>
  fetchJson(
    `${graphApiBase}/${wabaId}?fields=id,name,currency,account_review_status,primary_funding_id,purchase_order_number&access_token=${t}`
  );

const fetchExtendedCredits = async (businessId, t) => {
  const data = await fetchJson(
    `${graphApiBase}/${businessId}/extendedcredits?fields=id,legal_entity_name,status,credit_type,currency,owner_business&limit=100&access_token=${t}`
  );
  return data.data || [];
};

// ═══ BUSINESS PROFILE ═══
const getBusinessProfile = async (phoneId, t) => { const d = await fetchJson(`${graphApiBase}/${phoneId}/whatsapp_business_profile?fields=about,address,description,email,websites,vertical,profile_picture_url&access_token=${t}`); return d.data?.[0]||{}; };
const updateBusinessProfile = async (phoneId, t, data) => fetchJson(`${graphApiBase}/${phoneId}/whatsapp_business_profile`, { method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${t}`}, body:JSON.stringify({messaging_product:'whatsapp',...data}) });

// ═══ TEMPLATES (Meta = single source of truth) ═══
const getTemplates = async (wabaId, t) => {
  let all=[], url=`${graphApiBase}/${wabaId}/message_templates?fields=id,name,status,category,language,components,quality_score,rejected_reason&limit=250&access_token=${t}`;
  while(url) { const d = await fetchJson(url); all=all.concat(d.data||[]); url=d.paging?.next||null; }
  return all;
};
const createTemplate = async (wabaId, t, data) => fetchJson(`${graphApiBase}/${wabaId}/message_templates`, { method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${t}`}, body:JSON.stringify(data) });
const editTemplate = async (tplId, t, data) => fetchJson(`${graphApiBase}/${tplId}`, { method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${t}`}, body:JSON.stringify(data) });
const deleteTemplate = async (wabaId, t, name) => fetchJson(`${graphApiBase}/${wabaId}/message_templates?name=${name}`, { method:'DELETE', headers:{Authorization:`Bearer ${t}`} });

// ═══ MESSAGING ═══
const sendTextMessage = async (phoneId, t, to, text) => fetchJson(`${graphApiBase}/${phoneId}/messages`, { method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${t}`}, body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',to,type:'text',text:{preview_url:true,body:text}}) });

const sendTemplateMessage = async (phoneId, t, to, name, lang, components) => {
  const payload = {messaging_product:'whatsapp',recipient_type:'individual',to,type:'template',template:{name,language:{code:lang||'en'}}};
  if(components?.length) payload.template.components = components;
  return fetchJson(`${graphApiBase}/${phoneId}/messages`, { method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${t}`}, body:JSON.stringify(payload) });
};

const sendMediaMessage = async (phoneId, t, to, type, mediaData) => {
  const payload = { messaging_product:'whatsapp', recipient_type:'individual', to, type };
  if (type === 'image') payload.image = { link: mediaData.url, caption: mediaData.caption || '' };
  else if (type === 'document') payload.document = { link: mediaData.url, caption: mediaData.caption || '', filename: mediaData.filename || 'file' };
  else if (type === 'video') payload.video = { link: mediaData.url, caption: mediaData.caption || '' };
  else if (type === 'audio') payload.audio = { link: mediaData.url };
  return fetchJson(`${graphApiBase}/${phoneId}/messages`, { method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${t}`}, body:JSON.stringify(payload) });
};

const uploadMedia = async (phoneId, t, fileBuffer, mimeType, filename) => {
  const formData = new FormData();
  formData.append('messaging_product', 'whatsapp');
  formData.append('file', new Blob([fileBuffer], { type: mimeType }), filename);
  formData.append('type', mimeType);
  const response = await fetch(`${graphApiBase}/${phoneId}/media`, { method: 'POST', headers: { Authorization: `Bearer ${t}` }, body: formData });
  const data = await response.json();
  if (data.error) throw new MetaApiError(data.error.message, data.error, response.status);
  return data;
};

const markMessageRead = async (phoneId, t, msgId) => fetchJson(`${graphApiBase}/${phoneId}/messages`, { method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${t}`}, body:JSON.stringify({messaging_product:'whatsapp',status:'read',message_id:msgId}) });

// ═══ CONTACT VERIFICATION ═══
// Meta Cloud API doesn't have a direct "check WhatsApp" endpoint.
// We verify by attempting a template message or checking webhook delivery status.
// However, we can check if a contact exists by sending a test and handling errors.
const getMediaDetails = async (mediaId, t) => {
  return fetchJson(`${graphApiBase}/${mediaId}?access_token=${t}`);
};
const getMediaUrl = async (mediaId, t) => {
  const details = await getMediaDetails(mediaId, t);
  return details.url || null;
};

// ═══ ANALYTICS ═══
const getConversationAnalytics = async (wabaId, t, start, end, granularity='DAILY') => {
  const s = Math.floor(new Date(start).getTime()/1000), e = Math.floor(new Date(end).getTime()/1000);
  try { const d = await fetchJson(`${graphApiBase}/${wabaId}?fields=conversation_analytics.start(${s}).end(${e}).granularity(${granularity}).dimensions(["CONVERSATION_TYPE","CONVERSATION_DIRECTION"])&access_token=${t}`); return d.conversation_analytics||{}; }
  catch(err) { return {}; }
};

module.exports = {
  MetaApiError, exchangeCodeForToken, fetchWABAs, fetchWABADetail,
  fetchPhoneNumbers, fetchPhoneDetail, registerPhoneNumber, requestVerificationCode, verifyPhoneCode, registerVerifiedPhone,
  deregisterPhone,
  subscribeWebhook, getAppSubscriptions, getWabaSubscribedApps, getAccountHealth, getBusinessProfile, updateBusinessProfile,
  fetchWABABillingInfo, fetchExtendedCredits,
  getTemplates, createTemplate, editTemplate, deleteTemplate,
  sendTextMessage, sendTemplateMessage, sendMediaMessage, uploadMedia, markMessageRead, getMediaDetails, getMediaUrl,
  getConversationAnalytics,
};
