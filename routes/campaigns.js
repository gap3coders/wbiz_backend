const express = require('express');
const { authenticate, requireStatus } = require('../middleware/auth');
const metaService = require('../services/metaService');
const { decrypt } = require('../services/encryptionService');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const Campaign = require('../models/Campaign');
const Contact = require('../models/Contact');
const Message = require('../models/Message');
const Notification = require('../models/Notification');
const { emitToTenant } = require('../services/socketService');
const { apiResponse } = require('../utils/helpers');
const router = express.Router();

const getWA = async (tid) => { const wa=await WhatsAppAccount.findOne({tenant_id:tid}); if(!wa) throw new Error('No account'); return {wa,token:decrypt(wa.access_token_encrypted)}; };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeEmail = (value) => {
  const normalized = String(value || '').trim();
  return normalized || 'N/A';
};

const renderTemplateBodyPreview = (bodyTemplate = '', bodyParameters = []) => {
  let rendered = String(bodyTemplate || '');
  bodyParameters.forEach((value, index) => {
    const token = new RegExp(`\\{\\{${index + 1}\\}\\}`, 'g');
    rendered = rendered.replace(token, String(value || ''));
  });
  return rendered.trim();
};

const resolveRecipients = async ({ tenantId, targetType, targetTags, recipients }) => {
  if (targetType === 'all') {
    const contacts = await Contact.find({ tenant_id: tenantId, opt_in: true }).select('phone');
    return contacts.map((contact) => contact.phone).filter(Boolean);
  }
  if (targetType === 'tags' && targetTags?.length) {
    const contacts = await Contact.find({ tenant_id: tenantId, labels: { $in: targetTags }, opt_in: true }).select('phone');
    return contacts.map((contact) => contact.phone).filter(Boolean);
  }
  return Array.isArray(recipients) ? recipients.filter(Boolean) : [];
};

const resolveVariable = (mapping, contact, fallbackText) => {
  if (!mapping) return fallbackText;
  if (typeof mapping === 'string') {
    if (mapping === 'contact_name') return contact?.name || contact?.wa_name || fallbackText || 'N/A';
    if (mapping === 'contact_phone') return contact?.phone || fallbackText || '-';
    if (mapping === 'contact_email') return safeEmail(contact?.email || fallbackText);
    return fallbackText;
  }
  const source = String(mapping.source || mapping.type || 'static');
  if (source === 'contact_name') return contact?.name || contact?.wa_name || String(mapping.value || fallbackText || 'N/A');
  if (source === 'contact_phone') return contact?.phone || String(mapping.value || fallbackText || '-');
  if (source === 'contact_email') return safeEmail(contact?.email || mapping.value || fallbackText);
  return String(mapping.value || fallbackText || '');
};

const normalizeTemplateComponents = (campaign, contact) => {
  const baseComponents = Array.isArray(campaign.template_components) ? campaign.template_components : [];
  const variableMapping = campaign.variable_mapping || {};
  const headerMediaMode = String(variableMapping.__header_media_mode || 'global').toLowerCase();
  const headerMediaType = String(variableMapping.__header_media_type || '').toLowerCase();
  const headerMediaGlobal = String(variableMapping.__header_media_global || '').trim();
  const headerMediaByContact = variableMapping.__header_media_by_contact && typeof variableMapping.__header_media_by_contact === 'object'
    ? variableMapping.__header_media_by_contact
    : {};
  if (!Object.keys(variableMapping).length) return baseComponents;

  const result = baseComponents.filter((component) => !['body', 'header'].includes(String(component.type || '').toLowerCase()));
  const slots = ['header', 'body'];

  for (const slot of slots) {
    const keyPrefix = `${slot}_`;
    const slotEntries = Object.entries(variableMapping).filter(([key]) => key.startsWith(keyPrefix));
    const baseComponent = baseComponents.find((component) => String(component.type || '').toLowerCase() === slot);
    const baseParameters = Array.isArray(baseComponent?.parameters) ? baseComponent.parameters : [];

    const indexSet = new Set([
      ...slotEntries.map(([key]) => Number(key.replace(keyPrefix, ''))).filter((value) => Number.isFinite(value) && value > 0),
      ...baseParameters.map((_, index) => index + 1),
    ]);

    const indexes = Array.from(indexSet).sort((a, b) => a - b);
    if (!indexes.length) continue;

    const parameters = indexes.map((index) => {
      const key = `${slot}_${index}`;
      const mapping = variableMapping[key];
      const baseParameter = baseParameters[index - 1] || {};
      if (slot === 'header' && ['image', 'video', 'document'].includes(String(baseParameter.type || '').toLowerCase())) {
        const mappedUrl = headerMediaMode === 'individual'
          ? String(headerMediaByContact?.[contact?.phone] || '').trim()
          : '';
        const resolvedUrl = mappedUrl || headerMediaGlobal || String(baseParameter?.[String(baseParameter.type || '').toLowerCase()]?.link || '').trim();
        const resolvedType = String(baseParameter.type || headerMediaType || '').toLowerCase();
        if (resolvedType && resolvedUrl) {
          return { type: resolvedType, [resolvedType]: { link: resolvedUrl } };
        }
      }
      const hasMapping = Object.prototype.hasOwnProperty.call(variableMapping, key);
      if (!hasMapping && baseParameter.type && baseParameter.type !== 'text') {
        return baseParameter;
      }
      if (baseParameter.type && baseParameter.type !== 'text') {
        return baseParameter;
      }
      const baseText = String(baseParameter.text || '').trim();
      const resolved = String(resolveVariable(mapping, contact, baseText) || '').trim();
      return { type: 'text', text: resolved || baseText || '-' };
    });

    if (parameters.length) {
      result.push({
        type: slot,
        parameters,
      });
    }
  }

  return result;
};

const rollupCampaignStats = async (tenantId, campaignId) => {
  const rows = await Message.aggregate([
    { $match: { tenant_id: tenantId, campaign_id: campaignId } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const stats = { queued: 0, sent: 0, delivered: 0, read: 0, failed: 0 };
  rows.forEach((row) => {
    stats[row._id] = row.count;
  });
  const successful = (stats.delivered || 0) + (stats.read || 0);
  await Campaign.findOneAndUpdate(
    { _id: campaignId, tenant_id: tenantId },
    {
      $set: {
        'stats.sent': successful,
        'stats.delivered': stats.delivered || 0,
        'stats.read': stats.read || 0,
        'stats.failed': stats.failed || 0,
      },
    }
  );
};

const launchCampaignInBackground = async ({ campaignId, tenantId, userId }) => {
  const campaign = await Campaign.findOne({ _id: campaignId, tenant_id: tenantId });
  if (!campaign || !['draft', 'scheduled', 'paused', 'running'].includes(campaign.status)) return;

  let accepted = 0;
  let failed = 0;
  const errors = [];

  try {
    const { wa, token } = await getWA(tenantId);
    if (campaign.status !== 'running') {
      campaign.status = 'running';
      campaign.started_at = new Date();
      await campaign.save();
    }
    emitToTenant(tenantId, 'campaign:progress', { id: campaign._id, event: 'running' });

    for (const phone of campaign.recipients || []) {
      try {
        const contact = await Contact.findOne({ tenant_id: tenantId, phone });
        const normalizedContact = contact || { name: 'N/A', wa_name: 'N/A', email: 'N/A', phone };
        normalizedContact.email = safeEmail(normalizedContact.email);
        if (!normalizedContact.name && !normalizedContact.wa_name) normalizedContact.name = 'N/A';
        const comps = normalizeTemplateComponents(campaign, normalizedContact);
        const result = await metaService.sendTemplateMessage(
          wa.phone_number_id,
          token,
          phone,
          campaign.template_name,
          campaign.template_language,
          comps
        );

        await Message.create({
          tenant_id: tenantId,
          contact_phone: phone,
          direction: 'outbound',
          message_type: 'template',
          content: renderTemplateBodyPreview(
            String(campaign.template_components?.find((item) => String(item?.type || '').toLowerCase() === 'body')?.text || ''),
            comps
              .filter((item) => String(item?.type || '').toLowerCase() === 'body')
              .flatMap((item) => item.parameters || [])
              .map((item) => String(item?.text || '').trim())
          ) || `[Campaign: ${campaign.name}]`,
          template_name: campaign.template_name,
          template_params: {
            components: comps,
            preview: {
              body_text: renderTemplateBodyPreview(
                String(campaign.template_components?.find((item) => String(item?.type || '').toLowerCase() === 'body')?.text || ''),
                comps
                  .filter((item) => String(item?.type || '').toLowerCase() === 'body')
                  .flatMap((item) => item.parameters || [])
                  .map((item) => String(item?.text || '').trim())
              ),
              template_body_text: String(campaign.template_components?.find((item) => String(item?.type || '').toLowerCase() === 'body')?.text || ''),
              header_link: comps
                .filter((item) => String(item?.type || '').toLowerCase() === 'header')
                .flatMap((item) => item.parameters || [])
                .map((param) => param?.document?.link || param?.image?.link || param?.video?.link || '')
                .find(Boolean) || '',
              header_type: comps
                .filter((item) => String(item?.type || '').toLowerCase() === 'header')
                .flatMap((item) => item.parameters || [])
                .map((param) => param?.type || '')
                .find(Boolean) || '',
            },
          },
          wa_message_id: result.messages?.[0]?.id,
          status: 'sent',
          campaign_id: campaign._id,
          sent_by: userId || null,
          timestamp: new Date(),
        });
        accepted += 1;
        await wait(120);
        emitToTenant(tenantId, 'campaign:progress', { id: campaign._id, event: 'accepted', contact_phone: phone });
      } catch (err) {
        failed += 1;
        const metaDetail = err.metaError?.error_data?.details || err.metaError?.error_user_msg || '';
        const errMsg = err.source === 'meta'
          ? `[Meta] ${err.message}${metaDetail ? ` | ${metaDetail}` : ''}`
          : `[Platform] ${err.message}`;
        errors.push({ phone, error: errMsg, source: err.source || 'platform', code: err.metaError?.code || null });
        await Message.create({
          tenant_id: tenantId,
          contact_phone: phone,
          direction: 'outbound',
          message_type: 'template',
          content: `[Campaign: ${campaign.name}]`,
          template_name: campaign.template_name,
          status: 'failed',
          error_message: errMsg,
          error_source: err.source || 'platform',
          campaign_id: campaign._id,
          timestamp: new Date(),
        });
        if (err.metaError?.code === 131026) {
          await Contact.findOneAndUpdate({ tenant_id: tenantId, phone }, { $set: { wa_exists: 'no' } });
        }
        emitToTenant(tenantId, 'campaign:progress', { id: campaign._id, event: 'failed', contact_phone: phone, error: errMsg });
      }
    }

    await rollupCampaignStats(tenantId, campaign._id);

    campaign.stats.errors = errors.slice(0, 50);
    campaign.status = 'completed';
    campaign.completed_at = new Date();
    await campaign.save();

    await Notification.create({
      tenant_id: tenantId,
      type: 'campaign_complete',
      title: `Campaign "${campaign.name}" Completed`,
      message: `Accepted: ${accepted}, Failed: ${failed}, Total: ${campaign.stats.total}. Delivered/read will update from webhook callbacks.`,
      source: 'platform',
      severity: failed > 0 ? 'warning' : 'success',
      link: '/portal/campaigns',
    });
    emitToTenant(tenantId, 'campaign:progress', { id: campaign._id, event: 'completed' });
  } catch (error) {
    campaign.status = 'failed';
    campaign.completed_at = new Date();
    campaign.stats.errors = [{ phone: null, error: error.message, source: error.source || 'platform', code: error.metaError?.code || null }];
    await campaign.save();
    await Notification.create({
      tenant_id: tenantId,
      type: 'campaign_complete',
      title: `Campaign "${campaign.name}" Failed`,
      message: error.message || 'Campaign failed unexpectedly.',
      source: error.source || 'platform',
      severity: 'error',
      link: '/portal/campaigns',
    }).catch(() => null);
    emitToTenant(tenantId, 'campaign:progress', { id: campaign._id, event: 'failed_terminal', error: error.message });
  }
};

router.get('/', authenticate, requireStatus('active'), async (req, res) => {
  try { const campaigns = await Campaign.find({tenant_id:req.tenant._id}).sort({created_at:-1}).limit(50); return apiResponse(res, {data:{campaigns}}); }
  catch(e) { return apiResponse(res, {status:500,success:false,error:'Failed'}); }
});

router.get('/:id', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const campaign = await Campaign.findOne({_id:req.params.id,tenant_id:req.tenant._id});
    if (!campaign) return apiResponse(res, {status:404,success:false,error:'Not found'});
    // Get live message stats
    const msgStats = await Message.aggregate([{$match:{tenant_id:req.tenant._id,campaign_id:campaign._id}},{$group:{_id:'$status',count:{$sum:1}}}]);
    const live = {sent:0,delivered:0,read:0,failed:0};
    msgStats.forEach(s => { live[s._id] = s.count; });
    // Get errors
    const errors = await Message.find({tenant_id:req.tenant._id,campaign_id:campaign._id,status:'failed'}).select('contact_phone error_message error_source').limit(50).lean();
    return apiResponse(res, {data:{campaign,live_stats:live,errors}});
  } catch(e) { return apiResponse(res, {status:500,success:false,error:'Failed'}); }
});

router.post('/', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { name, template_name, template_language, template_components, variable_mapping, target_type, target_tags, recipients, scheduled_at } = req.body;
    if (!name||!template_name) return apiResponse(res, {status:400,success:false,error:'[Platform] name and template required'});
    const phones = await resolveRecipients({
      tenantId: req.tenant._id,
      targetType: target_type,
      targetTags: target_tags,
      recipients,
    });
    const campaign = await Campaign.create({
      tenant_id:req.tenant._id, name, template_name, template_language:template_language||'en',
      template_components:template_components||[], variable_mapping:variable_mapping||{},
      target_type:target_type||'selected', target_tags:target_tags||[], recipients:phones,
      scheduled_at:scheduled_at||null, status:scheduled_at?'scheduled':'draft',
      stats:{total:phones.length}, created_by:req.user._id,
    });

    if (!scheduled_at) {
      launchCampaignInBackground({ campaignId: campaign._id, tenantId: req.tenant._id, userId: req.user._id }).catch((error) => {
        console.error('[Campaign Route][Auto Launch Failed]', {
          tenant_id: String(req.tenant?._id || ''),
          campaign_id: String(campaign._id),
          error: error.message,
        });
      });
      emitToTenant(req.tenant._id, 'campaign:progress', { id: campaign._id, event: 'queued_start' });
      return apiResponse(res, { status: 201, data: { campaign, launch: 'started' } });
    }
    emitToTenant(req.tenant._id, 'campaign:progress', { id: campaign._id, event: 'scheduled' });
    return apiResponse(res, {status:201,data:{campaign, launch:'scheduled'}});
  } catch(e) { return apiResponse(res, {status:500,success:false,error:`[Platform] ${e.message}`}); }
});

router.post('/:id/launch', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const campaign = await Campaign.findOne({_id:req.params.id,tenant_id:req.tenant._id});
    if (!campaign) return apiResponse(res, {status:404,success:false,error:'Not found'});
    if (!['draft','scheduled','paused'].includes(campaign.status)) return apiResponse(res, {status:400,success:false,error:'Cannot launch'});
    launchCampaignInBackground({ campaignId: campaign._id, tenantId: req.tenant._id, userId: req.user._id }).catch((error) => {
      console.error('[Campaign Route][Launch Failed]', {
        tenant_id: String(req.tenant?._id || ''),
        campaign_id: String(campaign._id),
        error: error.message,
      });
    });
    emitToTenant(req.tenant._id, 'campaign:progress', { id: campaign._id, event: 'queued_start' });
    res.json({success:true,data:{message:'Campaign launched'}});
  } catch(e) { if(!res.headersSent) return apiResponse(res, {status:500,success:false,error:'Failed'}); }
});

router.post('/:id/rerun', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const source = await Campaign.findOne({ _id: req.params.id, tenant_id: req.tenant._id });
    if (!source) return apiResponse(res, { status: 404, success: false, error: 'Not found' });

    const recipients = await resolveRecipients({
      tenantId: req.tenant._id,
      targetType: source.target_type,
      targetTags: source.target_tags,
      recipients: source.recipients,
    });

    const clone = await Campaign.create({
      tenant_id: req.tenant._id,
      name: `${source.name} (Rerun)`,
      template_name: source.template_name,
      template_language: source.template_language || 'en',
      template_components: source.template_components || [],
      variable_mapping: source.variable_mapping || {},
      target_type: source.target_type || 'selected',
      target_tags: source.target_tags || [],
      recipients,
      scheduled_at: null,
      status: 'draft',
      stats: { total: recipients.length, sent: 0, delivered: 0, read: 0, failed: 0, errors: [] },
      created_by: req.user._id,
    });

    launchCampaignInBackground({ campaignId: clone._id, tenantId: req.tenant._id, userId: req.user._id }).catch((error) => {
      console.error('[Campaign Route][Rerun Failed]', {
        tenant_id: String(req.tenant?._id || ''),
        campaign_id: String(clone._id),
        error: error.message,
      });
    });
    emitToTenant(req.tenant._id, 'campaign:progress', { id: clone._id, event: 'queued_start' });
    return apiResponse(res, { data: { campaign: clone, launch: 'started', rerun_of: source._id } });
  } catch (error) {
    return apiResponse(res, { status: 500, success: false, error: error.message || 'Failed' });
  }
});

router.delete('/:id', authenticate, requireStatus('active'), async (req, res) => {
  try { await Campaign.findOneAndDelete({_id:req.params.id,tenant_id:req.tenant._id,status:{$in:['draft','completed','failed']}}); return apiResponse(res, {data:{message:'Deleted'}}); }
  catch(e) { return apiResponse(res, {status:500,success:false,error:'Failed'}); }
});

module.exports = router;
