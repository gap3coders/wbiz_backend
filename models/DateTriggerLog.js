const mongoose = require('mongoose');

const dateTriggerLogSchema = new mongoose.Schema(
  {
    tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    trigger_id: { type: mongoose.Schema.Types.ObjectId, ref: 'DateTrigger', required: true, index: true },
    trigger_name: { type: String, default: '' },
    run_date: { type: Date, required: true },
    status: { type: String, enum: ['success', 'partial', 'failed', 'no_match'], default: 'success' },
    matched_contacts: { type: Number, default: 0 },
    sent: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    error_details: [
      {
        phone: { type: String },
        error: { type: String },
        _id: false,
      },
    ],
    duration_ms: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

dateTriggerLogSchema.index({ tenant_id: 1, created_at: -1 });
dateTriggerLogSchema.index({ trigger_id: 1, created_at: -1 });

module.exports = mongoose.model('DateTriggerLog', dateTriggerLogSchema);
