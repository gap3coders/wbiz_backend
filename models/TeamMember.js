const mongoose = require('mongoose');

const teamMemberSchema = new mongoose.Schema(
  {
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
    },
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    email: {
      type: String,
      required: true,
    },
    role: {
      type: String,
      enum: ['admin', 'agent', 'viewer'],
      required: true,
    },
    invited_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    invited_at: {
      type: Date,
      default: Date.now,
    },
    accepted_at: Date,
    status: {
      type: String,
      enum: ['pending', 'active', 'removed'],
      default: 'pending',
    },
    invite_token_hash: String,
    invite_expires_at: Date,
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  }
);

teamMemberSchema.index({ tenant_id: 1, email: 1 }, { unique: true });

module.exports = mongoose.model('TeamMember', teamMemberSchema);
