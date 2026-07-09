/**
 * GameNews — knowledge entries captured from the game-updates channel.
 * Every text/caption post in SystemStatus.gameNewsChannelId is stored here
 * and injected into the support AI prompt as game knowledge.
 */

const mongoose = require('mongoose');

const gameNewsSchema = new mongoose.Schema(
  {
    chatId:    { type: String, required: true },
    messageId: { type: Number, required: true },
    text:      { type: String, required: true, maxlength: 4000 },
    postedAt:  { type: Date, default: Date.now },
  },
  { timestamps: true, versionKey: false }
);

gameNewsSchema.index({ chatId: 1, messageId: 1 }, { unique: true });
gameNewsSchema.index({ text: 'text' });
gameNewsSchema.index({ postedAt: -1 });

module.exports = mongoose.model('GameNews', gameNewsSchema);
