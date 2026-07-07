/**
 * RefCampaign — time-boxed referral campaigns.
 * e.g. "Invite 5 friends → get ExpressVPN 1 month" with per-user and global limits.
 * Only ONE campaign can be active at a time. Ending a campaign discards
 * unfinished progress; a new campaign starts everyone from zero.
 */
const mongoose = require('mongoose');

const refCampaignSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },

    requiredRefs: {
      type: Number,
      required: true,
      min: 1,
      comment: 'Completed referrals needed per reward claim',
    },

    rewardType: {
      type: String,
      enum: ['mc', 'ks', 'product'],
      required: true,
      comment: 'mc = Mental Coins, ks = wallet cash, product = manual delivery by admin',
    },
    rewardAmount: { type: Number, default: 0, comment: 'For mc/ks types' },
    rewardLabel:  { type: String, default: '', comment: 'For product type — e.g. "ExpressVPN 1 Month"' },

    maxInvitesPerUser: {
      type: Number,
      default: 0,
      comment: 'Max referrals counted per user in this campaign (0 = unlimited)',
    },
    maxRewardsPerUser: {
      type: Number,
      default: 1,
      comment: 'Max reward claims per user (0 = unlimited)',
    },
    totalRewardLimit: {
      type: Number,
      default: 0,
      comment: 'Campaign-wide reward quota; campaign auto-ends when reached (0 = unlimited)',
    },
    totalRewardsClaimed: { type: Number, default: 0 },

    minRefereeAgeDays: {
      type: Number,
      default: 0,
      min: 0,
      comment: 'Min estimated Telegram account age (days) of the INVITED user for the ref to count (0 = off). Anti-fraud.',
    },

    isActive:  { type: Boolean, default: true, index: true },
    endedAt:   { type: Date, default: null },
    endReason: { type: String, default: null, comment: 'quota_full | manual' },
  },
  { timestamps: true, versionKey: false }
);

// DB-level guarantee: only ONE active campaign at a time
refCampaignSchema.index(
  { isActive: 1 },
  { unique: true, partialFilterExpression: { isActive: true } }
);

refCampaignSchema.statics.getActive = function () {
  return this.findOne({ isActive: true }).sort({ createdAt: -1 });
};

module.exports = mongoose.model('RefCampaign', refCampaignSchema);
