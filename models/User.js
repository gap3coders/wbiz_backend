const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password_hash: {
      type: String,
      required: true,
    },
    full_name: {
      type: String,
      required: true,
      trim: true,
    },
    phone: {
      type: String,
      required: true,
    },
    company_name: {
      type: String,
      required: true,
    },
    country: {
      type: String,
      required: true,
    },
    industry: {
      type: String,
      default: null,
    },
    whatsapp_number: {
      type: String,
      default: null,
    },
    status: {
      type: String,
      enum: ['pending_verification', 'pending_approval', 'pending_plan', 'pending_setup', 'active', 'suspended'],
      default: 'pending_verification',
    },
    role: {
      type: String,
      enum: ['owner', 'admin', 'agent', 'viewer'],
      default: 'owner',
    },
    email_verified_at: {
      type: Date,
      default: null,
    },
    last_login_at: {
      type: Date,
      default: null,
    },
    avatar_url: {
      type: String,
      default: null,
    },
    tenant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      default: null,
    },
    tenants: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
    }],
    login_attempts: {
      type: Number,
      default: 0,
    },
    locked_until: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  }
);

// Hash password before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('password_hash')) return next();
  this.password_hash = await bcrypt.hash(this.password_hash, 12);
  next();
});

// Compare password
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password_hash);
};

// Remove sensitive fields from JSON output
userSchema.methods.toSafeJSON = function () {
  const obj = this.toObject();
  delete obj.password_hash;
  delete obj.login_attempts;
  delete obj.locked_until;
  return obj;
};

const User = mongoose.model('User', userSchema);

// ─── Startup migration: backfill tenants array for existing users ───
(async () => {
  try {
    const usersToMigrate = await User.find({
      tenant_id: { $ne: null },
      $or: [{ tenants: { $exists: false } }, { tenants: { $size: 0 } }],
    }).select('_id tenant_id');

    if (usersToMigrate.length > 0) {
      const bulkOps = usersToMigrate.map((u) => ({
        updateOne: {
          filter: { _id: u._id },
          update: { $addToSet: { tenants: u.tenant_id } },
        },
      }));
      await User.bulkWrite(bulkOps);
      console.log(`[User Migration] Backfilled tenants array for ${usersToMigrate.length} user(s)`);
    }
  } catch (err) {
    // Non-fatal — migration will retry on next boot
    if (err.name !== 'MongoNotConnectedError') {
      console.warn('[User Migration] tenants backfill skipped:', err.message);
    }
  }
})();

module.exports = User;
