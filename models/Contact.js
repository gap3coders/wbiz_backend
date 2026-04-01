const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema(
  {
    tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
    phone: { type: String, required: true, trim: true },
    name: { type: String, default: '', trim: true },
    wa_name: { type: String, default: '' },
    profile_name: { type: String, default: '' },
    whatsapp_id: { type: String, default: '', trim: true },
    email: { type: String, default: '', trim: true },
    labels: { type: [String], default: [] },
    tags: { type: [String], default: [] },
    opt_in: { type: Boolean, default: true },
    notes: { type: String, default: '' },
    custom_fields: { type: mongoose.Schema.Types.Mixed, default: {} },
    wa_exists: { type: String, enum: ['yes', 'no', 'unknown'], default: 'unknown' },
    wa_profile_pic: { type: String, default: null },
    last_message_at: { type: Date, default: null },
    last_checked_at: { type: Date, default: null },
    last_inbound_at: { type: Date, default: null },
    last_outbound_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

contactSchema.pre('save', function syncLegacyAndPortalFields(next) {
  const normalizedPhone = String(this.phone || '').trim();
  this.phone = normalizedPhone;
  this.whatsapp_id = this.whatsapp_id || normalizedPhone;

  const displayName = String(this.wa_name || this.profile_name || '').trim();
  this.wa_name = displayName;
  this.profile_name = displayName;

  const normalizedTags = Array.from(
    new Set([...(Array.isArray(this.labels) ? this.labels : []), ...(Array.isArray(this.tags) ? this.tags : [])]
      .map((item) => String(item || '').trim())
      .filter(Boolean))
  );
  this.labels = normalizedTags;
  this.tags = normalizedTags;

  if (this.whatsapp_id === undefined || this.whatsapp_id === null) {
    this.whatsapp_id = '';
  }

  next();
});

contactSchema.index({ tenant_id: 1, phone: 1 }, { unique: true });
contactSchema.index({ tenant_id: 1, labels: 1 });
contactSchema.index({ tenant_id: 1, tags: 1 });

contactSchema.statics.migrateToSinglePhoneField = async function migrateToSinglePhoneField() {
  const collection = this.collection;

  await collection.updateMany(
    {},
    [
      {
        $set: {
          phone: {
            $trim: {
              input: {
                $ifNull: ['$phone', '$phone_number'],
              },
            },
          },
          whatsapp_id: {
            $ifNull: [
              '$whatsapp_id',
              {
                $trim: {
                  input: {
                    $ifNull: ['$phone', '$phone_number'],
                  },
                },
              },
            ],
          },
        },
      },
      {
        $unset: ['phone_number'],
      },
    ]
  ).catch(() => {});

  const indexes = await collection.indexes().catch(() => []);
  const staleIndexes = ['phone_number_1'];

  for (const indexName of staleIndexes) {
    if (indexes.some((index) => index.name === indexName)) {
      await collection.dropIndex(indexName).catch(() => {});
    }
  }

  await collection.createIndex({ tenant_id: 1, phone: 1 }, { unique: true }).catch(() => {});
};

module.exports = mongoose.model('Contact', contactSchema);
