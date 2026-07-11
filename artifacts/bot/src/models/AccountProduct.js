/**
 * AccountProduct — premium account offerings (e.g. ExpressVPN 1-Month).
 * Separate from the game top-up Product system by design.
 */
const mongoose = require('mongoose');

const accountProductSchema = new mongoose.Schema(
  {
    serviceName: {
      type: String,
      required: true,
      trim: true,
      comment: 'e.g. ExpressVPN, Netflix, Spotify',
    },
    planLabel: {
      type: String,
      required: true,
      trim: true,
      comment: 'e.g. 1 Month Premium, 30-Day Plan',
    },
    emoji: {
      type: String,
      default: '🔐',
    },
    price: {
      type: Number,
      required: true,
      min: 0,
      comment: 'Base price in KS',
    },
    discountPercent: {
      type: Number,
      default: 0,
      min: 0,
      max: 90,
      comment: 'Discount applied at checkout (0 = none)',
    },
    durationDays: {
      type: Number,
      required: true,
      min: 1,
      comment: 'Account validity in days, counted from purchase time',
    },

    // ── Account type ──────────────────────────────────────────────────────────
    // single = one login/password per buyer (classic)
    // shared = one login/password shared by up to `slotsPerUnit` devices
    // invite = one invite link (URL) shared by up to `slotsPerUnit` members
    accountType: {
      type: String,
      enum: ['single', 'shared', 'invite'],
      default: 'single',
    },
    // For shared/invite: how many devices/members each credential (account/link)
    // can serve. For single this stays 1. Price is charged PER slot for
    // shared/invite (buyer picks how many devices/members to buy).
    slotsPerUnit: {
      type: Number,
      default: 1,
      min: 1,
      comment: 'Devices per account (shared) / members per link (invite)',
    },

    description: {
      type: String,
      default: '',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    displayOrder: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true, versionKey: false }
);

accountProductSchema.index({ isActive: 1, displayOrder: 1 });

accountProductSchema.methods.finalPrice = function () {
  return Math.max(0, Math.round(this.price * (1 - (this.discountPercent || 0) / 100)));
};

accountProductSchema.statics.getActive = function () {
  return this.find({ isActive: true }).sort({ displayOrder: 1, serviceName: 1 });
};

module.exports = mongoose.model('AccountProduct', accountProductSchema);
