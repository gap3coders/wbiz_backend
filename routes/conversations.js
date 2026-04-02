const express = require('express');
const { authenticate, requireStatus } = require('../middleware/auth');
const Message = require('../models/Message');
const Contact = require('../models/Contact');
const { apiResponse } = require('../utils/helpers');
const router = express.Router();
const normalizePhone = (value) => String(value || '').replace(/[^\d]/g, '');

router.get('/', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { search } = req.query;
    const pipeline = [
      { $match: { tenant_id: req.tenant._id } }, { $sort: { timestamp: -1 } },
      {
        $group: {
          _id:'$contact_phone',
          contact_name:{$first:'$contact_name'},
          contact_phone:{$first:'$contact_phone'},
          last_message:{$first:'$content'},
          last_message_type:{$first:'$message_type'},
          last_message_direction:{$first:'$direction'},
          last_message_status:{$first:'$status'},
          last_message_at:{$first:'$timestamp'},
          last_template_name:{$first:'$template_name'},
          last_media_url:{$first:'$media_url'},
          last_media_id:{$first:'$media_id'},
          last_media_filename:{$first:'$media_filename'},
          unread_count:{$sum:{$cond:[{$and:[{$eq:['$direction','inbound']},{$ne:['$status','read']}]},1,0]}},
          total_messages:{$sum:1},
        },
      },
      { $sort: { last_message_at: -1 } },
    ];
    if (search) pipeline.push({ $match:{ $or:[{contact_name:{$regex:search,$options:'i'}},{contact_phone:{$regex:search,$options:'i'}}] } });
    pipeline.push({ $limit: 50 });
    const [convos, unreadAgg] = await Promise.all([
      Message.aggregate(pipeline),
      Message.aggregate([
        { $match: { tenant_id: req.tenant._id, direction: 'inbound', status: { $ne: 'read' } } },
        { $group: { _id: null, unread_count: { $sum: 1 } } },
      ]),
    ]);

    const phones = Array.from(new Set(convos.map((item) => normalizePhone(item.contact_phone)).filter(Boolean)));
    const contacts = phones.length
      ? await Contact.find({ tenant_id: req.tenant._id, phone: { $in: phones } })
        .select('phone name wa_name profile_name email wa_exists')
        .lean()
      : [];
    const contactsByPhone = new Map(contacts.map((item) => [normalizePhone(item.phone), item]));

    const conversations = convos.map((item) => {
      const normalizedPhone = normalizePhone(item.contact_phone);
      const contact = contactsByPhone.get(normalizedPhone) || null;
      return {
        ...item,
        contact_name: contact?.name || contact?.wa_name || contact?.profile_name || item.contact_name || item.contact_phone || '',
        name: contact?.name || '',
        wa_name: contact?.wa_name || '',
        contact_email: contact?.email || '',
        wa_exists: contact?.wa_exists || 'unknown',
      };
    });

    return apiResponse(res, { data:{ conversations, counts: { unread: unreadAgg?.[0]?.unread_count || 0 } } });
  } catch(e) { return apiResponse(res, { status:500, success:false, error:'Failed' }); }
});

router.get('/:phone', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const normalizedPhone = normalizePhone(req.params.phone);
    const msgs = await Message.find({ tenant_id:req.tenant._id, contact_phone:normalizedPhone }).sort({timestamp:1}).limit(200);
    const contact = await Contact.findOne({
      tenant_id: req.tenant._id,
      phone: normalizedPhone,
    });
    return apiResponse(res, { data:{ messages:msgs, contact } });
  } catch(e) { return apiResponse(res, { status:500, success:false, error:'Failed' }); }
});

router.post('/:phone/read', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const normalizedPhone = normalizePhone(req.params.phone);
    const result = await Message.updateMany(
      {
        tenant_id: req.tenant._id,
        contact_phone: normalizedPhone,
        direction: 'inbound',
        status: { $ne: 'read' },
      },
      {
        $set: {
          status: 'read',
        },
      }
    );

    return apiResponse(res, {
      data: {
        contact_phone: normalizedPhone,
        updated_count: Number(result.modifiedCount || 0),
      },
    });
  } catch (error) {
    console.error('[Conversations Route][Mark Read Failed]', {
      tenant_id: String(req.tenant?._id || ''),
      phone: req.params.phone,
      error: error.message,
    });
    return apiResponse(res, {
      status: 500,
      success: false,
      error: '[Platform] Failed to mark conversation as read',
    });
  }
});

module.exports = router;
