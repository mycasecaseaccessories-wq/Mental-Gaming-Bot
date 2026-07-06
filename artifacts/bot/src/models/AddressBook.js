const mongoose = require('mongoose');

const addressBookSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    gameName: {
      type: String,
      required: true,
      trim: true,
      comment: 'e.g. Mobile Legends, Free Fire, PUBG',
    },
    gameId: {
      type: String,
      required: true,
      trim: true,
      comment: 'Player ID / UID',
    },
    zoneId: {
      type: String,
      default: null,
      trim: true,
      comment: 'Zone/Server ID (required for Mobile Legends)',
    },
    nickname: {
      type: String,
      default: null,
      trim: true,
      comment: 'User-defined label e.g. "My Main Acc"',
    },
    isDefault: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true, versionKey: false }
);

addressBookSchema.index({ userId: 1, gameName: 1 });

addressBookSchema.statics.getForUser = function (userId, gameName = null) {
  const query = { userId };
  if (gameName) query.gameName = new RegExp(gameName, 'i');
  return this.find(query).sort({ isDefault: -1, createdAt: -1 });
};

addressBookSchema.statics.setDefault = async function (entryId, userId) {
  await this.updateMany({ userId }, { isDefault: false });
  return this.findOneAndUpdate({ _id: entryId, userId }, { isDefault: true }, { new: true });
};

module.exports = mongoose.model('AddressBook', addressBookSchema);
