const express = require('express');
const { authenticate, requireStatus } = require('../middleware/auth');
const ContactList = require('../models/ContactList');
const Contact = require('../models/Contact');
const { apiResponse } = require('../utils/helpers');

const router = express.Router();

const parsePositiveInt = (v, fb) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fb;
};

/* ── LIST ─────────────────────────────────────────────── */
router.get('/', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const page = parsePositiveInt(req.query.page, 1);
    const limit = Math.min(parsePositiveInt(req.query.limit, 50), 100);
    const filter = { tenant_id: req.tenant._id };

    if (req.query.search) {
      const regex = new RegExp(req.query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: regex }, { description: regex }];
    }

    const total = await ContactList.countDocuments(filter);
    const items = await ContactList.find(filter)
      .sort({ created_at: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    return apiResponse(res, {
      data: { lists: items, total, page, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('[ContactLists][List]', { tenant_id: String(req.tenant?._id), error: error.message });
    return apiResponse(res, { status: 500, success: false, error: 'Failed to fetch contact lists' });
  }
});

/* ── GET ONE (with contacts populated) ────────────────── */
router.get('/:id', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const page = parsePositiveInt(req.query.page, 1);
    const limit = Math.min(parsePositiveInt(req.query.limit, 25), 100);

    const list = await ContactList.findOne({ _id: req.params.id, tenant_id: req.tenant._id }).lean();
    if (!list) return apiResponse(res, { status: 404, success: false, error: 'Contact list not found' });

    const contactIds = list.contacts || [];
    const totalContacts = contactIds.length;
    const pagedIds = contactIds.slice((page - 1) * limit, page * limit);
    const contacts = await Contact.find({ _id: { $in: pagedIds } }).lean();

    return apiResponse(res, {
      data: {
        list: { ...list, contacts: undefined },
        contacts,
        total_contacts: totalContacts,
        page,
        pages: Math.ceil(totalContacts / limit),
      },
    });
  } catch (error) {
    console.error('[ContactLists][Get]', { id: req.params.id, error: error.message });
    return apiResponse(res, { status: 500, success: false, error: 'Failed to fetch contact list' });
  }
});

/* ── CREATE ───────────────────────────────────────────── */
router.post('/', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { name, description, color, contact_ids } = req.body;
    if (!name) return apiResponse(res, { status: 400, success: false, error: 'Name is required' });

    // Validate contact IDs belong to tenant
    let validIds = [];
    if (Array.isArray(contact_ids) && contact_ids.length > 0) {
      const valid = await Contact.find({ _id: { $in: contact_ids }, tenant_id: req.tenant._id }).select('_id').lean();
      validIds = valid.map((c) => c._id);
    }

    const list = await ContactList.create({
      tenant_id: req.tenant._id,
      user_id: req.user._id,
      name: name.trim(),
      description: (description || '').trim(),
      color: color || '#25D366',
      contacts: validIds,
      contact_count: validIds.length,
    });

    return apiResponse(res, { status: 201, data: { list: list.toObject() } });
  } catch (error) {
    console.error('[ContactLists][Create]', { tenant_id: String(req.tenant?._id), error: error.message });
    return apiResponse(res, { status: 500, success: false, error: 'Failed to create contact list' });
  }
});

/* ── UPDATE ───────────────────────────────────────────── */
router.put('/:id', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const list = await ContactList.findOne({ _id: req.params.id, tenant_id: req.tenant._id });
    if (!list) return apiResponse(res, { status: 404, success: false, error: 'Contact list not found' });

    if (req.body.name !== undefined) list.name = req.body.name.trim();
    if (req.body.description !== undefined) list.description = req.body.description.trim();
    if (req.body.color !== undefined) list.color = req.body.color;

    await list.save();
    return apiResponse(res, { data: { list: list.toObject() } });
  } catch (error) {
    console.error('[ContactLists][Update]', { id: req.params.id, error: error.message });
    return apiResponse(res, { status: 500, success: false, error: 'Failed to update contact list' });
  }
});

/* ── ADD CONTACTS ─────────────────────────────────────── */
router.post('/:id/contacts', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { contact_ids } = req.body;
    if (!Array.isArray(contact_ids) || contact_ids.length === 0) {
      return apiResponse(res, { status: 400, success: false, error: 'contact_ids array is required' });
    }

    const valid = await Contact.find({ _id: { $in: contact_ids }, tenant_id: req.tenant._id }).select('_id').lean();
    const validIds = valid.map((c) => c._id);

    const list = await ContactList.findOneAndUpdate(
      { _id: req.params.id, tenant_id: req.tenant._id },
      { $addToSet: { contacts: { $each: validIds } } },
      { new: true },
    );

    if (!list) return apiResponse(res, { status: 404, success: false, error: 'Contact list not found' });

    list.contact_count = list.contacts.length;
    await list.save();

    return apiResponse(res, { data: { list: list.toObject(), added: validIds.length } });
  } catch (error) {
    console.error('[ContactLists][AddContacts]', { id: req.params.id, error: error.message });
    return apiResponse(res, { status: 500, success: false, error: 'Failed to add contacts' });
  }
});

/* ── REMOVE CONTACTS ──────────────────────────────────── */
router.delete('/:id/contacts', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { contact_ids } = req.body;
    if (!Array.isArray(contact_ids) || contact_ids.length === 0) {
      return apiResponse(res, { status: 400, success: false, error: 'contact_ids array is required' });
    }

    const list = await ContactList.findOneAndUpdate(
      { _id: req.params.id, tenant_id: req.tenant._id },
      { $pullAll: { contacts: contact_ids } },
      { new: true },
    );

    if (!list) return apiResponse(res, { status: 404, success: false, error: 'Contact list not found' });

    list.contact_count = list.contacts.length;
    await list.save();

    return apiResponse(res, { data: { list: list.toObject(), removed: contact_ids.length } });
  } catch (error) {
    console.error('[ContactLists][RemoveContacts]', { id: req.params.id, error: error.message });
    return apiResponse(res, { status: 500, success: false, error: 'Failed to remove contacts' });
  }
});

/* ── DELETE ────────────────────────────────────────────── */
router.delete('/:id', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const item = await ContactList.findOneAndDelete({ _id: req.params.id, tenant_id: req.tenant._id });
    if (!item) return apiResponse(res, { status: 404, success: false, error: 'Contact list not found' });
    return apiResponse(res, { data: { message: 'Deleted' } });
  } catch (error) {
    console.error('[ContactLists][Delete]', { id: req.params.id, error: error.message });
    return apiResponse(res, { status: 500, success: false, error: 'Failed to delete contact list' });
  }
});

module.exports = router;
