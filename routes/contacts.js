const express = require('express');
const { authenticate, requireStatus } = require('../middleware/auth');
const Contact = require('../models/Contact');
const Message = require('../models/Message');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const { apiResponse } = require('../utils/helpers');

const router = express.Router();

const escapeRegex = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const normalizeTags = (value) =>
  Array.from(
    new Set(
      (Array.isArray(value) ? value : [])
        .map((item) => String(item || '').trim())
        .filter(Boolean)
    )
  );

const normalizePhone = (value) => String(value || '').replace(/[^\d]/g, '');

const toClientContact = (contact = {}) => {
  const labels = normalizeTags(contact.labels?.length ? contact.labels : contact.tags);
  const phone = normalizePhone(contact.phone || contact.whatsapp_id);
  const waName = String(contact.wa_name || contact.profile_name || '').trim();

  return {
    ...contact,
    phone,
    wa_name: waName,
    profile_name: waName,
    labels,
    tags: labels,
    custom_fields:
      contact.custom_fields && typeof contact.custom_fields === 'object' && !Array.isArray(contact.custom_fields)
        ? contact.custom_fields
        : {},
  };
};

const contactLookupQuery = (tenantId, phone) => ({
  tenant_id: tenantId,
  phone,
});

router.get('/', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const label = String(req.query.label || '').trim();
    const waStatus = String(req.query.wa_status || '').trim();
    const page = parsePositiveInt(req.query.page, 1);
    const limit = Math.min(parsePositiveInt(req.query.limit, 50), 100);
    const skip = (page - 1) * limit;

    const filter = { tenant_id: req.tenant._id };

    if (search) {
      const regex = { $regex: escapeRegex(search), $options: 'i' };
      filter.$or = [
        { name: regex },
        { wa_name: regex },
        { profile_name: regex },
        { phone: regex },
        { whatsapp_id: regex },
        { email: regex },
      ];
    }

    if (label) {
      filter.$and = [...(filter.$and || []), { $or: [{ labels: label }, { tags: label }] }];
    }

    if (waStatus) {
      filter.wa_exists = waStatus;
    }

    const [contacts, total, labels, tags] = await Promise.all([
      Contact.find(filter).sort({ updated_at: -1 }).skip(skip).limit(limit).lean(),
      Contact.countDocuments(filter),
      Contact.distinct('labels', { tenant_id: req.tenant._id }),
      Contact.distinct('tags', { tenant_id: req.tenant._id }),
    ]);

    const normalizedContacts = contacts.map(toClientContact);
    const allLabels = normalizeTags([...(labels || []), ...(tags || [])]);

    return apiResponse(res, {
      data: {
        contacts: normalizedContacts,
        labels: allLabels,
        pagination: {
          page,
          limit,
          total,
          pages: Math.max(1, Math.ceil(total / limit)),
        },
      },
    });
  } catch (error) {
    console.error('[Contacts Route][List Failed]', {
      tenant_id: String(req.tenant?._id || ''),
      query: req.query,
      error: error.message,
      stack: error.stack,
    });
    return apiResponse(res, {
      status: 500,
      success: false,
      error: '[Platform] Failed to fetch contacts',
    });
  }
});

router.get('/:id', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const contact = await Contact.findOne({ _id: req.params.id, tenant_id: req.tenant._id }).lean();
    if (!contact) {
      return apiResponse(res, { status: 404, success: false, error: 'Not found' });
    }

    const normalizedContact = toClientContact(contact);
    const messages = await Message.find({
      tenant_id: req.tenant._id,
      contact_phone: normalizedContact.phone,
    })
      .sort({ timestamp: -1 })
      .limit(50)
      .lean();

    return apiResponse(res, { data: { contact: normalizedContact, messages } });
  } catch (error) {
    console.error('[Contacts Route][Detail Failed]', {
      tenant_id: String(req.tenant?._id || ''),
      contact_id: req.params.id,
      error: error.message,
    });
    return apiResponse(res, { status: 500, success: false, error: '[Platform] Failed to load contact details' });
  }
});

router.post('/maintenance/reset-schema', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const result = await Contact.updateMany(
      { tenant_id: req.tenant._id },
      [
        {
          $set: {
            phone: { $trim: { input: { $ifNull: ['$phone', '$whatsapp_id'] } } },
            wa_name: { $trim: { input: { $ifNull: ['$wa_name', '$profile_name'] } } },
            profile_name: { $trim: { input: { $ifNull: ['$wa_name', '$profile_name'] } } },
            whatsapp_id: { $ifNull: ['$whatsapp_id', { $trim: { input: { $ifNull: ['$phone', ''] } } }] },
            labels: {
              $setUnion: [
                { $cond: [{ $isArray: '$labels' }, '$labels', []] },
                { $cond: [{ $isArray: '$tags' }, '$tags', []] },
              ],
            },
            tags: {
              $setUnion: [
                { $cond: [{ $isArray: '$labels' }, '$labels', []] },
                { $cond: [{ $isArray: '$tags' }, '$tags', []] },
              ],
            },
          },
        },
        {
          $unset: ['phone_number'],
        },
      ]
    );

    return apiResponse(res, {
      data: {
        matched_count: result.matchedCount || 0,
        modified_count: result.modifiedCount || 0,
      },
    });
  } catch (error) {
    console.error('[Contacts Route][Reset Schema Failed]', {
      tenant_id: String(req.tenant?._id || ''),
      error: error.message,
    });
    return apiResponse(res, {
      status: 500,
      success: false,
      error: '[Platform] Failed to reset contact schema',
    });
  }
});

router.post('/', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { phone, name, email, labels, notes, custom_fields } = req.body || {};
    const normalizedPhone = normalizePhone(phone);

    if (!normalizedPhone) {
      return apiResponse(res, { status: 400, success: false, error: '[Platform] Phone required' });
    }

    const existing = await Contact.findOne(contactLookupQuery(req.tenant._id, normalizedPhone));
    if (existing) {
      return apiResponse(res, { status: 409, success: false, error: '[Platform] Contact already exists' });
    }

    const normalizedLabels = normalizeTags(labels);
    const contact = await Contact.create({
      tenant_id: req.tenant._id,
      phone: normalizedPhone,
      whatsapp_id: normalizedPhone,
      name: name || '',
      email: email || '',
      labels: normalizedLabels,
      tags: normalizedLabels,
      notes: notes || '',
      custom_fields: custom_fields && typeof custom_fields === 'object' ? custom_fields : {},
    });

    return apiResponse(res, {
      status: 201,
      data: { contact: toClientContact(contact.toObject()) },
    });
  } catch (error) {
    console.error('[Contacts Route][Create Failed]', {
      tenant_id: String(req.tenant?._id || ''),
      body: req.body,
      error: error.message,
    });
    return apiResponse(res, { status: 500, success: false, error: '[Platform] Failed to create contact' });
  }
});

router.post('/bulk-delete', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.contact_ids)
      ? req.body.contact_ids.map((item) => String(item || '').trim()).filter(Boolean)
      : [];

    if (!ids.length) {
      return apiResponse(res, {
        status: 400,
        success: false,
        error: '[Platform] contact_ids array required',
      });
    }

    const result = await Contact.deleteMany({
      tenant_id: req.tenant._id,
      _id: { $in: ids },
    });

    return apiResponse(res, {
      data: {
        deleted_count: result.deletedCount || 0,
      },
    });
  } catch (error) {
    console.error('[Contacts Route][Bulk Delete Failed]', {
      tenant_id: String(req.tenant?._id || ''),
      body: req.body,
      error: error.message,
    });
    return apiResponse(res, {
      status: 500,
      success: false,
      error: '[Platform] Failed to delete selected contacts',
    });
  }
});

router.put('/:id', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const payload = { ...req.body };

    if (payload.phone !== undefined || payload.phone_number !== undefined) {
      const normalizedPhone = normalizePhone(payload.phone || payload.phone_number);
      payload.phone = normalizedPhone;
      payload.whatsapp_id = normalizedPhone;
      delete payload.phone_number;
    }

    if (payload.labels !== undefined || payload.tags !== undefined) {
      const normalizedLabels = normalizeTags(payload.labels !== undefined ? payload.labels : payload.tags);
      payload.labels = normalizedLabels;
      payload.tags = normalizedLabels;
    }

    if (payload.wa_name !== undefined || payload.profile_name !== undefined) {
      const waName = String(payload.wa_name || payload.profile_name || '').trim();
      payload.wa_name = waName;
      payload.profile_name = waName;
    }

    const contact = await Contact.findOneAndUpdate(
      { _id: req.params.id, tenant_id: req.tenant._id },
      { $set: payload },
      { new: true }
    ).lean();

    if (!contact) {
      return apiResponse(res, { status: 404, success: false, error: 'Not found' });
    }

    return apiResponse(res, { data: { contact: toClientContact(contact) } });
  } catch (error) {
    console.error('[Contacts Route][Update Failed]', {
      tenant_id: String(req.tenant?._id || ''),
      contact_id: req.params.id,
      body: req.body,
      error: error.message,
    });
    return apiResponse(res, { status: 500, success: false, error: '[Platform] Failed to update contact' });
  }
});

router.delete('/:id', authenticate, requireStatus('active'), async (req, res) => {
  try {
    await Contact.findOneAndDelete({ _id: req.params.id, tenant_id: req.tenant._id });
    return apiResponse(res, { data: { message: 'Deleted' } });
  } catch (error) {
    console.error('[Contacts Route][Delete Failed]', {
      tenant_id: String(req.tenant?._id || ''),
      contact_id: req.params.id,
      error: error.message,
    });
    return apiResponse(res, { status: 500, success: false, error: '[Platform] Failed to delete contact' });
  }
});

router.post('/verify-whatsapp', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { phones } = req.body || {};
    if (!Array.isArray(phones) || !phones.length) {
      return apiResponse(res, { status: 400, success: false, error: 'phones array required' });
    }

    const wa = await WhatsAppAccount.findOne({ tenant_id: req.tenant._id });
    if (!wa) {
      return apiResponse(res, { status: 404, success: false, error: 'No WhatsApp account' });
    }

    const results = [];
    for (const phone of phones.slice(0, 20)) {
      const normalizedPhone = normalizePhone(phone);
      try {
        await Contact.findOneAndUpdate(
          contactLookupQuery(req.tenant._id, normalizedPhone),
          { $set: { last_checked_at: new Date(), phone: normalizedPhone, whatsapp_id: normalizedPhone } },
          { upsert: false }
        );
        results.push({ phone: normalizedPhone, status: 'pending_verification' });
      } catch (error) {
        results.push({ phone: normalizedPhone, status: 'error', error: error.message });
      }
    }

    return apiResponse(res, {
      data: {
        results,
        note: 'WhatsApp availability is confirmed when messages are delivered. Numbers that fail with error 131026 from Meta do not have WhatsApp.',
      },
    });
  } catch (error) {
    console.error('[Contacts Route][Verify WhatsApp Failed]', {
      tenant_id: String(req.tenant?._id || ''),
      error: error.message,
    });
    return apiResponse(res, { status: 500, success: false, error: 'Verification failed' });
  }
});

router.post('/import', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.contacts) ? req.body.contacts : null;
    if (!rows) {
      return apiResponse(res, { status: 400, success: false, error: 'contacts array required' });
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;
    const results = [];
    const seenPhones = new Set();

    for (const [index, row] of rows.entries()) {
      const rowNumber = parsePositiveInt(row?.row_number, index + 2);
      const normalizedPhone = normalizePhone(row?.phone);
      if (!normalizedPhone) {
        skipped += 1;
        results.push({
          row_number: rowNumber,
          phone: '',
          name: String(row?.name || '').trim(),
          status: 'skipped',
          reason: 'Phone is required',
        });
        continue;
      }

      if (seenPhones.has(normalizedPhone)) {
        skipped += 1;
        results.push({
          row_number: rowNumber,
          phone: normalizedPhone,
          name: String(row?.name || '').trim(),
          status: 'skipped',
          reason: 'Duplicate phone found in the uploaded file',
        });
        continue;
      }
      seenPhones.add(normalizedPhone);

      const normalizedLabels = normalizeTags(row?.labels);
      const payload = {
        phone: normalizedPhone,
        whatsapp_id: normalizedPhone,
        name: row?.name || '',
        email: row?.email || '',
        labels: normalizedLabels,
        tags: normalizedLabels,
        notes: row?.notes || '',
        custom_fields:
          row?.custom_fields && typeof row.custom_fields === 'object' && !Array.isArray(row.custom_fields)
            ? row.custom_fields
            : {},
      };

      try {
        const existing = await Contact.findOne(contactLookupQuery(req.tenant._id, normalizedPhone))
          .select('_id')
          .lean();

        if (existing?._id) {
          await Contact.updateOne(
            { _id: existing._id, tenant_id: req.tenant._id },
            { $set: payload }
          );
          updated += 1;
          results.push({
            row_number: rowNumber,
            phone: normalizedPhone,
            name: String(row?.name || '').trim(),
            status: 'updated',
            reason: 'Existing contact updated by phone number',
          });
        } else {
          await Contact.create({
            tenant_id: req.tenant._id,
            ...payload,
          });
          created += 1;
          results.push({
            row_number: rowNumber,
            phone: normalizedPhone,
            name: String(row?.name || '').trim(),
            status: 'created',
            reason: null,
          });
        }
      } catch (error) {
        console.warn('[Contacts Route][Import Row Skipped]', {
          tenant_id: String(req.tenant?._id || ''),
          phone: normalizedPhone,
          row_number: rowNumber,
          error: error.message,
        });
        skipped += 1;
        results.push({
          row_number: rowNumber,
          phone: normalizedPhone,
          name: String(row?.name || '').trim(),
          status: 'skipped',
          reason: error.message,
        });
      }
    }

    return apiResponse(res, {
      data: {
        created,
        updated,
        imported: created + updated,
        skipped,
        processed: rows.length,
        results,
      },
    });
  } catch (error) {
    console.error('[Contacts Route][Import Failed]', {
      tenant_id: String(req.tenant?._id || ''),
      error: error.message,
    });
    return apiResponse(res, { status: 500, success: false, error: 'Import failed' });
  }
});

module.exports = router;
