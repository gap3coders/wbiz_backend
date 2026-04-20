const mongoose = require('mongoose');

const emailTemplateSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    subject: { type: String, required: true, trim: true },
    category: {
      type: String,
      enum: ['auth', 'notification', 'marketing', 'system', 'transactional'],
      default: 'system',
    },
    html_body: { type: String, required: true },
    description: { type: String, default: '' },
    variables: [{ type: String }], // e.g. ['user_name', 'verify_url', 'company_name']
    active: { type: Boolean, default: true },
    updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

module.exports = mongoose.model('EmailTemplate', emailTemplateSchema);
