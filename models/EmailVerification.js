const mongoose = require('mongoose');

const emailVerificationSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    token_hash: {
      type: String,
      required: true,
      unique: true,
    },
    type: {
      type: String,
      enum: ['register', 'password_reset', 'email_change'],
      required: true,
    },
    expires_at: {
      type: Date,
      required: true,
    },
    used_at: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  }
);

// Auto-expire documents
emailVerificationSchema.index({ expires_at: 1 }, { expireAfterSeconds: 3600 });

module.exports = mongoose.model('EmailVerification', emailVerificationSchema);
