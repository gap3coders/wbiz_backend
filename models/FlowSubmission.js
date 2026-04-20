const mongoose = require('mongoose');

const flowSubmissionSchema = new mongoose.Schema(
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
    contact_phone: {
      type: String,
      required: true,
    },
    contact_name: {
      type: String,
      default: '',
    },
    wa_message_id: String,
    response_data: {
      type: mongoose.Schema.Types.Mixed,
    },
    status: {
      type: String,
      enum: ['completed', 'expired', 'error'],
      default: 'completed',
    },
    submitted_at: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  }
);

flowSubmissionSchema.index({ tenant_id: 1, flow_id: 1, submitted_at: -1 });
flowSubmissionSchema.index({ tenant_id: 1, contact_phone: 1 });

module.exports = mongoose.model('FlowSubmission', flowSubmissionSchema);
