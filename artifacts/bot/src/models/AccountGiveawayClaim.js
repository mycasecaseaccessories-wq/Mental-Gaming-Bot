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
  },
  { timestamps: true, versionKey: false }
);

accountGiveawayClaimSchema.index({ giveawayId: 1, telegramId: 1 }, { unique: true });

module.exports = mongoose.model('AccountGiveawayClaim', accountGiveawayClaimSchema);
