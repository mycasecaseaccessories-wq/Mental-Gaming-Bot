/**
 * ScreenshotStore — payment screenshot bytes stored in MongoDB.
 *
 * Telegram file_ids are only usable by the bot that received the photo.
 * Since dev (Replit) and prod (VPS) run different bot tokens against the
 * same database, we persist the actual image bytes so ANY bot instance
 * can re-send the screenshot. TTL: 60 days (matches topup review window).
 */

const mongoose = require('mongoose');

const screenshotStoreSchema = new mongoose.Schema(
  {
    txId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      comment: 'Transaction txId this screenshot belongs to',
    },
    data: {
      type: Buffer,
      required: true,
    },
    contentType: {
      type: String,
      default: 'image/jpeg',
    },
    createdAt: {
      type: Date,
      default: Date.now,
      expires: 60 * 60 * 24 * 60, // auto-delete after 60 days
    },
  },
  { versionKey: false }
);

module.exports = mongoose.model('ScreenshotStore', screenshotStoreSchema);
