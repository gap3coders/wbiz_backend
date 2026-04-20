const mongoose = require('mongoose');

const conversationSchema = new mongoose.Schema(
  {
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      index: true,
    },
    contact_phone: {
      type: String,
      required: true,
      index: true,
    },
    contact_name: {
      type: String,
      default: '',
    },
    waba_id: {
      type: String,
      default: null,
    },
    sender_phone_number_id: {
      type: String,
      default: null,
    },
    status: {
      type: String,
      enum: ['open', 'pending', 'resolved'],
      default: 'open',
    },
    unread_count: {
      type: Number,
      default: 0,
    },
    assigned_user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    last_message_at: {
      type: Date,
      default: null,
    },
    last_message_preview: {
      type: String,
      default: '',
    },
    last_message_direction: {
      type: String,
      enum: ['inbound', 'outbound', 'system', null],
      default: null,
    },
    last_message_status: {
      type: String,
      default: null,
    },
    last_customer_message_at: {
      type: Date,
      default: null,
    },
    window_expires_at: {
      type: Date,
      default: null,
    },
    window_status: {
      type: String,
      enum: ['open', 'expired', 'none'],
      default: 'none',
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  }
);

conversationSchema.index({ tenant_id: 1, status: 1, last_message_at: -1 });
conversationSchema.index({ tenant_id: 1, contact_phone: 1 }, { unique: true });

conversationSchema.statics.migrateIndexesForSinglePhone = async function migrateIndexesForSinglePhone() {
  const collection = this.collection;
  const indexes = await collection.indexes().catch(() => []);
  const staleIndexes = ['tenant_id_1_contact_id_1'];

  for (const indexName of staleIndexes) {
    if (indexes.some((index) => index.name === indexName)) {
      await collection.dropIndex(indexName).catch(() => {});
    }
  }

  await collection.createIndex({ tenant_id: 1, contact_phone: 1 }, { unique: true }).catch(() => {});
  await collection.createIndex({ tenant_id: 1, status: 1, last_message_at: -1 }).catch(() => {});
};

module.exports = mongoose.model('Conversation', conversationSchema);
