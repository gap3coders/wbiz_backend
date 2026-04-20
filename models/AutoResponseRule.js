const mongoose = require('mongoose');

const templateVariableSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    source: {
      type: String,
      enum: ['static', 'contact_name', 'contact_phone', 'contact_email', 'incoming_text'],
      default: 'static',
    },
    value: { type: String, default: '' },
  },
  { _id: false }
);

const businessHoursSchema = new mongoose.Schema(
  {
    timezone: { type: String, default: 'Asia/Kolkata', trim: true },
    days: { type: [Number], default: [1, 2, 3, 4, 5] },
    start_time: { type: String, default: '09:00' },
    end_time: { type: String, default: '18:00' },
  },
  { _id: false }
);

const autoResponseRuleSchema = new mongoose.Schema(
  {
    tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    active: { type: Boolean, default: true },
    trigger_type: {
      type: String,
      enum: ['keyword', 'welcome', 'away', 'fallback', 'unsubscribe', 'resubscribe'],
      required: true,
      default: 'keyword',
    },
    keyword_match_type: {
      type: String,
      enum: ['contains', 'exact', 'starts_with'],
      default: 'contains',
    },
    keywords: { type: [String], default: [] },
    response_type: {
      type: String,
      enum: ['text', 'template'],
      default: 'text',
      required: true,
    },
    text_body: { type: String, default: '' },
    template_name: { type: String, default: '', trim: true },
    template_language: { type: String, default: 'en', trim: true },
    template_header_type: { type: String, enum: ['none', 'image', 'video', 'document'], default: 'none' },
    template_header_media_url: { type: String, default: '', trim: true },
    template_variables: { type: [templateVariableSchema], default: [] },
    business_hours: { type: businessHoursSchema, default: () => ({}) },
    send_once_per_contact: { type: Boolean, default: false },
    cooldown_minutes: { type: Number, default: 0, min: 0, max: 10080 },
    priority: { type: Number, default: 100, min: 1, max: 1000 },
    stop_after_match: { type: Boolean, default: true },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

autoResponseRuleSchema.pre('save', function normalizeRule(next) {
  this.name = String(this.name || '').trim();
  this.description = String(this.description || '').trim();
  this.template_name = String(this.template_name || '').trim();
  this.template_language = String(this.template_language || 'en').trim() || 'en';
  this.template_header_type = String(this.template_header_type || 'none').trim().toLowerCase() || 'none';
  this.template_header_media_url = String(this.template_header_media_url || '').trim();
  this.text_body = String(this.text_body || '');
  this.priority = Number.isFinite(Number(this.priority)) ? Number(this.priority) : 100;
  this.cooldown_minutes = Number.isFinite(Number(this.cooldown_minutes)) ? Number(this.cooldown_minutes) : 0;
  this.keywords = Array.from(
    new Set(
      (Array.isArray(this.keywords) ? this.keywords : [])
        .map((keyword) => String(keyword || '').trim())
        .filter(Boolean)
    )
  );
  if (!Array.isArray(this.business_hours?.days) || !this.business_hours.days.length) {
    this.business_hours.days = [1, 2, 3, 4, 5];
  }
  next();
});

autoResponseRuleSchema.index({ tenant_id: 1, active: 1, priority: 1 });
autoResponseRuleSchema.index({ tenant_id: 1, trigger_type: 1, active: 1 });

module.exports = mongoose.model('AutoResponseRule', autoResponseRuleSchema);
