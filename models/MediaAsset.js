const mongoose = require('mongoose');

const mediaAssetSchema = new mongoose.Schema(
  {
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      index: true,
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    asset_type: {
      type: String,
      enum: ['image', 'video', 'document', 'audio'],
      required: true,
      index: true,
    },
    original_name: {
      type: String,
      required: true,
      trim: true,
    },
    stored_name: {
      type: String,
      required: true,
      trim: true,
    },
    mime_type: {
      type: String,
      required: true,
      trim: true,
    },
    size_bytes: {
      type: Number,
      default: 0,
    },
    relative_path: {
      type: String,
      required: true,
      trim: true,
    },
    public_url: {
      type: String,
      required: true,
      trim: true,
    },
    source: {
      type: String,
      enum: ['upload'],
      default: 'upload',
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

mediaAssetSchema.index({ tenant_id: 1, asset_type: 1, created_at: -1 });

module.exports = mongoose.model('MediaAsset', mediaAssetSchema);
