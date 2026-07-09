/**
 * AccountGiveaway — free premium-account giveaway config.
 * Only ONE giveaway can be active at a time (partial unique index).
 * Every restriction is individually toggleable from the admin panel.
 */
const mongoose = require('mongoose');

const accountGiveawaySchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AccountProduct',
      required: true,
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

// Only one active giveaway at a time
accountGiveawaySchema.index(
  { isActive: 1 },
  { unique: true, partialFilterExpression: { isActive: true } }
);

accountGiveawaySchema.statics.getActive = function () {
  return this.findOne({ isActive: true }).populate('productId');
};

module.exports = mongoose.model('AccountGiveaway', accountGiveawaySchema);
