/**
 * AccountGiveaway — free premium-account giveaway config.
 * MULTIPLE giveaways can run at once (one per product). Every restriction is
 * individually toggleable from the admin panel.
 */
const mongoose = require('mongoose');

const accountGiveawaySchema = new mongoose.Schema(
  {
    // What kind of item this giveaway hands out:
    //   'account' → a premium AccountProduct (any type: single/shared/invite)
    //   'shop'    → a regular shop Product, delivered as a 100%-off personal coupon
    kind: {
      type: String,
      enum: ['account', 'shop'],
      default: 'account',
    },
    // Set when kind = 'account'. (Left unset for shop giveaways.)
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AccountProduct',
      default: undefined,
    },
    // Set when kind = 'shop'. (Left unset for account giveaways.)
    shopProductId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      default: undefined,
    },
    isActive: {
      type: Boolean,
      default: false,
    },

    // ── Restrictions (each optional / toggleable) ─────────────────────────────
    maxClaims: {
      type: Number,
      default: 0,
      min: 0,
      comment: 'Total claim quota (0 = unlimited, only limited by stock)',
    },
    claimedCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    endAt: {
      type: Date,
      default: null,
      comment: 'Giveaway deadline (null = no time limit)',
    },
    minAccountAgeDays: {
      type: Number,
      default: 0,
      min: 0,
      comment: 'Minimum estimated Telegram account age in days (0 = off)',
    },
    requirePurchase: {
      type: Boolean,
      default: false,
      comment: 'User must have at least one successful order',
    },
    requireChannelId: {
      type: Number,
      default: null,
      comment: 'User must be a member of this channel (null = off)',
    },
    requireChannelTitle: {
      type: String,
      default: '',
    },

    createdBy: { type: Number, default: null },
  },
  { timestamps: true, versionKey: false }
);

// One giveaway per product (prevents two configs fighting over the same stock).
// Partial so shop-only docs (productId unset) and account-only docs
// (shopProductId unset) don't collide on the "missing" value.
accountGiveawaySchema.index(
  { productId: 1 },
  { unique: true, partialFilterExpression: { productId: { $type: 'objectId' } } }
);
accountGiveawaySchema.index(
  { shopProductId: 1 },
  { unique: true, partialFilterExpression: { shopProductId: { $type: 'objectId' } } }
);
// Fast lookup of the currently-running giveaways.
accountGiveawaySchema.index({ isActive: 1 });

// All currently-running giveaways (newest first).
accountGiveawaySchema.statics.getActives = function () {
  return this.find({ isActive: true })
    .populate('productId')
    .populate('shopProductId')
    .sort({ updatedAt: -1 });
};

// Kept for callers that only need any one active giveaway.
accountGiveawaySchema.statics.getActive = function () {
  return this.findOne({ isActive: true }).populate('productId').populate('shopProductId');
};

module.exports = mongoose.model('AccountGiveaway', accountGiveawaySchema);
