/**
 * JoinReward — "join this channel, get MC" offers (opt-in, NOT force-join).
 * Bot must be admin in the channel so getChatMember verification works.
 */
const mongoose = require('mongoose');

const joinRewardSchema = new mongoose.Schema(
  {
    channelId: {
      type: String,
      required: true,
      trim: true,
      comment: '@username or -100xxxxxxxxxx numeric ID',
    },
    channelLink: { type: String, default: '', comment: 'Public t.me link shown to users' },
    title:       { type: String, required: true, trim: true },
    mcReward:    { type: Number, required: true, min: 1 },
    isActive:    { type: Boolean, default: true, index: true },
    claimCount:  { type: Number, default: 0 },
    addedBy:     { type: Number, default: null },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model('JoinReward', joinRewardSchema);
