const mongoose = require('mongoose');

const quickReplySchema = new mongoose.Schema(
  {
    tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    shortcut: { type: String, trim: true, maxlength: 30, default: '' },
    message: { type: String, required: true, trim: true, maxlength: 4096 },
    category: { type: String, enum: ['general', 'greeting', 'support', 'sales', 'follow_up', 'closing'], default: 'general' },
    media_url: { type: String, default: null },
    media_type: { type: String, enum: ['image', 'video', 'document', null], default: null },
    use_count: { type: Number, default: 0 },
    is_global: { type: Boolean, default: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

quickReplySchema.index({ tenant_id: 1, created_at: -1 });
quickReplySchema.index({ tenant_id: 1, category: 1 });
quickReplySchema.index({ tenant_id: 1, shortcut: 1 });

module.exports = mongoose.model('QuickReply', quickReplySchema);
