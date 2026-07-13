/**
 * AccountGiveawayClaim — one claim record per user per giveaway.
 * Created FIRST (claim-record-first pattern) so the unique index blocks
 * double-claims even under concurrent taps; rolled back if delivery fails.
 */
const mongoose = require('mongoose');

const accountGiveawayClaimSchema = new mongoose.Schema(
  {
    giveawayId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AccountGiveaway',
      required: true,
    },
    telegramId: {
      type: Number,
      required: true,
    },
    credentialId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AccountCredential',
      default: null,
    },
    // Multi-slot (shared/invite) account claims record the per-buyer sale here.
    slotId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AccountSlot',
      default: null,
    },
    // Shop-product claims hand out a personal 100%-off coupon instead of stock.
    couponId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Promo',
      default: null,
    },
  },
  { timestamps: true, versionKey: false }
);

accountGiveawayClaimSchema.index({ giveawayId: 1, telegramId: 1 }, { unique: true });

module.exports = mongoose.model('AccountGiveawayClaim', accountGiveawayClaimSchema);
