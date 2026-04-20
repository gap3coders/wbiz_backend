const mongoose = require('mongoose');

const planSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    price_monthly: { type: Number, default: 0 },
    price_yearly: { type: Number, default: 0 },
    currency: { type: String, default: 'INR' },
    message_limit: { type: Number, default: 1000 },
    seats_limit: { type: Number, default: 3 },
    features: [{ type: String }], // e.g. ['Auto Responses', 'Campaigns', 'Analytics']
    is_popular: { type: Boolean, default: false },
    is_active: { type: Boolean, default: true },
    sort_order: { type: Number, default: 0 },
    trial_days: { type: Number, default: 14 },
    // Limits
    campaign_limit_monthly: { type: Number, default: 10 },
    template_limit: { type: Number, default: 25 },
    media_storage_mb: { type: Number, default: 500 },
    auto_response_limit: { type: Number, default: 10 },
    contact_limit: { type: Number, default: 5000 },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

module.exports = mongoose.model('Plan', planSchema);
