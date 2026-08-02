/**
 * OutlineKey — tracks every VPN key issued through this bot.
 * Links an Outline server key to a Telegram user and a plan (or free config).
 */
const mongoose = require('mongoose');

const outlineKeySchema = new mongoose.Schema(
  {
    // Reference to OutlineServer doc
    serverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'OutlineServer',
      required: true,
    },
    // Key ID returned by the Outline API (string)
    keyId: {
      type: String,
      required: true,
    },
    // Display name for this key
    name: {
      type: String,
      default: '',
    },
    // Telegram user ID of the owner
    telegramId: {
      type: Number,
      required: true,
    },
    // Mongo user doc ID
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    // Outline plan doc ID (null = free key)
    planId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'OutlinePlan',
      default: null,
    },
    isFree: {
      type: Boolean,
      default: false,
    },
    // Data cap in GB (null = unlimited)
    dataLimitGb: {
      type: Number,
      default: null,
    },
    // When the key expires (null = no expiry)
    expiresAt: {
      type: Date,
      default: null,
    },
    isDisabled: {
      type: Boolean,
      default: false,
    },
    // The ss:// access URL fetched at creation time (may become stale)
    accessUrl: {
      type: String,
      default: '',
    },
  },
  { timestamps: true, versionKey: false }
);

outlineKeySchema.index({ telegramId: 1 });
outlineKeySchema.index({ serverId: 1, keyId: 1 }, { unique: true });

// Active (non-disabled, non-expired) keys for a user
outlineKeySchema.statics.findActiveByUser = function (telegramId) {
  return this.find({
    telegramId,
    isDisabled: false,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  }).populate('serverId').populate('planId');
};

// All free active keys for a user (for quota enforcement)
outlineKeySchema.statics.countActiveFreeByUser = async function (telegramId) {
  return this.countDocuments({
    telegramId,
    isFree: true,
    isDisabled: false,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  });
};

// Keys that are expired and not yet disabled (for the cron job)
outlineKeySchema.statics.findExpiredActive = function () {
  return this.find({
    isDisabled: false,
    expiresAt: { $ne: null, $lte: new Date() },
  }).populate('serverId');
};

module.exports = mongoose.model('OutlineKey', outlineKeySchema);
