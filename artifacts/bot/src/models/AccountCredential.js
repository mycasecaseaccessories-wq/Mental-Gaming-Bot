/**
 * AccountCredential — individual login credentials (stock) for AccountProduct.
 * One credential = one sellable unit. Delivered instantly on purchase.
 */
const mongoose = require('mongoose');

const accountCredentialSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AccountProduct',
      required: true,
      index: true,
    },
    loginId: {
      type: String,
      required: true,
      trim: true,
      comment: 'Email / username of the account',
    },
    password: {
      type: String,
      required: true,
      trim: true,
    },
    note: {
      type: String,
      default: '',
      comment: 'Optional extra info (profile PIN, etc.)',
    },
    status: {
      type: String,
      enum: ['available', 'sold'],
      default: 'available',
      index: true,
    },

    // ── Sale snapshot (set at purchase time) ──────────────────────────────────
    buyerUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    buyerTelegramId: { type: Number, default: null, index: true },
    soldAt:          { type: Date,   default: null },
    expiresAt:       { type: Date,   default: null, index: true },
    pricePaid:       { type: Number, default: null },
    serviceNameSnap: { type: String, default: null, comment: 'Snapshot so history survives product deletion' },
    planLabelSnap:   { type: String, default: null },
    durationDaysSnap:{ type: Number, default: null },

    // ── Expiry reminder flags ─────────────────────────────────────────────────
    notified3d:      { type: Boolean, default: false },
    notifiedExpired: { type: Boolean, default: false },

    addedBy: { type: Number, default: null, comment: 'Admin Telegram ID who added this credential' },
  },
  { timestamps: true, versionKey: false }
);

accountCredentialSchema.index({ productId: 1, status: 1 });

/** Atomically claim one available credential for a buyer. Returns null if out of stock. */
accountCredentialSchema.statics.claimOne = async function (productId, saleFields) {
  return this.findOneAndUpdate(
    { productId, status: 'available' },
    { $set: { status: 'sold', ...saleFields } },
    { new: true, sort: { createdAt: 1 } }
  );
};

accountCredentialSchema.statics.countAvailable = function (productId) {
  return this.countDocuments({ productId, status: 'available' });
};

module.exports = mongoose.model('AccountCredential', accountCredentialSchema);
