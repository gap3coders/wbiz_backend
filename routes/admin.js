const express = require('express');
const { authenticateAdmin, requireAdminRole } = require('../middleware/adminAuth');
const { apiResponse } = require('../utils/helpers');
const AdminUser = require('../models/AdminUser');
const User = require('../models/User');
const Tenant = require('../models/Tenant');
const Plan = require('../models/Plan');
const EmailTemplate = require('../models/EmailTemplate');
const Message = require('../models/Message');
const Campaign = require('../models/Campaign');
const Contact = require('../models/Contact');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const AuditLog = require('../models/AuditLog');
const Notification = require('../models/Notification');

const router = express.Router();
router.use(authenticateAdmin);

/* ══════════════════════════════════════════════════════
   DASHBOARD STATS
   ══════════════════════════════════════════════════════ */
router.get('/dashboard/stats', async (req, res) => {
  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

    const [
      totalTenants, activeTenants, totalUsers, activeUsers,
      totalMessages, messagesThisMonth,
      totalCampaigns, campaignsThisMonth,
      totalContacts,
      recentTenants, recentSignups,
    ] = await Promise.all([
      Tenant.countDocuments(),
      Tenant.countDocuments({ plan_status: { $in: ['active', 'trial'] } }),
      User.countDocuments(),
      User.countDocuments({ status: 'active' }),
      Message.countDocuments(),
      Message.countDocuments({ created_at: { $gte: thirtyDaysAgo } }),
      Campaign.countDocuments(),
      Campaign.countDocuments({ created_at: { $gte: thirtyDaysAgo } }),
      Contact.countDocuments(),
      Tenant.find().sort({ created_at: -1 }).limit(5).lean(),
      User.find().sort({ created_at: -1 }).limit(5).select('-password_hash').lean(),
    ]);

    // Revenue estimate (simple: active tenants * avg plan price)
    const plans = await Plan.find({ is_active: true }).lean();
    const tenantsByPlan = await Tenant.aggregate([
      { $match: { plan_status: { $in: ['active', 'trial'] } } },
      { $group: { _id: '$plan', count: { $sum: 1 } } },
    ]);
    let monthlyRevenue = 0;
    tenantsByPlan.forEach(g => {
      const plan = plans.find(p => p.slug === g._id);
      if (plan) monthlyRevenue += plan.price_monthly * g.count;
    });

    // Messages per day (last 7 days)
    const msgsByDay = await Message.aggregate([
      { $match: { created_at: { $gte: sevenDaysAgo } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$created_at' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

    return apiResponse(res, {
      data: {
        stats: {
          totalTenants, activeTenants, totalUsers, activeUsers,
          totalMessages, messagesThisMonth,
          totalCampaigns, campaignsThisMonth,
          totalContacts, monthlyRevenue,
        },
        charts: { messagesByDay: msgsByDay },
        recentTenants,
        recentSignups,
        tenantsByPlan,
      },
    });
  } catch (error) {
    console.error('[Admin][Dashboard]', error.message);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to load dashboard' });
  }
});

/* ══════════════════════════════════════════════════════
   TENANTS
   ══════════════════════════════════════════════════════ */
router.get('/tenants', async (req, res) => {
  try {
    const { search, plan, status, page = 1, limit = 20 } = req.query;
    const query = {};
    if (search) query.$or = [
      { name: { $regex: search, $options: 'i' } },
      { slug: { $regex: search, $options: 'i' } },
    ];
    if (plan) query.plan = plan;
    if (status) query.plan_status = status;
    const skip = (Math.max(1, +page) - 1) * (+limit || 20);
    const [tenants, total] = await Promise.all([
      Tenant.find(query).sort({ created_at: -1 }).skip(skip).limit(+limit || 20).lean(),
      Tenant.countDocuments(query),
    ]);

    // Enrich with owner info and stats
    const enriched = await Promise.all(tenants.map(async (t) => {
      const owner = t.owner_user_id ? await User.findById(t.owner_user_id).select('full_name email phone').lean() : null;
      const userCount = await User.countDocuments({ tenant_id: t._id });
      const contactCount = await Contact.countDocuments({ tenant_id: t._id });
      const messageCount = await Message.countDocuments({ tenant_id: t._id });
      return { ...t, owner, _stats: { users: userCount, contacts: contactCount, messages: messageCount } };
    }));

    return apiResponse(res, { data: { tenants: enriched, pagination: { total, page: +page, pages: Math.ceil(total / (+limit || 20)) } } });
  } catch (error) {
    console.error('[Admin][Tenants]', error.message);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to fetch tenants' });
  }
});

router.get('/tenants/:id', async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.id).lean();
    if (!tenant) return apiResponse(res, { status: 404, success: false, error: 'Tenant not found' });
    const owner = tenant.owner_user_id ? await User.findById(tenant.owner_user_id).select('-password_hash').lean() : null;
    const users = await User.find({ tenant_id: tenant._id }).select('-password_hash').lean();
    const waAccount = await WhatsAppAccount.findOne({ tenant_id: tenant._id }).select('-access_token_encrypted').lean();
    const contactCount = await Contact.countDocuments({ tenant_id: tenant._id });
    const messageCount = await Message.countDocuments({ tenant_id: tenant._id });
    const campaignCount = await Campaign.countDocuments({ tenant_id: tenant._id });
    return apiResponse(res, { data: { tenant, owner, users, waAccount, stats: { contacts: contactCount, messages: messageCount, campaigns: campaignCount } } });
  } catch (error) {
    console.error('[Admin][Tenant]', error.message);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to fetch tenant' });
  }
});

router.patch('/tenants/:id', async (req, res) => {
  try {
    const { plan, plan_status, message_limit_monthly, seats_limit, name } = req.body;
    const updates = {};
    if (plan) updates.plan = plan;
    if (plan_status) updates.plan_status = plan_status;
    if (message_limit_monthly !== undefined) updates.message_limit_monthly = message_limit_monthly;
    if (seats_limit !== undefined) updates.seats_limit = seats_limit;
    if (name) updates.name = name;

    const tenant = await Tenant.findByIdAndUpdate(req.params.id, updates, { new: true }).lean();
    if (!tenant) return apiResponse(res, { status: 404, success: false, error: 'Tenant not found' });

    // If suspending, also suspend all users in tenant
    if (plan_status === 'suspended') {
      await User.updateMany({ tenant_id: tenant._id }, { status: 'suspended' });
    }
    if (plan_status === 'active') {
      await User.updateMany({ tenant_id: tenant._id, status: 'suspended' }, { status: 'active' });
    }

    return apiResponse(res, { data: { tenant } });
  } catch (error) {
    console.error('[Admin][Tenant Update]', error.message);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to update tenant' });
  }
});

/* ══════════════════════════════════════════════════════
   USERS (Portal Users)
   ══════════════════════════════════════════════════════ */
router.get('/users', async (req, res) => {
  try {
    const { search, status, role, page = 1, limit = 20 } = req.query;
    const query = {};
    if (search) query.$or = [
      { full_name: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
    ];
    if (status) query.status = status;
    if (role) query.role = role;
    const skip = (Math.max(1, +page) - 1) * (+limit || 20);
    const [users, total] = await Promise.all([
      User.find(query).select('-password_hash').sort({ created_at: -1 }).skip(skip).limit(+limit || 20).lean(),
      User.countDocuments(query),
    ]);
    // Enrich with tenant name
    const tenantIds = [...new Set(users.filter(u => u.tenant_id).map(u => String(u.tenant_id)))];
    const tenants = await Tenant.find({ _id: { $in: tenantIds } }).lean();
    const tenantMap = Object.fromEntries(tenants.map(t => [String(t._id), t]));
    const enriched = users.map(u => ({ ...u, tenant: u.tenant_id ? tenantMap[String(u.tenant_id)] || null : null }));

    return apiResponse(res, { data: { users: enriched, pagination: { total, page: +page, pages: Math.ceil(total / (+limit || 20)) } } });
  } catch (error) {
    console.error('[Admin][Users]', error.message);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to fetch users' });
  }
});

router.get('/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password_hash').lean();
    if (!user) return apiResponse(res, { status: 404, success: false, error: 'User not found' });
    const tenant = user.tenant_id ? await Tenant.findById(user.tenant_id).lean() : null;
    return apiResponse(res, { data: { ...user, tenant } });
  } catch (error) {
    console.error('[Admin][User Detail]', error.message);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to fetch user details' });
  }
});

router.patch('/users/:id', async (req, res) => {
  try {
    const { status, role } = req.body;
    const updates = {};
    if (status) updates.status = status;
    if (role) updates.role = role;
    const user = await User.findByIdAndUpdate(req.params.id, updates, { new: true }).select('-password_hash').lean();
    if (!user) return apiResponse(res, { status: 404, success: false, error: 'User not found' });
    return apiResponse(res, { data: { user } });
  } catch (error) {
    console.error('[Admin][User Update]', error.message);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to update user' });
  }
});

/* ══════════════════════════════════════════════════════
   PLANS
   ══════════════════════════════════════════════════════ */
router.get('/plans', async (req, res) => {
  try {
    const plans = await Plan.find().sort({ sort_order: 1 }).lean();
    // Count tenants per plan
    const counts = await Tenant.aggregate([{ $group: { _id: '$plan', count: { $sum: 1 } } }]);
    const countMap = Object.fromEntries(counts.map(c => [c._id, c.count]));
    const enriched = plans.map(p => ({ ...p, tenant_count: countMap[p.slug] || 0 }));
    return apiResponse(res, { data: { plans: enriched } });
  } catch (error) {
    console.error('[Admin][Plans]', error.message);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to fetch plans' });
  }
});

router.post('/plans', requireAdminRole('super_admin'), async (req, res) => {
  try {
    const plan = await Plan.create(req.body);
    return apiResponse(res, { status: 201, data: { plan } });
  } catch (error) {
    console.error('[Admin][Plan Create]', error.message);
    return apiResponse(res, { status: 500, success: false, error: error.code === 11000 ? 'Plan slug already exists' : 'Failed to create plan' });
  }
});

router.put('/plans/:id', requireAdminRole('super_admin'), async (req, res) => {
  try {
    const plan = await Plan.findByIdAndUpdate(req.params.id, req.body, { new: true }).lean();
    if (!plan) return apiResponse(res, { status: 404, success: false, error: 'Plan not found' });
    return apiResponse(res, { data: { plan } });
  } catch (error) {
    console.error('[Admin][Plan Update]', error.message);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to update plan' });
  }
});

router.delete('/plans/:id', requireAdminRole('super_admin'), async (req, res) => {
  try {
    const plan = await Plan.findById(req.params.id);
    if (!plan) return apiResponse(res, { status: 404, success: false, error: 'Plan not found' });
    // Check if tenants use this plan
    const used = await Tenant.countDocuments({ plan: plan.slug });
    if (used > 0) return apiResponse(res, { status: 400, success: false, error: `Cannot delete: ${used} tenant(s) on this plan` });
    await Plan.findByIdAndDelete(req.params.id);
    return apiResponse(res, { data: { message: 'Plan deleted' } });
  } catch (error) {
    console.error('[Admin][Plan Delete]', error.message);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to delete plan' });
  }
});

/* ══════════════════════════════════════════════════════
   EMAIL TEMPLATES
   ══════════════════════════════════════════════════════ */
router.get('/email-templates', async (req, res) => {
  try {
    const { category } = req.query;
    const query = {};
    if (category) query.category = category;
    const templates = await EmailTemplate.find(query).sort({ category: 1, name: 1 }).lean();
    return apiResponse(res, { data: { templates } });
  } catch (error) {
    console.error('[Admin][EmailTemplates]', error.message);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to fetch templates' });
  }
});

router.get('/email-templates/:id', async (req, res) => {
  try {
    const tpl = await EmailTemplate.findById(req.params.id).lean();
    if (!tpl) return apiResponse(res, { status: 404, success: false, error: 'Template not found' });
    return apiResponse(res, { data: { template: tpl } });
  } catch (error) {
    console.error('[Admin][EmailTemplate]', error.message);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to fetch template' });
  }
});

router.put('/email-templates/:id', async (req, res) => {
  try {
    const { name, subject, html_body, description, variables, active, category } = req.body;
    const updates = {};
    if (name) updates.name = name;
    if (subject) updates.subject = subject;
    if (html_body) updates.html_body = html_body;
    if (description !== undefined) updates.description = description;
    if (variables) updates.variables = variables;
    if (active !== undefined) updates.active = active;
    if (category) updates.category = category;
    updates.updated_by = req.admin._id;

    const tpl = await EmailTemplate.findByIdAndUpdate(req.params.id, updates, { new: true }).lean();
    if (!tpl) return apiResponse(res, { status: 404, success: false, error: 'Template not found' });
    return apiResponse(res, { data: { template: tpl } });
  } catch (error) {
    console.error('[Admin][EmailTemplate Update]', error.message);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to update template' });
  }
});

router.post('/email-templates', async (req, res) => {
  try {
    const tpl = await EmailTemplate.create({ ...req.body, updated_by: req.admin._id });
    return apiResponse(res, { status: 201, data: { template: tpl } });
  } catch (error) {
    console.error('[Admin][EmailTemplate Create]', error.message);
    return apiResponse(res, { status: 500, success: false, error: error.code === 11000 ? 'Template slug already exists' : 'Failed to create template' });
  }
});

router.delete('/email-templates/:id', requireAdminRole('super_admin'), async (req, res) => {
  try {
    await EmailTemplate.findByIdAndDelete(req.params.id);
    return apiResponse(res, { data: { message: 'Template deleted' } });
  } catch (error) {
    console.error('[Admin][EmailTemplate Delete]', error.message);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to delete template' });
  }
});

/* POST /email-templates/:id/preview — render with sample data */
router.post('/email-templates/:id/preview', async (req, res) => {
  try {
    const tpl = await EmailTemplate.findById(req.params.id).lean();
    if (!tpl) return apiResponse(res, { status: 404, success: false, error: 'Template not found' });
    let html = tpl.html_body;
    // Replace variables with sample data
    const samples = req.body.variables || {};
    (tpl.variables || []).forEach(v => {
      html = html.replace(new RegExp(`\\{\\{${v}\\}\\}`, 'g'), samples[v] || `[${v}]`);
    });
    return apiResponse(res, { data: { html, subject: tpl.subject } });
  } catch (error) {
    console.error('[Admin][EmailPreview]', error.message);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to preview template' });
  }
});

/* ══════════════════════════════════════════════════════
   ADMIN USERS (manage other admins)
   ══════════════════════════════════════════════════════ */
router.get('/admin-users', requireAdminRole('super_admin'), async (req, res) => {
  try {
    const admins = await AdminUser.find().select('-password_hash').sort({ created_at: -1 }).lean();
    return apiResponse(res, { data: { admins } });
  } catch (error) {
    console.error('[Admin][AdminUsers]', error.message);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to fetch admin users' });
  }
});

router.post('/admin-users', requireAdminRole('super_admin'), async (req, res) => {
  try {
    const { email, password, full_name, role } = req.body;
    if (!email || !password || !full_name) {
      return apiResponse(res, { status: 400, success: false, error: 'Email, password and name are required' });
    }
    const admin = await AdminUser.create({
      email, password_hash: password, full_name, role: role || 'admin',
    });
    return apiResponse(res, { status: 201, data: { admin: admin.toSafeJSON() } });
  } catch (error) {
    console.error('[Admin][AdminUser Create]', error.message);
    return apiResponse(res, { status: 500, success: false, error: error.code === 11000 ? 'Email already exists' : 'Failed to create admin' });
  }
});

router.patch('/admin-users/:id', requireAdminRole('super_admin'), async (req, res) => {
  try {
    const { status, role, full_name } = req.body;
    const updates = {};
    if (status) updates.status = status;
    if (role) updates.role = role;
    if (full_name) updates.full_name = full_name;
    const admin = await AdminUser.findByIdAndUpdate(req.params.id, updates, { new: true }).select('-password_hash').lean();
    if (!admin) return apiResponse(res, { status: 404, success: false, error: 'Admin not found' });
    return apiResponse(res, { data: { admin } });
  } catch (error) {
    console.error('[Admin][AdminUser Update]', error.message);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to update admin' });
  }
});

/* ══════════════════════════════════════════════════════
   AUDIT LOGS (global)
   ══════════════════════════════════════════════════════ */
router.get('/audit-logs', async (req, res) => {
  try {
    const { tenant_id, action, page = 1, limit = 50 } = req.query;
    const query = {};
    if (tenant_id) query.tenant_id = tenant_id;
    if (action) query.action = { $regex: action, $options: 'i' };
    const skip = (Math.max(1, +page) - 1) * (+limit || 50);
    const [logs, total] = await Promise.all([
      AuditLog.find(query).sort({ created_at: -1 }).skip(skip).limit(+limit || 50).lean(),
      AuditLog.countDocuments(query),
    ]);
    return apiResponse(res, { data: { logs, pagination: { total, page: +page, pages: Math.ceil(total / (+limit || 50)) } } });
  } catch (error) {
    console.error('[Admin][AuditLogs]', error.message);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to fetch audit logs' });
  }
});

/* ══════════════════════════════════════════════════════
   SYSTEM INFO
   ══════════════════════════════════════════════════════ */
router.get('/system/info', async (req, res) => {
  try {
    const mongoose = require('mongoose');
    return apiResponse(res, {
      data: {
        node_version: process.version,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        mongodb_status: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        env: process.env.NODE_ENV || 'development',
      },
    });
  } catch (error) {
    return apiResponse(res, { status: 500, success: false, error: 'Failed to get system info' });
  }
});

/* ══════════════════════════════════════════════════════
   USER APPROVAL WORKFLOW
   ══════════════════════════════════════════════════════ */
router.post('/users/:id/approve', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return apiResponse(res, { status: 404, success: false, error: 'User not found' });
    if (user.status !== 'pending_approval') {
      return apiResponse(res, { status: 400, success: false, error: `User status is ${user.status}, not pending_approval` });
    }
    user.status = 'pending_plan';
    await user.save();
    // TODO: send approval email to user
    return apiResponse(res, { data: { message: 'User approved', user: user.toSafeJSON() } });
  } catch (error) {
    console.error('[Admin][ApproveUser]', error.message);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to approve user' });
  }
});

router.post('/users/:id/reject', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return apiResponse(res, { status: 404, success: false, error: 'User not found' });
    user.status = 'suspended';
    await user.save();
    return apiResponse(res, { data: { message: 'User rejected', user: user.toSafeJSON() } });
  } catch (error) {
    console.error('[Admin][RejectUser]', error.message);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to reject user' });
  }
});

/* ══════════════════════════════════════════════════════
   TENANT LIFETIME ACCESS & TRIAL EXTENSION
   ══════════════════════════════════════════════════════ */
router.post('/tenants/:id/grant-lifetime', requireAdminRole('super_admin'), async (req, res) => {
  try {
    const tenant = await Tenant.findByIdAndUpdate(req.params.id, {
      plan_status: 'lifetime',
      lifetime_access: true,
      granted_by_admin: req.admin._id,
    }, { new: true }).lean();
    if (!tenant) return apiResponse(res, { status: 404, success: false, error: 'Tenant not found' });
    return apiResponse(res, { data: { message: 'Lifetime access granted', tenant } });
  } catch (error) {
    return apiResponse(res, { status: 500, success: false, error: 'Failed to grant lifetime access' });
  }
});

router.post('/tenants/:id/extend-trial', async (req, res) => {
  try {
    const { days = 7 } = req.body;
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) return apiResponse(res, { status: 404, success: false, error: 'Tenant not found' });
    const newEnd = new Date(Math.max(Date.now(), tenant.trial_ends_at?.getTime() || Date.now()) + days * 24 * 60 * 60 * 1000);
    tenant.trial_ends_at = newEnd;
    tenant.plan_status = 'trial';
    await tenant.save();
    return apiResponse(res, { data: { message: `Trial extended by ${days} days`, trial_ends_at: newEnd } });
  } catch (error) {
    return apiResponse(res, { status: 500, success: false, error: 'Failed to extend trial' });
  }
});

/* ══════════════════════════════════════════════════════
   SYSTEM CONFIG (Razorpay keys etc)
   ══════════════════════════════════════════════════════ */
router.get('/system/config', requireAdminRole('super_admin'), async (req, res) => {
  try {
    const SystemConfig = require('../models/SystemConfig');
    const configs = await SystemConfig.find().lean();
    // Mask secret values
    const masked = configs.map(c => ({
      ...c,
      value: c.is_secret && c.value ? '••••••••' : c.value,
    }));
    return apiResponse(res, { data: { configs: masked } });
  } catch (error) {
    return apiResponse(res, { status: 500, success: false, error: 'Failed to fetch config' });
  }
});

router.put('/system/config', requireAdminRole('super_admin'), async (req, res) => {
  try {
    const SystemConfig = require('../models/SystemConfig');
    const { configs } = req.body; // Array of { key, value }
    if (!Array.isArray(configs)) return apiResponse(res, { status: 400, success: false, error: 'configs must be an array' });
    for (const { key, value } of configs) {
      if (key && value !== undefined && value !== '••••••••') {
        await SystemConfig.setValue(key, value);
      }
    }
    return apiResponse(res, { data: { message: 'Config updated' } });
  } catch (error) {
    return apiResponse(res, { status: 500, success: false, error: 'Failed to update config' });
  }
});

/* ══════════════════════════════════════════════════════
   TENANT ACTIONS — SUSPEND / REACTIVATE / SEND EMAIL
   ══════════════════════════════════════════════════════ */
router.post('/tenants/:id/suspend', async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) return apiResponse(res, { status: 404, success: false, error: 'Tenant not found' });
    if (tenant.plan_status === 'suspended') return apiResponse(res, { status: 400, success: false, error: 'Already suspended' });
    tenant.plan_status = 'suspended';
    await tenant.save();
    // Suspend all tenant users
    await User.updateMany({ tenant_id: tenant._id, status: 'active' }, { $set: { status: 'suspended' } });
    return apiResponse(res, { data: { message: 'Tenant suspended', tenant } });
  } catch (error) {
    console.error('[Admin][Tenant Suspend]', { error: error.message });
    return apiResponse(res, { status: 500, success: false, error: 'Failed to suspend tenant' });
  }
});

router.post('/tenants/:id/reactivate', async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) return apiResponse(res, { status: 404, success: false, error: 'Tenant not found' });
    tenant.plan_status = 'active';
    await tenant.save();
    // Reactivate owner user
    await User.updateMany({ tenant_id: tenant._id, status: 'suspended' }, { $set: { status: 'active' } });
    return apiResponse(res, { data: { message: 'Tenant reactivated', tenant } });
  } catch (error) {
    console.error('[Admin][Tenant Reactivate]', { error: error.message });
    return apiResponse(res, { status: 500, success: false, error: 'Failed to reactivate tenant' });
  }
});

router.post('/tenants/:id/send-notification', async (req, res) => {
  try {
    const { subject, message } = req.body || {};
    if (!subject || !message) return apiResponse(res, { status: 400, success: false, error: 'Subject and message required' });
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) return apiResponse(res, { status: 404, success: false, error: 'Tenant not found' });
    const owner = await User.findOne({ tenant_id: tenant._id, role: 'owner' }).select('email full_name').lean();
    if (!owner?.email) return apiResponse(res, { status: 400, success: false, error: 'No owner email found' });

    // Try to send via emailService
    try {
      const emailService = require('../services/emailService');
      await emailService.sendMail({
        to: owner.email,
        subject,
        html: `<div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
          <h2 style="color:#1e293b;margin-bottom:16px;">${subject}</h2>
          <div style="color:#475569;line-height:1.8;white-space:pre-wrap;">${message}</div>
          <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;" />
          <p style="color:#94a3b8;font-size:12px;">This email was sent by WBIZ.IN Admin</p>
        </div>`,
      });
    } catch (emailErr) {
      console.warn('[Admin][Send Notification] Email service failed:', emailErr.message);
    }

    // Also create in-app notification
    await Notification.create({
      tenant_id: tenant._id,
      type: 'system_alert',
      title: subject,
      message: message.substring(0, 500),
      source: 'platform',
      severity: 'info',
    });

    return apiResponse(res, { data: { message: 'Notification sent', email: owner.email } });
  } catch (error) {
    console.error('[Admin][Send Notification]', { error: error.message });
    return apiResponse(res, { status: 500, success: false, error: 'Failed to send notification' });
  }
});

/* ══════════════════════════════════════════════════════
   USER ACTIONS — SUSPEND / REACTIVATE / UNLOCK / RESET PW
   ══════════════════════════════════════════════════════ */
router.post('/users/:id/suspend', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return apiResponse(res, { status: 404, success: false, error: 'User not found' });
    user.status = 'suspended';
    await user.save();
    return apiResponse(res, { data: { message: 'User suspended' } });
  } catch (error) {
    console.error('[Admin][User Suspend]', { error: error.message });
    return apiResponse(res, { status: 500, success: false, error: 'Failed' });
  }
});

router.post('/users/:id/reactivate', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return apiResponse(res, { status: 404, success: false, error: 'User not found' });
    user.status = 'active';
    await user.save();
    return apiResponse(res, { data: { message: 'User reactivated' } });
  } catch (error) {
    console.error('[Admin][User Reactivate]', { error: error.message });
    return apiResponse(res, { status: 500, success: false, error: 'Failed' });
  }
});

router.post('/users/:id/unlock', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return apiResponse(res, { status: 404, success: false, error: 'User not found' });
    user.login_attempts = 0;
    user.locked_until = null;
    await user.save();
    return apiResponse(res, { data: { message: 'Account unlocked' } });
  } catch (error) {
    console.error('[Admin][User Unlock]', { error: error.message });
    return apiResponse(res, { status: 500, success: false, error: 'Failed' });
  }
});

router.post('/users/:id/reset-password', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('email full_name').lean();
    if (!user) return apiResponse(res, { status: 404, success: false, error: 'User not found' });

    // Generate a password reset token and send email
    const crypto = require('crypto');
    const EmailVerification = require('../models/EmailVerification');
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await EmailVerification.create({
      user_id: user._id,
      token_hash: tokenHash,
      type: 'password_reset',
      expires_at: new Date(Date.now() + 3600000), // 1 hour
    });

    try {
      const emailService = require('../services/emailService');
      const config = require('../config');
      const resetLink = `${config.frontendUrl}/reset-password?token=${token}`;
      await emailService.sendMail({
        to: user.email,
        subject: 'Password Reset — WBIZ.IN',
        html: `<div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
          <h2 style="color:#1e293b;">Password Reset Request</h2>
          <p style="color:#475569;">An admin has requested a password reset for your account.</p>
          <a href="${resetLink}" style="display:inline-block;background:#25D366;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0;">Reset Password</a>
          <p style="color:#94a3b8;font-size:12px;margin-top:16px;">This link expires in 1 hour.</p>
        </div>`,
      });
    } catch (emailErr) {
      console.warn('[Admin][Reset Password] Email send failed:', emailErr.message);
    }

    return apiResponse(res, { data: { message: 'Password reset email sent', email: user.email } });
  } catch (error) {
    console.error('[Admin][Reset Password]', { error: error.message });
    return apiResponse(res, { status: 500, success: false, error: 'Failed' });
  }
});

module.exports = router;
