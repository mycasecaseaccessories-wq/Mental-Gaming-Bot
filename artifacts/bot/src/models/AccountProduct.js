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
