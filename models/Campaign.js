const mongoose = require('mongoose');

const campaignSchema = new mongoose.Schema(
  {
    tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
    name: { type: String, required: true, trim: true },
    template_name: { type: String, required: true },
    template_language: { type: String, default: 'en' },
    template_components: { type: mongoose.Schema.Types.Mixed, default: [] },
    variable_mapping: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ['draft', 'scheduled', 'running', 'paused', 'completed', 'failed'], default: 'draft' },
    target_type: { type: String, enum: ['all', 'tags', 'selected'], default: 'selected' },
    target_tags: { type: [String], default: [] },
    recipients: { type: [String], default: [] },
    scheduled_at: { type: Date, default: null },
    started_at: { type: Date, default: null },
    completed_at: { type: Date, default: null },
    stats: {
      total: { type: Number, default: 0 },
      sent: { type: Number, default: 0 },
      delivered: { type: Number, default: 0 },
      read: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      errors: [{ phone: String, error: String, source: String }],
    },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

campaignSchema.index({ tenant_id: 1, status: 1 });
campaignSchema.index({ tenant_id: 1, scheduled_at: 1 });
module.exports = mongoose.model('Campaign', campaignSchema);
