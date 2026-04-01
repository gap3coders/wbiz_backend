const mongoose = require('mongoose');

const webhookEventSchema = new mongoose.Schema(
  {
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      default: null,
    },
    waba_id: String,
    event_type: String,
    payload: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    processing_status: {
      type: String,
      enum: ['pending', 'processed', 'failed', 'skipped'],
      default: 'pending',
    },
    processed_at: Date,
    retry_count: {
      type: Number,
      default: 0,
    },
    error_message: String,
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  }
);

module.exports = mongoose.model('WebhookEvent', webhookEventSchema);
