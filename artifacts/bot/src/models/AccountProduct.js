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

    // ── Stock-date expiry (opt-in) ────────────────────────────────────────────
    // When true, each credential's lifetime is FIXED and starts the moment it is
    // added to stock (stockExpiresAt = addedAt + durationDays). Buyers receive
    // the REMAINING days, not a fresh durationDays. Expired stock auto-retires.
    stockDateExpiry: {
      type: Boolean,
      default: false,
      comment: 'Count validity from stock-add date instead of purchase date',
    },
    // Aging price tier (only when stockDateExpiry is on): once a credential's
    // remaining days <= agingThresholdDays, it is sold at agingDiscountPercent
    // off the base price (100 = free). 0 threshold = aging tier disabled.
    agingThresholdDays: {
      type: Number,
      default: 0,
      min: 0,
      comment: 'Remaining-days cutoff below which the aging discount applies',
    },
    agingDiscountPercent: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
      comment: 'Discount % for aging (near-expiry) stock (100 = free)',
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

// Price when a credential has reached the aging tier (near-expiry stock).
accountProductSchema.methods.agingPrice = function () {
  return Math.max(0, Math.round(this.price * (1 - (this.agingDiscountPercent || 0) / 100)));
};

// Whether the aging price tier is configured (and applicable) for this product.
accountProductSchema.methods.agingEnabled = function () {
  return !!(this.stockDateExpiry && this.agingThresholdDays > 0 && this.agingDiscountPercent > 0);
};

// Effective per-unit price for a specific credential, honouring the aging tier.
// Falls back to finalPrice() for non stock-date products or fresh stock.
accountProductSchema.methods.priceForCredential = function (cred) {
  const base = this.finalPrice();
  if (!this.agingEnabled() || !cred || !cred.stockExpiresAt) return base;
  const remaining = Math.ceil((new Date(cred.stockExpiresAt).getTime() - Date.now()) / 86400000);
  if (remaining > this.agingThresholdDays) return base;
  return Math.min(base, this.agingPrice());
};

accountProductSchema.statics.getActive = function () {
  return this.find({ isActive: true }).sort({ displayOrder: 1, serviceName: 1 });
};

module.exports = mongoose.model('AccountProduct', accountProductSchema);
