const mongoose = require('mongoose');

const whatsAppFlowSchema = new mongoose.Schema(
  {
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
    },
    flow_id: {
      type: String,
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ['DRAFT', 'PUBLISHED', 'DEPRECATED', 'BLOCKED', 'THROTTLED'],
      default: 'DRAFT',
    },
    categories: {
      type: [String],
      default: [],
    },
    validation_errors: {
      type: mongoose.Schema.Types.Mixed,
      default: [],
    },
    json_version: String,
    data_api_version: String,
    preview_url: {
      type: String,
      default: null,
    },
    updated_at_meta: Date,
    last_synced_at: Date,
    stats: {
      sent: { type: Number, default: 0 },
      delivered: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      completed: { type: Number, default: 0 },
    },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  }
);

whatsAppFlowSchema.index({ tenant_id: 1, flow_id: 1 }, { unique: true });
whatsAppFlowSchema.index({ tenant_id: 1, status: 1 });

module.exports = mongoose.model('WhatsAppFlow', whatsAppFlowSchema);
