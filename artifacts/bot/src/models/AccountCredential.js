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

    // ── Stock-date expiry ─────────────────────────────────────────────────────
    // Fixed shelf life for this credential, set at stock-add time when the
    // parent product has stockDateExpiry on (= addedAt + durationDays). null when
    // the product counts validity from purchase instead. Once past, the cron job
    // retires the credential (status -> 'expired') so it can no longer be sold.
    stockExpiresAt: { type: Date, default: null, index: true },

    status: {
      type: String,
      enum: ['available', 'sold', 'expired'],
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

// Live guard: a credential is sellable only if not past its stock shelf life.
// Cron retires expired stock daily; this protects the window between runs.
function freshStock() {
  return { $or: [{ stockExpiresAt: null }, { stockExpiresAt: { $gt: new Date() } }] };
}

/**
 * Atomically claim one available credential for a buyer. Oldest first (FIFO), so
 * the most-aged stock sells before fresher stock. Returns null if out of stock.
 */
accountCredentialSchema.statics.claimOne = async function (productId, saleFields) {
  return this.findOneAndUpdate(
    { productId, status: 'available', ...freshStock() },
    { $set: { status: 'sold', ...saleFields } },
    { new: true, sort: { createdAt: 1 } }
  );
};

accountCredentialSchema.statics.countAvailable = function (productId) {
  return this.countDocuments({ productId, status: 'available', ...freshStock() });
};

/** Peek the next credential to be sold (oldest available, not stock-expired). */
accountCredentialSchema.statics.nextAvailable = function (productId) {
  return this.findOne({ productId, status: 'available', ...freshStock() }).sort({ createdAt: 1 });
};

/**
 * Retire stock whose fixed shelf life has passed (status 'available' -> 'expired')
 * so it can no longer be sold. Returns the number retired.
 */
accountCredentialSchema.statics.retireExpiredStock = async function () {
  const res = await this.updateMany(
    { status: 'available', stockExpiresAt: { $ne: null, $lte: new Date() } },
    { $set: { status: 'expired' } }
  );
  return res.modifiedCount || 0;
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
      ...freshStock(),
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
 * Peek the credential that claimSlots(productId, qty) WOULD select (oldest
 * available, not stock-expired, with room for `qty` slots) — without claiming.
 * Used to quote the correct price/remaining-days for multi-slot purchases so
 * the shown price matches the credential actually fulfilled. Returns null when
 * no single credential can fit `qty`.
 */
accountCredentialSchema.statics.peekClaimable = function (productId, qty) {
  const n = Math.max(1, parseInt(qty, 10) || 1);
  return this.findOne({
    productId,
    status: 'available',
    ...freshStock(),
    $expr: { $lte: [{ $add: ['$usedSlots', n] }, '$capacity'] },
  }).sort({ createdAt: 1 });
};

/**
 * Compensating release of a single credential claimed via claimOne (used when a
 * post-claim step, e.g. the wallet debit, fails). Atomically un-sells it: back to
 * 'available' and clears the buyer/sale fields. Only acts on a 'sold' doc.
 */
accountCredentialSchema.statics.releaseOne = function (credentialId) {
  return this.findOneAndUpdate(
    { _id: credentialId, status: 'sold' },
    {
      $set: { status: 'available' },
      $unset: { buyerUserId: '', buyerTelegramId: '', soldAt: '', expiresAt: '', pricePaid: '' },
    },
    { new: true }
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
    { $match: { productId: new mongoose.Types.ObjectId(String(productId)), status: 'available', ...freshStock() } },
    { $group: { _id: null, free: { $sum: { $subtract: ['$capacity', '$usedSlots'] } } } },
  ]);
  return agg[0]?.free || 0;
};

/** Largest number of free slots available within a SINGLE credential. */
accountCredentialSchema.statics.maxFreeInOne = async function (productId) {
  const agg = await this.aggregate([
    { $match: { productId: new mongoose.Types.ObjectId(String(productId)), status: 'available', ...freshStock() } },
    { $project: { free: { $subtract: ['$capacity', '$usedSlots'] } } },
    { $sort: { free: -1 } },
    { $limit: 1 },
  ]);
  return agg[0]?.free || 0;
};

module.exports = mongoose.model('AccountCredential', accountCredentialSchema);
