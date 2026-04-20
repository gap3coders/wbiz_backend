const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const adminUserSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password_hash: { type: String, required: true },
    full_name: { type: String, required: true, trim: true },
    role: { type: String, enum: ['super_admin', 'admin', 'support'], default: 'admin' },
    status: { type: String, enum: ['active', 'suspended'], default: 'active' },
    avatar_url: { type: String, default: null },
    last_login_at: { type: Date, default: null },
    login_attempts: { type: Number, default: 0 },
    locked_until: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

adminUserSchema.pre('save', async function (next) {
  if (!this.isModified('password_hash')) return next();
  this.password_hash = await bcrypt.hash(this.password_hash, 12);
  next();
});

adminUserSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password_hash);
};

adminUserSchema.methods.toSafeJSON = function () {
  const obj = this.toObject();
  delete obj.password_hash;
  delete obj.login_attempts;
  delete obj.locked_until;
  return obj;
};

module.exports = mongoose.model('AdminUser', adminUserSchema);
