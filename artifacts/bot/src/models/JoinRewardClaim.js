/**
 * JoinRewardClaim — one claim per user per JoinReward (unique index).
 */
const mongoose = require('mongoose');

const joinRewardClaimSchema = new mongoose.Schema(
  {
    rewardId:   { type: mongoose.Schema.Types.ObjectId, ref: 'JoinReward', required: true, index: true },
    telegramId: { type: Number, required: true },
    mcGiven:    { type: Number, required: true },
  },
  { timestamps: true, versionKey: false }
);

joinRewardClaimSchema.index({ rewardId: 1, telegramId: 1 }, { unique: true });

module.exports = mongoose.model('JoinRewardClaim', joinRewardClaimSchema);
