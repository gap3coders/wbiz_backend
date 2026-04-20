const mongoose = require('mongoose');

const apiKeySchema = new mongoose.Schema(
  {
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    key_prefix: {
      type: String,
      required: true,
    },
    key_hash: {
      type: String,
      required: true,
    },
    permissions: {
      type: [String],
      default: [
        'messages:read',
        'messages:send',
        'contacts:read',
        'contacts:write',
        'campaigns:read',
        'templates:read',
      ],
    },
    last_used_at: {
      type: Date,
      default: null,
    },
    last_used_ip: {
      type: String,
      default: null,
    },
    expires_at: {
      type: Date,
      default: null,
    },
    active: {
      type: Boolean,
      default: true,
    },
    request_count: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  }
);

apiKeySchema.index({ tenant_id: 1, active: 1 });
apiKeySchema.index({ key_hash: 1 }, { unique: true });
apiKeySchema.index({ tenant_id: 1, created_by: 1 });

module.exports = mongoose.model('ApiKey', apiKeySchema);
