const mongoose = require('mongoose');

/**
 * RedeemCode — an app-style gift/redemption code.
 *
 * A user enters a code and receives the reward it grants. Each code grants
 * ONE of:
 *   - product : a specific store Product (delivered via an Order; free to user)
 *   - coupon  : a personal discount code (a Promo restricted to the redeemer)
 *
 * Distinct from Promo: a Promo is a checkout discount the user applies to an
 * order; a RedeemCode directly hands the user a reward.
 */
const redeemCodeSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },
    description: { type: String, default: '' },

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
    couponValue:        { type: Number, default: null },
    couponMinOrder:     { type: Number, default: 0 },
    couponExpiryDays:   { type: Number, default: null },

    // ── limits ────────────────────────────────────────────────────────────────
    maxUses:      { type: Number, default: null, comment: 'null = unlimited total uses' },
    currentUses:  { type: Number, default: 0 },
    perUserLimit: { type: Number, default: 1, comment: 'max redemptions per user' },
    expiryDate:   { type: Date, default: null, comment: 'null = never expires' },

    usedBy: [
      {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        at:     { type: Date, default: Date.now },
      },
    ],

    isActive:  { type: Boolean, default: true },
    createdBy: { type: Number, default: null, comment: 'Admin Telegram ID' },
  },
  { timestamps: true, versionKey: false }
);

redeemCodeSchema.index({ isActive: 1, expiryDate: 1 });

redeemCodeSchema.methods.isValid = function () {
  if (!this.isActive) return false;
  if (this.expiryDate && new Date() > this.expiryDate) return false;
  if (this.maxUses !== null && this.currentUses >= this.maxUses) return false;
  return true;
};

redeemCodeSchema.methods.userUseCount = function (userId) {
  if (!userId) return 0;
  return this.usedBy.filter((u) => u.userId?.toString() === userId.toString()).length;
};

module.exports = mongoose.model('RedeemCode', redeemCodeSchema);
