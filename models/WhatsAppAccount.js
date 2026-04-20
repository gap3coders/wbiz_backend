const mongoose = require('mongoose');

const whatsappAccountSchema = new mongoose.Schema(
  {
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
    },
    facebook_user_id: String,
    waba_id: {
      type: String,
      required: true,
    },
    phone_number_id: {
      type: String,
      required: true,
    },
    display_phone_number: String,
    display_name: String,
    access_token_encrypted: {
      type: String,
      required: true,
    },
    token_expires_at: Date,
    webhook_verified: {
      type: Boolean,
      default: false,
    },
    account_status: {
      type: String,
      enum: ['active', 'suspended', 'disconnected'],
      default: 'active',
    },
    quality_rating: {
      type: String,
      enum: ['green', 'yellow', 'red', 'unknown'],
      default: 'unknown',
      set: (value) => (typeof value === 'string' ? value.toLowerCase() : value),
    },
    messaging_limit_tier: {
      type: Number,
      default: 1,
    },
    business_verification_status: String,
    is_default: {
      type: Boolean,
      default: false,
    },
    label: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  }
);

whatsappAccountSchema.index({ tenant_id: 1, phone_number_id: 1 }, { unique: true });
whatsappAccountSchema.index({ tenant_id: 1, is_default: 1 });

const WhatsAppAccount = mongoose.model('WhatsAppAccount', whatsappAccountSchema);

// Phase 6A migration: runs once after DB connection is ready.
// 1. Drop the legacy unique index on tenant_id alone.
// 2. Set is_default=true on the first account per tenant that has no default.
const runMigration = async () => {
  try {
    await WhatsAppAccount.collection.dropIndex('tenant_id_1').catch(() => null);
  } catch { /* already removed */ }
  try {
    // Backfill is_default for existing single-account tenants
    const needsDefault = await WhatsAppAccount.find({ is_default: { $ne: true } })
      .distinct('tenant_id');
    for (const tid of needsDefault) {
      const hasDefault = await WhatsAppAccount.findOne({ tenant_id: tid, is_default: true });
      if (!hasDefault) {
        await WhatsAppAccount.findOneAndUpdate(
          { tenant_id: tid },
          { $set: { is_default: true } },
          { sort: { created_at: 1 } }
        );
      }
    }
  } catch { /* silent */ }
};

if (mongoose.connection.readyState === 1) {
  runMigration();
} else {
  mongoose.connection.once('connected', runMigration);
}

module.exports = WhatsAppAccount;
