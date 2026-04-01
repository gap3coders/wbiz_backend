const mongoose = require('mongoose');

const syncMessageIds = (target) => {
  if (!target || typeof target !== 'object') return;

  const topLevelCanonical = target.wa_message_id ?? target.whatsapp_message_id;
  if (topLevelCanonical) {
    target.wa_message_id = topLevelCanonical;
    target.whatsapp_message_id = topLevelCanonical;
  }

  if (target.$set && typeof target.$set === 'object') {
    const setCanonical = target.$set.wa_message_id ?? target.$set.whatsapp_message_id;
    if (setCanonical) {
      target.$set.wa_message_id = setCanonical;
      target.$set.whatsapp_message_id = setCanonical;
    }
  }

  if (target.$setOnInsert && typeof target.$setOnInsert === 'object') {
    const insertCanonical = target.$setOnInsert.wa_message_id ?? target.$setOnInsert.whatsapp_message_id;
    if (insertCanonical) {
      target.$setOnInsert.wa_message_id = insertCanonical;
      target.$setOnInsert.whatsapp_message_id = insertCanonical;
    }
  }
};

const messageSchema = new mongoose.Schema(
  {
    tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
    contact_phone: { type: String, required: true },
    contact_name: { type: String, default: '' },
    direction: { type: String, enum: ['inbound', 'outbound'], required: true },
    message_type: { type: String, enum: ['text', 'template', 'image', 'document', 'video', 'audio', 'location', 'reaction', 'interactive', 'sticker', 'contacts', 'unknown'], default: 'text' },
    content: { type: String, default: '' },
    template_name: { type: String, default: null },
    template_params: { type: mongoose.Schema.Types.Mixed, default: null },
    media_url: { type: String, default: null },
    media_id: { type: String, default: null },
    media_mime: { type: String, default: null },
    media_filename: { type: String, default: null },
    wa_message_id: { type: String, default: null },
    whatsapp_message_id: { type: String, default: null, select: false },
    status: { type: String, enum: ['queued', 'sent', 'delivered', 'read', 'failed'], default: 'queued' },
    error_message: { type: String, default: null },
    error_source: { type: String, enum: ['meta', 'platform', null], default: null },
    campaign_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', default: null },
    sent_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    timestamp: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

messageSchema.pre('validate', function syncDocumentMessageIds(next) {
  syncMessageIds(this);
  next();
});

messageSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], function syncUpdateMessageIds(next) {
  const update = this.getUpdate();
  syncMessageIds(update);
  this.setUpdate(update);
  next();
});

messageSchema.index({ tenant_id: 1, contact_phone: 1, timestamp: -1 });
messageSchema.index({ tenant_id: 1, direction: 1, timestamp: -1 });
messageSchema.index({ tenant_id: 1, status: 1, timestamp: -1 });
messageSchema.index(
  { tenant_id: 1, wa_message_id: 1 },
  {
    unique: true,
    name: 'tenant_id_1_wa_message_id_1',
    partialFilterExpression: { wa_message_id: { $type: 'string' } },
  }
);
messageSchema.index({ tenant_id: 1, campaign_id: 1 });

messageSchema.statics.migrateLegacyIndexesAndIds = async function migrateLegacyIndexesAndIds() {
  const collection = this.collection;

  await collection.updateMany(
    {
      wa_message_id: { $in: [null, ''] },
      whatsapp_message_id: { $type: 'string' },
    },
    [{ $set: { wa_message_id: '$whatsapp_message_id' } }]
  ).catch((error) => {
    console.warn('Message ID backfill skipped:', error.message);
  });

  const indexes = await collection.indexes().catch(() => []);
  const staleIndexes = ['tenant_id_1_whatsapp_message_id_1', 'whatsapp_message_id_1'];

  for (const indexName of staleIndexes) {
    if (indexes.some((index) => index.name === indexName)) {
      await collection.dropIndex(indexName).catch((error) => {
        console.warn(`Failed to drop stale Message index ${indexName}:`, error.message);
      });
    }
  }

  await collection.createIndex(
    { tenant_id: 1, wa_message_id: 1 },
    {
      unique: true,
      name: 'tenant_id_1_wa_message_id_1',
      partialFilterExpression: { wa_message_id: { $type: 'string' } },
    }
  ).catch((error) => {
    console.warn('Failed to ensure Message wa_message_id index:', error.message);
  });
};

module.exports = mongoose.model('Message', messageSchema);
