const express = require('express');
const { authenticate, requireStatus } = require('../middleware/auth');
const { apiResponse } = require('../utils/helpers');
const TeamMember = require('../models/TeamMember');
const crypto = require('crypto');
const router = express.Router();

// GET / — list team members for tenant
router.get('/', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const members = await TeamMember.find({ tenant_id: req.tenant._id })
      .sort({ created_at: -1 })
      .lean();
    return apiResponse(res, { data: { members } });
  } catch (error) {
    return apiResponse(res, { status: 500, success: false, error: 'Failed to fetch team members' });
  }
});

// POST /invite — invite a new team member
router.post('/invite', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { email, role } = req.body;
    if (!email || !role) {
      return apiResponse(res, { status: 400, success: false, error: 'Email and role are required' });
    }
    if (!['admin', 'agent', 'viewer'].includes(role)) {
      return apiResponse(res, { status: 400, success: false, error: 'Invalid role. Must be admin, agent, or viewer' });
    }

    // Check if already invited
    const existing = await TeamMember.findOne({ tenant_id: req.tenant._id, email: email.toLowerCase().trim() });
    if (existing) {
      if (existing.status === 'removed') {
        // Re-invite removed member
        existing.status = 'pending';
        existing.role = role;
        existing.invited_by = req.user._id;
        existing.invited_at = new Date();
        existing.accepted_at = undefined;
        const token = crypto.randomBytes(32).toString('hex');
        existing.invite_token_hash = crypto.createHash('sha256').update(token).digest('hex');
        existing.invite_expires_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await existing.save();
        return apiResponse(res, { status: 201, data: { member: existing } });
      }
      return apiResponse(res, { status: 400, success: false, error: 'This email has already been invited' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const member = await TeamMember.create({
      tenant_id: req.tenant._id,
      email: email.toLowerCase().trim(),
      role,
      invited_by: req.user._id,
      invited_at: new Date(),
      status: 'pending',
      invite_token_hash: crypto.createHash('sha256').update(token).digest('hex'),
      invite_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    return apiResponse(res, { status: 201, data: { member } });
  } catch (error) {
    if (error.code === 11000) {
      return apiResponse(res, { status: 400, success: false, error: 'This email has already been invited' });
    }
    return apiResponse(res, { status: 500, success: false, error: 'Failed to invite team member' });
  }
});

// PATCH /:id — update member role or status
router.patch('/:id', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const { role, status } = req.body;
    const update = {};
    if (role && ['admin', 'agent', 'viewer'].includes(role)) update.role = role;
    if (status && ['active', 'removed'].includes(status)) update.status = status;

    if (!Object.keys(update).length) {
      return apiResponse(res, { status: 400, success: false, error: 'No valid fields to update' });
    }

    const member = await TeamMember.findOneAndUpdate(
      { _id: req.params.id, tenant_id: req.tenant._id },
      { $set: update },
      { new: true }
    );
    if (!member) return apiResponse(res, { status: 404, success: false, error: 'Team member not found' });

    return apiResponse(res, { data: { member } });
  } catch (error) {
    return apiResponse(res, { status: 500, success: false, error: 'Failed to update team member' });
  }
});

// DELETE /:id — remove team member
router.delete('/:id', authenticate, requireStatus('active'), async (req, res) => {
  try {
    const member = await TeamMember.findOneAndUpdate(
      { _id: req.params.id, tenant_id: req.tenant._id },
      { $set: { status: 'removed' } },
      { new: true }
    );
    if (!member) return apiResponse(res, { status: 404, success: false, error: 'Team member not found' });
    return apiResponse(res, { data: { message: 'Team member removed' } });
  } catch (error) {
    return apiResponse(res, { status: 500, success: false, error: 'Failed to remove team member' });
  }
});

module.exports = router;
