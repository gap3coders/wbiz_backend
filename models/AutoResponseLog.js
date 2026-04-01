const mongoose = require('mongoose');

const autoResponseLogSchema = new mongoose.Schema(
  {
    tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    rule_id: { type: mongoose.Schema.Types.ObjectId, ref: 'AutoResponseRule', required: true, index: true },
    rule_name: { type: String, required: true, trim: true },
    trigger_type: { type: String, enum: ['keyword', 'welcome', 'away', 'fallback'], required: true },
    response_type: { type: String, enum: ['text', 'template'], required: true },
    contact_phone: { type: String, required: true, trim: true, index: true },
    contact_name: { type: String, default: '', trim: true },
    inbound_message_id: { type: String, default: null, index: true },
    matched_text: { type: String, default: '' },
    status: { type: String, enum: ['sent', 'skipped', 'failed'], default: 'sent', index: true },
    reason: { type: String, default: '' },
    outbound_message_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
    wa_message_id: { type: String, default: null },
    meta_data: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

autoResponseLogSchema.index({ tenant_id: 1, created_at: -1 });
autoResponseLogSchema.index({ tenant_id: 1, rule_id: 1, contact_phone: 1, created_at: -1 });

module.exports = mongoose.model('AutoResponseLog', autoResponseLogSchema);
