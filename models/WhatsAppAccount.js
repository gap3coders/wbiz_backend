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
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  }
);

whatsappAccountSchema.index({ tenant_id: 1 }, { unique: true });

module.exports = mongoose.model('WhatsAppAccount', whatsappAccountSchema);
