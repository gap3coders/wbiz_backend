const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema({
  tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  plan_slug: { type: String, required: true },
  plan_name: { type: String, required: true },
  billing_cycle: { type: String, enum: ['monthly', 'yearly'], required: true },
  amount: { type: Number, required: true },
  currency: { type: String, default: 'INR' },
  status: { type: String, enum: ['pending', 'active', 'expired', 'cancelled', 'failed'], default: 'pending' },
  razorpay_order_id: { type: String, default: null },
  razorpay_payment_id: { type: String, default: null },
  razorpay_signature: { type: String, default: null },
  starts_at: { type: Date, default: null },
  ends_at: { type: Date, default: null },
  cancelled_at: { type: Date, default: null },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('Subscription', subscriptionSchema);
