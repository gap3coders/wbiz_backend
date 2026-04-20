const mongoose = require('mongoose');

const systemConfigSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, index: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true },
  description: { type: String, default: '' },
  is_secret: { type: Boolean, default: false },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

// Static helper to get a config value
systemConfigSchema.statics.getValue = async function(key, defaultValue = null) {
  const doc = await this.findOne({ key });
  return doc ? doc.value : defaultValue;
};

// Static helper to set a config value
systemConfigSchema.statics.setValue = async function(key, value, description = '', is_secret = false) {
  return this.findOneAndUpdate(
    { key },
    { value, description, is_secret },
    { upsert: true, new: true }
  );
};

module.exports = mongoose.model('SystemConfig', systemConfigSchema);
