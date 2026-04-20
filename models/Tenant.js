const mongoose = require('mongoose');

const tenantSchema = new mongoose.Schema(
  {
    owner_user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    name: {
      type: String,
      required: true,
    },
    slug: {
      type: String,
      unique: true,
      required: true,
      lowercase: true,
    },
    plan: {
      type: String,
      enum: ['starter', 'professional', 'enterprise', 'custom'],
      default: 'starter',
    },
    plan_status: {
      type: String,
      enum: ['trial', 'active', 'expired', 'suspended', 'cancelled', 'lifetime'],
      default: 'trial',
    },
    trial_ends_at: {
      type: Date,
      default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    },
    subscription_ends_at: {
      type: Date,
      default: null,
    },
    razorpay_customer_id: {
      type: String,
      default: null,
    },
    trial_used: {
      type: Boolean,
      default: false,
    },
    lifetime_access: {
      type: Boolean,
      default: false,
    },
    granted_by_admin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AdminUser',
      default: null,
    },
    message_limit_monthly: {
      type: Number,
      default: 1000,
    },
    seats_limit: {
      type: Number,
      default: 3,
    },
    setup_status: {
      type: String,
      enum: ['pending_plan', 'pending_setup', 'active'],
      default: 'pending_plan',
    },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  }
);

const Tenant = mongoose.model('Tenant', tenantSchema);

// ─── Startup migration: mark existing tenants with active WhatsApp accounts as 'active' ───
(async () => {
  try {
    const WhatsAppAccount = require('./WhatsAppAccount');
    // Find tenants with no setup_status or that should be active
    const tenantsWithWA = await WhatsAppAccount.distinct('tenant_id', { account_status: 'active' });
    if (tenantsWithWA.length > 0) {
      const result = await Tenant.updateMany(
        { _id: { $in: tenantsWithWA }, $or: [{ setup_status: { $exists: false } }, { setup_status: null }] },
        { $set: { setup_status: 'active' } }
      );
      if (result.modifiedCount > 0) {
        console.log(`[Tenant Migration] Set setup_status=active for ${result.modifiedCount} tenant(s) with WhatsApp accounts`);
      }
    }
    // Tenants without WA but with a plan → pending_setup
    await Tenant.updateMany(
      { setup_status: { $exists: false }, _id: { $nin: tenantsWithWA }, plan_status: { $in: ['trial', 'active', 'lifetime'] } },
      { $set: { setup_status: 'pending_setup' } }
    );
    // Tenants without WA and without plan → pending_plan
    await Tenant.updateMany(
      { setup_status: { $exists: false }, _id: { $nin: tenantsWithWA } },
      { $set: { setup_status: 'pending_plan' } }
    );
  } catch (err) {
    if (err.name !== 'MongoNotConnectedError') {
      console.warn('[Tenant Migration] setup_status backfill skipped:', err.message);
    }
  }
})();

module.exports = Tenant;
