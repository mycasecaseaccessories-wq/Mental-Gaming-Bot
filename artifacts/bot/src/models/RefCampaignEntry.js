/**
 * RefCampaignEntry — per-user progress inside one RefCampaign.
 * countedRefs resets by -requiredRefs each time a reward is claimed.
 * Entries become irrelevant when the campaign ends (fresh start next campaign).
 */
const mongoose = require('mongoose');

const refCampaignEntrySchema = new mongoose.Schema(
  {
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'RefCampaign', required: true, index: true },
    userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    telegramId: { type: Number, required: true },

    countedRefs:    { type: Number, default: 0, comment: 'Refs counted toward next reward' },
    totalRefs:      { type: Number, default: 0, comment: 'All refs counted in this campaign' },
    rewardsClaimed: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false }
);

refCampaignEntrySchema.index({ campaignId: 1, telegramId: 1 }, { unique: true });

module.exports = mongoose.model('RefCampaignEntry', refCampaignEntrySchema);
