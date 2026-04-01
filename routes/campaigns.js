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
    return apiResponse(res, {status:201,data:{campaign}});
  } catch(e) { return apiResponse(res, {status:500,success:false,error:`[Platform] ${e.message}`}); }
});

router.post('/:id/launch', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const campaign = await Campaign.findOne({_id:req.params.id,tenant_id:req.tenant._id});
    if (!campaign) return apiResponse(res, {status:404,success:false,error:'Not found'});
    if (!['draft','scheduled','paused'].includes(campaign.status)) return apiResponse(res, {status:400,success:false,error:'Cannot launch'});
    const {wa,token} = await getWA(req.tenant._id);
    campaign.status='running'; campaign.started_at=new Date(); await campaign.save();
    res.json({success:true,data:{message:'Campaign launched'}});

    let sent=0,failed=0;
    const errors = [];
    for (const phone of campaign.recipients) {
      try {
        // Build dynamic components per contact
        let comps = campaign.template_components || [];
        if (campaign.variable_mapping && Object.keys(campaign.variable_mapping).length) {
          const contact = await Contact.findOne({tenant_id:req.tenant._id,phone});
          if (contact) {
            comps = comps.map(c => {
              if (c.type==='body' && c.parameters) {
                return {...c, parameters: c.parameters.map((p,i) => {
                  const mapping = campaign.variable_mapping[`body_${i+1}`];
                  if (mapping === 'contact_name') return {...p, text: contact.name || p.text};
                  if (mapping === 'contact_phone') return {...p, text: contact.phone || p.text};
                  if (mapping === 'contact_email') return {...p, text: contact.email || p.text};
                  return p;
                })};
              }
              return c;
            });
          }
        }
        const result = await metaService.sendTemplateMessage(wa.phone_number_id,token,phone,campaign.template_name,campaign.template_language,comps);
        await Message.create({tenant_id:req.tenant._id,contact_phone:phone,direction:'outbound',message_type:'template',content:`[Campaign: ${campaign.name}]`,template_name:campaign.template_name,wa_message_id:result.messages?.[0]?.id,status:'sent',campaign_id:campaign._id,sent_by:req.user._id,timestamp:new Date()});
        sent++;
        await new Promise(r=>setTimeout(r,100));
      } catch(err) {
        failed++;
        const errMsg = err.source==='meta' ? `[Meta] ${err.message}` : `[Platform] ${err.message}`;
        errors.push({phone,error:errMsg,source:err.source||'platform'});
        await Message.create({tenant_id:req.tenant._id,contact_phone:phone,direction:'outbound',message_type:'template',content:`[Campaign: ${campaign.name}]`,template_name:campaign.template_name,status:'failed',error_message:errMsg,error_source:err.source||'platform',campaign_id:campaign._id,timestamp:new Date()});
        // Mark contact if WA not available
        if (err.metaError?.code === 131026) {
          await Contact.findOneAndUpdate({tenant_id:req.tenant._id,phone},{$set:{wa_exists:'no'}});
        }
      }
    }
    campaign.stats.sent=sent; campaign.stats.failed=failed; campaign.stats.errors=errors.slice(0,50);
    campaign.status='completed'; campaign.completed_at=new Date(); await campaign.save();
    await Notification.create({tenant_id:req.tenant._id,type:'campaign_complete',title:`Campaign "${campaign.name}" Completed`,message:`Sent: ${sent}, Failed: ${failed} out of ${campaign.stats.total} recipients.`,source:'platform',severity:failed>0?'warning':'success',link:'/portal/campaigns'});
  } catch(e) { if(!res.headersSent) return apiResponse(res, {status:500,success:false,error:'Failed'}); }
});

router.delete('/:id', authenticate, requireStatus('active'), async (req, res) => {
  try { await Campaign.findOneAndDelete({_id:req.params.id,tenant_id:req.tenant._id,status:{$in:['draft','completed','failed']}}); return apiResponse(res, {data:{message:'Deleted'}}); }
  catch(e) { return apiResponse(res, {status:500,success:false,error:'Failed'}); }
});

module.exports = router;
