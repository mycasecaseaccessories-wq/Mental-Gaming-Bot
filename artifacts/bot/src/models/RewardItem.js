const mongoose = require('mongoose');

/**
 * RewardItem — an entry in the Coin Rewards redemption catalog.
 *
 * Users spend Mental Coins (MC / balanceCoin) to redeem a reward item.
 * A reward item grants ONE of:
 *   - product : a specific store Product (delivered via a coin-paid Order)
 *   - coupon  : a personal discount code (a Promo restricted to the redeemer)
 */
const rewardItemSchema = new mongoose.Schema(
  {
    name:        { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    imageUrl:    { type: String, default: null },

    // MC cost to redeem this reward
    coinPrice: { type: Number, required: true, min: 0 },

    rewardType: {
      type: String,
      enum: ['product', 'coupon'],
      required: true,
    },

    // ── product grant ─────────────────────────────────────────────────────────
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      default: null,
    },

    // ── coupon grant ──────────────────────────────────────────────────────────
    couponDiscountType: { type: String, enum: ['Flat', 'Percentage'], default: null },
    couponValue:        { type: Number, default: null, comment: 'KS off (Flat) or % (Percentage)' },
    couponMinOrder:     { type: Number, default: 0 },
    couponExpiryDays:   { type: Number, default: null, comment: 'null = never expires' },

    // ── availability ──────────────────────────────────────────────────────────
    stockCount:   { type: Number, default: -1, comment: '-1 = unlimited redemptions' },
    perUserLimit: { type: Number, default: 0,  comment: '0 = unlimited per user' },
    redeemCount:  { type: Number, default: 0 },
    redeemedBy: [
      {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        at:     { type: Date, default: Date.now },
      },
    ],

    status: {
      type: String,
      enum: ['active', 'hidden', 'out_of_stock'],
      default: 'active',
    },
    sortOrder: { type: Number, default: 0 },
    createdBy: { type: Number, default: null, comment: 'Admin Telegram ID' },
  },
  { timestamps: true, versionKey: false }
);

rewardItemSchema.index({ status: 1, sortOrder: 1 });

rewardItemSchema.methods.inStock = function () {
  return this.stockCount === -1 || this.stockCount > 0;
};

rewardItemSchema.methods.isRedeemable = function () {
  return this.status === 'active' && this.inStock();
};

rewardItemSchema.methods.userRedeemCount = function (userId) {
  if (!userId) return 0;
  return this.redeemedBy.filter((r) => r.userId?.toString() === userId.toString()).length;
};

module.exports = mongoose.model('RewardItem', rewardItemSchema);
