const express = require('express');
const { authenticate, requireStatus } = require('../middleware/auth');
const Contact = require('../models/Contact');
const CustomFieldDefinition = require('../models/CustomFieldDefinition');
const Message = require('../models/Message');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const { apiResponse } = require('../utils/helpers');
const { parsePhoneInput } = require('../utils/phone');

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

const normalizePhone = (value) => parsePhoneInput({ phone: value }).phone || '';

const toClientContact = (contact = {}) => {
  const labels = normalizeTags(contact.labels?.length ? contact.labels : contact.tags);
  const parsedPhone = parsePhoneInput({
    phone: contact.phone || contact.whatsapp_id,
    country_code: contact.country_code,
    phone_number: contact.phone_number,
  });
  const phone = parsedPhone.phone;
  const waName = String(contact.wa_name || contact.profile_name || '').trim();

  return {
    ...contact,
    phone,
    country_code: parsedPhone.country_code || '',
    phone_number: parsedPhone.phone_number || '',
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
      const digits = String(search).replace(/[^\d]/g, '');
      const digitRegex = digits ? { $regex: escapeRegex(digits), $options: 'i' } : null;
      filter.$or = [
        { name: regex },
        { wa_name: regex },
        { profile_name: regex },
        { phone: regex },
        { whatsapp_id: regex },
        { email: regex },
        ...(digitRegex ? [{ phone: digitRegex }, { phone_number: digitRegex }, { country_code: digitRegex }] : []),
      ];
    }

    if (label) {
      filter.$and = [...(filter.$and || []), { $or: [{ labels: label }, { tags: label }] }];
    }

    if (waStatus) {
      filter.wa_exists = waStatus;
    }

    const subscription = String(req.query.subscription || '').trim();
    if (subscription === 'subscribed') {
      filter.opt_in = { $ne: false };
    } else if (subscription === 'unsubscribed') {
      filter.opt_in = false;
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

/* ── EXPORT TO CSV (must be before /:id) ───────────────── */
router.get('/export/csv', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const filter = { tenant_id: req.tenant._id };
    if (req.query.tag) filter.tags = req.query.tag;
    if (req.query.subscription) filter.subscription_status = req.query.subscription;
    if (req.query.wa_exists) filter.wa_exists = req.query.wa_exists;

    const [contacts, fieldDefs] = await Promise.all([
      Contact.find(filter).sort({ created_at: -1 }).lean(),
      CustomFieldDefinition.find({ tenant_id: req.tenant._id, is_active: true }).sort({ sort_order: 1 }).lean(),
    ]);

    const standardHeaders = ['Name', 'Phone', 'Country Code', 'Email', 'WhatsApp Status', 'Subscription', 'Tags', 'Notes', 'Birthday', 'Opt In', 'Created At'];
    const customHeaders = fieldDefs.map((d) => d.field_label || d.field_name);
    const headers = [...standardHeaders, ...customHeaders];

    const escapeCSV = (val) => {
      const str = String(val ?? '');
      return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str.replace(/"/g, '""')}"` : str;
    };

    const rows = contacts.map((c) => {
      const standardCols = [
        escapeCSV(c.name || c.wa_name || ''),
        escapeCSV(c.phone),
        escapeCSV(c.country_code),
        escapeCSV(c.email),
        escapeCSV(c.wa_exists),
        escapeCSV(c.subscription_status || 'subscribed'),
        escapeCSV((c.tags || []).join('; ')),
        escapeCSV(c.notes),
        escapeCSV(c.birthday),
        escapeCSV(c.opt_in !== false ? 'Yes' : 'No'),
        escapeCSV(c.created_at ? new Date(c.created_at).toISOString() : ''),
      ];
      const cf = c.custom_fields && typeof c.custom_fields === 'object' ? c.custom_fields : {};
      const customCols = fieldDefs.map((d) => escapeCSV(cf[d.field_name] ?? ''));
      return [...standardCols, ...customCols].join(',');
    });

    const csv = [headers.join(','), ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="contacts_export_${Date.now()}.csv"`);
    return res.send(csv);
  } catch (error) {
    console.error('[Contacts][Export CSV]', { tenant_id: String(req.tenant?._id), error: error.message });
    return apiResponse(res, { status: 500, success: false, error: 'Export failed' });
  }
});

/* ── SUBSCRIPTION UPDATE (bulk) ────────────────────────── */
router.post('/subscription', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { contact_ids, status } = req.body;
    if (!Array.isArray(contact_ids) || !contact_ids.length) {
      return apiResponse(res, { status: 400, success: false, error: 'contact_ids array required' });
    }
    if (!['subscribed', 'unsubscribed', 'pending'].includes(status)) {
      return apiResponse(res, { status: 400, success: false, error: 'Invalid status' });
    }

    const updates = { subscription_status: status, opt_in: status === 'subscribed' };
    if (status === 'unsubscribed') {
      updates.unsubscribed_at = new Date();
      if (req.body.reason) updates.unsubscribe_reason = req.body.reason;
    } else if (status === 'subscribed') {
      updates.subscribed_at = new Date();
      updates.unsubscribe_reason = '';
    }

    const result = await Contact.updateMany(
      { _id: { $in: contact_ids }, tenant_id: req.tenant._id },
      updates,
    );
    return apiResponse(res, { data: { modified: result.modifiedCount } });
  } catch (error) {
    console.error('[Contacts][Subscription]', { error: error.message });
    return apiResponse(res, { status: 500, success: false, error: 'Failed to update subscription' });
  }
});

/* ── Get contact lists this contact belongs to ── */
router.get('/:id/lists', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const ContactList = require('../models/ContactList');
    const lists = await ContactList.find({
      tenant_id: req.tenant._id,
      contacts: req.params.id,
    }).select('_id name color contact_count').lean();
    return apiResponse(res, { data: { lists } });
  } catch (error) {
    console.error('[Contacts][Lists]', { error: error.message });
    return apiResponse(res, { status: 500, success: false, error: 'Failed to fetch contact lists' });
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

router.post('/maintenance/normalize-phones', authenticate, requireStatus('active'), async (req, res) => {
  try {
    await Contact.deleteMany({ tenant_id: req.tenant._id, phone: '918155883039' });
    const defaultCountryCode = String(req.body?.default_country_code || process.env.DEFAULT_COUNTRY_CODE || '91');
    const cursor = Contact.find({ tenant_id: req.tenant._id }).cursor();
    let scanned = 0;
    let updated = 0;
    let skipped = 0;

    for await (const contact of cursor) {
      scanned += 1;
      const parsedPhone = parsePhoneInput({
        phone: contact.phone || contact.whatsapp_id,
        country_code: contact.country_code,
        phone_number: contact.phone_number,
        default_country_code: defaultCountryCode,
      });

      if (!parsedPhone.ok) {
        skipped += 1;
        continue;
      }

      const changed =
        String(contact.phone || '') !== parsedPhone.phone ||
        String(contact.country_code || '') !== parsedPhone.country_code ||
        String(contact.phone_number || '') !== parsedPhone.phone_number ||
        String(contact.whatsapp_id || '') !== parsedPhone.phone;

      if (!changed) continue;

      contact.phone = parsedPhone.phone;
      contact.country_code = parsedPhone.country_code;
      contact.phone_number = parsedPhone.phone_number;
      contact.whatsapp_id = parsedPhone.phone;
      await contact.save();
      updated += 1;
    }

    return apiResponse(res, {
      data: {
        scanned,
        updated,
        skipped,
        default_country_code: defaultCountryCode,
      },
    });
  } catch (error) {
    console.error('[Contacts Route][Normalize Phones Failed]', {
      tenant_id: String(req.tenant?._id || ''),
      error: error.message,
    });
    return apiResponse(res, {
      status: 500,
      success: false,
      error: '[Platform] Failed to normalize contact phone data',
    });
  }
});

router.post('/maintenance/bulk-country-code', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const phones = Array.isArray(req.body?.phones)
      ? req.body.phones.map((item) => String(item || '').replace(/[^\d]/g, '')).filter(Boolean)
      : [];
    const defaultCountryCode = String(req.body?.default_country_code || process.env.DEFAULT_COUNTRY_CODE || '91');
    const overrides = req.body?.overrides && typeof req.body.overrides === 'object' ? req.body.overrides : {};

    if (!phones.length) {
      return apiResponse(res, { status: 400, success: false, error: '[Platform] phones array required' });
    }

    const contacts = await Contact.find({ tenant_id: req.tenant._id, phone: { $in: phones } });
    let updated = 0;
    let skipped = 0;
    const results = [];

    for (const contact of contacts) {
      const phone = String(contact.phone || '').replace(/[^\d]/g, '');
      const overrideCountryCode = String(overrides?.[phone] || '').replace(/[^\d]/g, '');
      const desiredCountryCode = overrideCountryCode || defaultCountryCode;
      const parsed = parsePhoneInput({
        phone: contact.phone || contact.whatsapp_id,
        country_code: desiredCountryCode,
        phone_number: contact.phone_number,
        default_country_code: desiredCountryCode,
      });

      if (!parsed.ok) {
        skipped += 1;
        results.push({ phone, status: 'skipped', reason: parsed.error });
        continue;
      }

      const changed =
        String(contact.phone || '') !== parsed.phone ||
        String(contact.country_code || '') !== parsed.country_code ||
        String(contact.phone_number || '') !== parsed.phone_number ||
        String(contact.whatsapp_id || '') !== parsed.phone;

      if (!changed) {
        results.push({ phone, status: 'unchanged', reason: null });
        continue;
      }

      contact.phone = parsed.phone;
      contact.country_code = parsed.country_code;
      contact.phone_number = parsed.phone_number;
      contact.whatsapp_id = parsed.phone;
      await contact.save();
      updated += 1;
      results.push({ phone: parsed.phone, status: 'updated', reason: null });
    }

    return apiResponse(res, {
      data: {
        updated,
        skipped,
        scanned: contacts.length,
        results,
      },
    });
  } catch (error) {
    console.error('[Contacts Route][Bulk Country Code Failed]', {
      tenant_id: String(req.tenant?._id || ''),
      error: error.message,
    });
    return apiResponse(res, {
      status: 500,
      success: false,
      error: '[Platform] Failed to apply bulk country code',
    });
  }
});

router.post('/', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { phone, country_code, phone_number, name, email, labels, notes, custom_fields } = req.body || {};
    const parsedPhone = parsePhoneInput({ phone, country_code, phone_number });

    if (!parsedPhone.ok) {
      return apiResponse(res, { status: 400, success: false, error: `[Platform] ${parsedPhone.error}` });
    }

    const existing = await Contact.findOne(contactLookupQuery(req.tenant._id, parsedPhone.phone));
    if (existing) {
      return apiResponse(res, { status: 409, success: false, error: '[Platform] Contact already exists' });
    }

    const normalizedLabels = normalizeTags(labels);
    const contact = await Contact.create({
      tenant_id: req.tenant._id,
      phone: parsedPhone.phone,
      country_code: parsedPhone.country_code,
      phone_number: parsedPhone.phone_number,
      whatsapp_id: parsedPhone.phone,
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

    if (payload.phone !== undefined || payload.phone_number !== undefined || payload.country_code !== undefined) {
      const parsedPhone = parsePhoneInput({
        phone: payload.phone,
        country_code: payload.country_code,
        phone_number: payload.phone_number,
      });
      if (!parsedPhone.ok) {
        return apiResponse(res, { status: 400, success: false, error: `[Platform] ${parsedPhone.error}` });
      }
      payload.phone = parsedPhone.phone;
      payload.country_code = parsedPhone.country_code;
      payload.phone_number = parsedPhone.phone_number;
      payload.whatsapp_id = parsedPhone.phone;
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

    const wa = await WhatsAppAccount.findOne({ tenant_id: req.tenant._id, is_default: true })
      || await WhatsAppAccount.findOne({ tenant_id: req.tenant._id });
    if (!wa) {
      return apiResponse(res, { status: 404, success: false, error: 'No WhatsApp account' });
    }

    const results = [];
    for (const phone of phones.slice(0, 20)) {
      const parsedPhone = parsePhoneInput({ phone });
      if (!parsedPhone.ok) {
        results.push({ phone: String(phone || ''), status: 'error', error: parsedPhone.error });
        continue;
      }
      try {
        await Contact.findOneAndUpdate(
          contactLookupQuery(req.tenant._id, parsedPhone.phone),
          {
            $set: {
              last_checked_at: new Date(),
              phone: parsedPhone.phone,
              country_code: parsedPhone.country_code,
              phone_number: parsedPhone.phone_number,
              whatsapp_id: parsedPhone.phone,
            },
          },
          { upsert: false }
        );
        results.push({ phone: parsedPhone.phone, status: 'pending_verification' });
      } catch (error) {
        results.push({ phone: parsedPhone.phone, status: 'error', error: error.message });
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

    const autoCreateFields = req.body.auto_create_fields === true;
    const unmappedColumns = Array.isArray(req.body.unmapped_columns) ? req.body.unmapped_columns : [];
    const autoCreatedFields = [];

    if (autoCreateFields && unmappedColumns.length) {
      const existingDefs = await CustomFieldDefinition.find({ tenant_id: req.tenant._id }).lean();
      const existingNames = new Set(existingDefs.map((d) => d.field_name));

      for (const column of unmappedColumns) {
        const fieldName = String(column || '')
          .trim()
          .toLowerCase()
          .replace(/\s+/g, '_')
          .replace(/[^a-z0-9_]/g, '');
        if (!fieldName || existingNames.has(fieldName)) continue;

        await CustomFieldDefinition.create({
          tenant_id: req.tenant._id,
          field_name: fieldName,
          field_label: String(column || '').trim(),
          field_type: 'text',
          is_required: false,
          created_by: req.user?._id || null,
        });
        existingNames.add(fieldName);
        autoCreatedFields.push({ field_name: fieldName, field_label: String(column || '').trim() });
      }
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;
    const results = [];
    const seenPhones = new Set();

    for (const [index, row] of rows.entries()) {
      const rowNumber = parsePositiveInt(row?.row_number, index + 2);
      const parsedPhone = parsePhoneInput({
        phone: row?.phone,
        country_code: row?.country_code,
        phone_number: row?.phone_number,
      });
      if (!parsedPhone.ok) {
        skipped += 1;
        results.push({
          row_number: rowNumber,
          phone: '',
          name: String(row?.name || '').trim(),
          status: 'skipped',
          reason: parsedPhone.error,
        });
        continue;
      }

      if (seenPhones.has(parsedPhone.phone)) {
        skipped += 1;
        results.push({
          row_number: rowNumber,
          phone: parsedPhone.phone,
          name: String(row?.name || '').trim(),
          status: 'skipped',
          reason: 'Duplicate phone found in the uploaded file',
        });
        continue;
      }
      seenPhones.add(parsedPhone.phone);

      const normalizedLabels = normalizeTags(row?.labels);
      const payload = {
        phone: parsedPhone.phone,
        country_code: parsedPhone.country_code,
        phone_number: parsedPhone.phone_number,
        whatsapp_id: parsedPhone.phone,
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
        const existing = await Contact.findOne(contactLookupQuery(req.tenant._id, parsedPhone.phone))
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
            phone: parsedPhone.phone,
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
            phone: parsedPhone.phone,
            name: String(row?.name || '').trim(),
            status: 'created',
            reason: null,
          });
        }
      } catch (error) {
        console.warn('[Contacts Route][Import Row Skipped]', {
          tenant_id: String(req.tenant?._id || ''),
          phone: parsedPhone.phone,
          row_number: rowNumber,
          error: error.message,
        });
        skipped += 1;
        results.push({
          row_number: rowNumber,
          phone: parsedPhone.phone,
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
        auto_created_fields: autoCreatedFields,
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
