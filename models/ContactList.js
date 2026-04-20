const mongoose = require('mongoose');

const contactListSchema = new mongoose.Schema(
  {
    tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 500, default: '' },
    color: { type: String, default: '#25D366' },
    contacts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Contact' }],
    contact_count: { type: Number, default: 0 },
    is_dynamic: { type: Boolean, default: false },
    dynamic_filters: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

contactListSchema.index({ tenant_id: 1, created_at: -1 });
contactListSchema.index({ tenant_id: 1, name: 1 });

contactListSchema.pre('save', function (next) {
  if (this.isModified('contacts')) {
    this.contact_count = this.contacts?.length || 0;
  }
  next();
});

module.exports = mongoose.model('ContactList', contactListSchema);
