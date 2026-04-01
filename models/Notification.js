const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
    type: { type: String, enum: ['template_approved', 'template_rejected', 'template_paused', 'template_pending', 'message_failed', 'account_warning', 'quality_change', 'campaign_complete', 'phone_verified', 'system', 'meta_error', 'webhook_error'], required: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    source: { type: String, enum: ['meta', 'platform'], default: 'platform' },
    severity: { type: String, enum: ['info', 'success', 'warning', 'error'], default: 'info' },
    read: { type: Boolean, default: false },
    meta_data: { type: mongoose.Schema.Types.Mixed, default: {} },
    link: { type: String, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

notificationSchema.index({ tenant_id: 1, created_at: -1 });
notificationSchema.index({ tenant_id: 1, read: 1 });
notificationSchema.index({ tenant_id: 1, type: 1, created_at: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
