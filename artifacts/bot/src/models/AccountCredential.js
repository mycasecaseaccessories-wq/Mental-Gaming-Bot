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
    // Credential kind: 'login' = email/password, 'link' = invite URL
    credType: {
      type: String,
      enum: ['login', 'link'],
      default: 'login',
    },
    loginId: {
      type: String,
      default: '',
      trim: true,
      comment: 'Email / username of the account (login type)',
    },
    password: {
      type: String,
      default: '',
      trim: true,
    },
    link: {
      type: String,
      default: '',
      trim: true,
      comment: 'Invite / join URL (link type)',
    },
    note: {
      type: String,
      default: '',
      comment: 'Optional extra info (profile PIN, etc.)',
    },

    // ── Slot capacity (shared/invite accounts) ────────────────────────────────
    // capacity = total devices/members this credential can serve (1 for single);
    // usedSlots = how many have been sold. Marked 'sold' once full.
    capacity:  { type: Number, default: 1, min: 1 },
    usedSlots: { type: Number, default: 0, min: 0 },

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

/**
 * Atomically claim `qty` slots from a single shared/invite credential that has
 * room. Increments usedSlots and flips to 'sold' when full. Returns the updated
 * credential, or null if no single credential can fit `qty` slots.
 */
accountCredentialSchema.statics.claimSlots = async function (productId, qty) {
  const n = Math.max(1, parseInt(qty, 10) || 1);
  return this.findOneAndUpdate(
    {
      productId,
      status: 'available',
      $expr: { $lte: [{ $add: ['$usedSlots', n] }, '$capacity'] },
    },
    [
      { $set: { usedSlots: { $add: ['$usedSlots', n] } } },
      { $set: { status: { $cond: [{ $gte: ['$usedSlots', '$capacity'] }, 'sold', 'available'] } } },
    ],
    { new: true, sort: { createdAt: 1 } }
  );
};

/**
 * Compensating release of `qty` slots previously claimed via claimSlots (used
 * when a post-claim step fails). Decrements usedSlots (floored at 0) and flips
 * the credential back to 'available' if it now has room again.
 */
accountCredentialSchema.statics.releaseSlots = async function (credentialId, qty) {
  const n = Math.max(1, parseInt(qty, 10) || 1);
  return this.findOneAndUpdate(
    { _id: credentialId },
    [
      { $set: { usedSlots: { $max: [0, { $subtract: ['$usedSlots', n] }] } } },
      { $set: { status: { $cond: [{ $lt: ['$usedSlots', '$capacity'] }, 'available', 'sold'] } } },
    ],
    { new: true }
  );
};

/** Total free slots across all available credentials of a product. */
accountCredentialSchema.statics.countAvailableSlots = async function (productId) {
  const agg = await this.aggregate([
    { $match: { productId: new mongoose.Types.ObjectId(String(productId)), status: 'available' } },
    { $group: { _id: null, free: { $sum: { $subtract: ['$capacity', '$usedSlots'] } } } },
  ]);
  return agg[0]?.free || 0;
};

/** Largest number of free slots available within a SINGLE credential. */
accountCredentialSchema.statics.maxFreeInOne = async function (productId) {
  const agg = await this.aggregate([
    { $match: { productId: new mongoose.Types.ObjectId(String(productId)), status: 'available' } },
    { $project: { free: { $subtract: ['$capacity', '$usedSlots'] } } },
    { $sort: { free: -1 } },
    { $limit: 1 },
  ]);
  return agg[0]?.free || 0;
};

module.exports = mongoose.model('AccountCredential', accountCredentialSchema);
