/**
 * RefCampaignEntry — per-user progress inside one RefCampaign.
 * countedRefs resets by -requiredRefs each time a reward is claimed.
 * Entries become irrelevant when the campaign ends (fresh start next campaign).
 */
const mongoose = require('mongoose');

const campaignParticipantSchema = new mongoose.Schema({
  refereeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  telegramId: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'qualified', 'rejected'], default: 'pending' },
  joinedAt: { type: Date, default: Date.now },
  topupAmount: { type: Number, default: 0 },
  reason: { type: String, default: null },
  lastNotifiedAt: { type: Date, default: null },
}, { _id: false });

const refCampaignEntrySchema = new mongoose.Schema(
  {
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'RefCampaign', required: true, index: true },
    userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    telegramId: { type: Number, required: true },

    countedRefs:    { type: Number, default: 0, comment: 'Refs counted toward next reward' },
    totalRefs:      { type: Number, default: 0, comment: 'All refs counted in this campaign' },
    dailyInviteDate: { type: String, default: null, comment: 'Myanmar calendar date used for daily invite quota' },
    dailyInviteCount: { type: Number, default: 0, comment: 'Qualified referrals counted on dailyInviteDate' },
    rewardsClaimed: { type: Number, default: 0 },
    participants: { type: [campaignParticipantSchema], default: [] },
  },
  { timestamps: true, versionKey: false }
);

refCampaignEntrySchema.index({ campaignId: 1, telegramId: 1 }, { unique: true });
refCampaignEntrySchema.index({ campaignId: 1, 'participants.telegramId': 1 });

module.exports = mongoose.model('RefCampaignEntry', refCampaignEntrySchema);
