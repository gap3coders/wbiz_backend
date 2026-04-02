const express = require('express');
const { authenticate, requireStatus } = require('../middleware/auth');
const metaService = require('../services/metaService');
const { decrypt } = require('../services/encryptionService');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const Campaign = require('../models/Campaign');
const Contact = require('../models/Contact');
const Message = require('../models/Message');
const Notification = require('../models/Notification');
const { apiResponse } = require('../utils/helpers');
const router = express.Router();

const getWA = async (tid) => { const wa=await WhatsAppAccount.findOne({tenant_id:tid}); if(!wa) throw new Error('No account'); return {wa,token:decrypt(wa.access_token_encrypted)}; };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const resolveVariable = (mapping, contact, fallbackText) => {
  if (!mapping) return fallbackText;
  if (typeof mapping === 'string') {
    if (mapping === 'contact_name') return contact?.name || contact?.wa_name || fallbackText;
    if (mapping === 'contact_phone') return contact?.phone || fallbackText;
    if (mapping === 'contact_email') return contact?.email || fallbackText;
    return fallbackText;
  }
  const source = String(mapping.source || mapping.type || 'static');
  if (source === 'contact_name') return contact?.name || contact?.wa_name || String(mapping.value || fallbackText || '');
  if (source === 'contact_phone') return contact?.phone || String(mapping.value || fallbackText || '');
  if (source === 'contact_email') return contact?.email || String(mapping.value || fallbackText || '');
  return String(mapping.value || fallbackText || '');
};

const normalizeTemplateComponents = (campaign, contact) => {
  const baseComponents = Array.isArray(campaign.template_components) ? campaign.template_components : [];
  const variableMapping = campaign.variable_mapping || {};
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
      const baseText = String(baseParameters[index - 1]?.text || '').trim();
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

  const { wa, token } = await getWA(tenantId);
  if (campaign.status !== 'running') {
    campaign.status = 'running';
    campaign.started_at = new Date();
    await campaign.save();
  }

  let accepted = 0;
  let failed = 0;
  const errors = [];

  for (const phone of campaign.recipients || []) {
    try {
      const contact = await Contact.findOne({ tenant_id: tenantId, phone });
      const comps = normalizeTemplateComponents(campaign, contact);
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
        content: `[Campaign: ${campaign.name}]`,
        template_name: campaign.template_name,
        template_params: { components: comps },
        wa_message_id: result.messages?.[0]?.id,
        status: 'sent',
        campaign_id: campaign._id,
        sent_by: userId || null,
        timestamp: new Date(),
      });
      accepted += 1;
      await wait(120);
    } catch (err) {
      failed += 1;
      const errMsg = err.source === 'meta' ? `[Meta] ${err.message}` : `[Platform] ${err.message}`;
      errors.push({ phone, error: errMsg, source: err.source || 'platform' });
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
    let phones = recipients || [];
    if (target_type==='all') {
      const contacts = await Contact.find({tenant_id:req.tenant._id,opt_in:true});
      phones = contacts.map(c=>c.phone);
    } else if (target_type==='tags' && target_tags?.length) {
      const contacts = await Contact.find({tenant_id:req.tenant._id,labels:{$in:target_tags},opt_in:true});
      phones = contacts.map(c=>c.phone);
    }
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
      return apiResponse(res, { status: 201, data: { campaign, launch: 'started' } });
    }
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
    res.json({success:true,data:{message:'Campaign launched'}});
  } catch(e) { if(!res.headersSent) return apiResponse(res, {status:500,success:false,error:'Failed'}); }
});

router.delete('/:id', authenticate, requireStatus('active'), async (req, res) => {
  try { await Campaign.findOneAndDelete({_id:req.params.id,tenant_id:req.tenant._id,status:{$in:['draft','completed','failed']}}); return apiResponse(res, {data:{message:'Deleted'}}); }
  catch(e) { return apiResponse(res, {status:500,success:false,error:'Failed'}); }
});

module.exports = router;
