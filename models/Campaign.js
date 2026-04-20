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
    target_list_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ContactList', default: null },
    scheduled_at: { type: Date, default: null },
    started_at: { type: Date, default: null },
    completed_at: { type: Date, default: null },
    // Advanced settings
    send_rate: { type: Number, default: 0, min: 0 },
    retry_failed: { type: Boolean, default: false },
    max_retries: { type: Number, default: 1, min: 1, max: 5 },
    exclude_opted_out: { type: Boolean, default: true },
    time_window_start: { type: String, default: '' },
    time_window_end: { type: String, default: '' },
    // Campaign Advanced Settings
    auto_resend_failed: { type: Boolean, default: false },
    auto_resend_delay_hours: { type: Number, default: 2, min: 1, max: 48 },
    auto_resend_max_attempts: { type: Number, default: 1, min: 1, max: 3 },
    auto_resend_completed: { type: Boolean, default: false },
    tag_by_status: { type: Boolean, default: false },
    tag_prefix: { type: String, default: '' },
    auto_unsubscribe_failures: { type: Boolean, default: false },
    auto_unsubscribe_threshold: { type: Number, default: 3, min: 2, max: 10 },
    // Email report settings
    send_completion_report: { type: Boolean, default: true },
    report_recipients: { type: [String], default: [] },
    report_sent_at: { type: Date, default: null },
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
