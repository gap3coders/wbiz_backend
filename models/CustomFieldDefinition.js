const mongoose = require('mongoose');

const customFieldDefinitionSchema = new mongoose.Schema(
  {
    tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    field_name: { type: String, required: true, trim: true },
    field_label: { type: String, required: true, trim: true },
    field_type: {
      type: String,
      enum: ['text', 'number', 'date', 'select', 'multi_select', 'email', 'url', 'phone', 'textarea', 'boolean'],
      default: 'text',
    },
    options: { type: [String], default: [] },
    is_required: { type: Boolean, default: false },
    placeholder: { type: String, default: '' },
    default_value: { type: mongoose.Schema.Types.Mixed, default: null },
    sort_order: { type: Number, default: 0 },
    is_active: { type: Boolean, default: true },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

customFieldDefinitionSchema.index({ tenant_id: 1, field_name: 1 }, { unique: true });
customFieldDefinitionSchema.index({ tenant_id: 1, sort_order: 1 });

module.exports = mongoose.model('CustomFieldDefinition', customFieldDefinitionSchema);
