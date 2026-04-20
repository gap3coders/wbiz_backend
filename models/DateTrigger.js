const mongoose = require('mongoose');

const variableMappingSchema = new mongoose.Schema(
  {
    index: { type: Number, required: true },
    source: {
      type: String,
      enum: ['static', 'contact_name', 'contact_phone', 'contact_email', 'contact_field', 'custom_field'],
      default: 'static',
    },
    field_path: { type: String, default: '' },
    static_value: { type: String, default: '' },
  },
  { _id: false }
);

const dateTriggerSchema = new mongoose.Schema(
  {
    tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    active: { type: Boolean, default: true },

    // ─── Trigger configuration ──────────────────────────────────
    trigger_type: {
      type: String,
      enum: ['birthday', 'anniversary', 'custom_date', 'recurring_annual', 'one_time', 'cron'],
      required: true,
      default: 'birthday',
    },
    // Which contact field to check (e.g. "birthday", "custom_fields.renewal_date")
    contact_field: { type: String, default: 'birthday', trim: true },
    // Offset in days: 0 = on the day, -1 = day before, +7 = week after
    offset_days: { type: Number, default: 0 },
    // Time to send messages (HH:mm format)
    send_time: { type: String, default: '09:00', trim: true },
    // IANA timezone
    timezone: { type: String, default: 'Asia/Kolkata', trim: true },
    // For one_time triggers: the specific date to fire
    one_time_date: { type: Date, default: null },

    // ─── Advanced: Cron override ────────────────────────────────
    // If set, overrides simple date logic — becomes a scheduled broadcast
    cron_expression: { type: String, default: '', trim: true },

    // ─── Template configuration ─────────────────────────────────
    template_name: { type: String, required: true, trim: true },
    template_language: { type: String, default: 'en', trim: true },
    template_header_type: { type: String, enum: ['none', 'image', 'video', 'document'], default: 'none' },
    template_header_media_url: { type: String, default: '', trim: true },
    variable_mapping: { type: [variableMappingSchema], default: [] },

    // ─── Target filters ─────────────────────────────────────────
    target_type: { type: String, enum: ['all', 'tags', 'list'], default: 'all' },
    target_tags: { type: [String], default: [] },
    target_list_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ContactList', default: null },

    // ─── Execution tracking ─────────────────────────────────────
    last_run_at: { type: Date, default: null },
    next_run_at: { type: Date, default: null },
    stats: {
      total_runs: { type: Number, default: 0 },
      total_sent: { type: Number, default: 0 },
      total_delivered: { type: Number, default: 0 },
      total_failed: { type: Number, default: 0 },
      last_run_sent: { type: Number, default: 0 },
      last_run_failed: { type: Number, default: 0 },
      last_run_matched: { type: Number, default: 0 },
      last_error: { type: String, default: '' },
    },

    created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

dateTriggerSchema.pre('save', function normalize(next) {
  this.name = String(this.name || '').trim();
  this.description = String(this.description || '').trim();
  this.template_name = String(this.template_name || '').trim();
  this.template_language = String(this.template_language || 'en').trim() || 'en';
  this.send_time = String(this.send_time || '09:00').trim();
  this.timezone = String(this.timezone || 'Asia/Kolkata').trim();
  this.cron_expression = String(this.cron_expression || '').trim();
  this.contact_field = String(this.contact_field || 'birthday').trim();
  this.offset_days = Number.isFinite(Number(this.offset_days)) ? Number(this.offset_days) : 0;
  this.target_tags = (Array.isArray(this.target_tags) ? this.target_tags : [])
    .map((t) => String(t || '').trim())
    .filter(Boolean);
  next();
});

dateTriggerSchema.index({ tenant_id: 1, active: 1 });
dateTriggerSchema.index({ tenant_id: 1, trigger_type: 1 });
dateTriggerSchema.index({ active: 1, next_run_at: 1 });

module.exports = mongoose.model('DateTrigger', dateTriggerSchema);
