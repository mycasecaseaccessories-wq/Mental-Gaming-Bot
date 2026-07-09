/**
 * ScreenshotService — cross-bot-safe payment screenshot handling.
 *
 * saveScreenshot(telegram, fileId, txId)
 *   Downloads the photo from Telegram and stores the bytes in MongoDB
 *   (best-effort — errors are logged, never thrown).
 *
 * sendScreenshot(telegram, chatId, tx, extra)
 *   Sends the screenshot for a Transaction:
 *     1. try the stored file_id (works on the bot that received it)
 *     2. fall back to the MongoDB-stored bytes (works on ANY bot)
 *   Returns the sent message, or null if no photo could be sent
 *   (caller should then fall back to a text-only message).
 */

const axios = require('axios');
const ScreenshotStore = require('../models/ScreenshotStore');

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB safety cap

async function saveScreenshot(telegram, fileId, txId) {
  if (!fileId || !txId) return false;
  try {
    const link = await telegram.getFileLink(fileId);
    const url = typeof link === 'string' ? link : link.href || link.toString();
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      maxContentLength: MAX_BYTES,
      timeout: 20000,
    });
    await ScreenshotStore.findOneAndUpdate(
      { txId },
      {
        $set: {
          data: Buffer.from(res.data),
          contentType: res.headers['content-type'] || 'image/jpeg',
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );
    return true;
  } catch (err) {
    console.error(`[Screenshot] save failed for ${txId}:`, err.message);
    return false;
  }
}

// Errors that mean "this file_id is unusable by the current bot"
const FILE_ID_ERROR = /wrong file identifier|wrong remote file|file reference|FILE_ID/i;

async function sendScreenshot(telegram, chatId, tx, extra = {}) {
  // 1) Native file_id — fastest, works on the bot that received the photo
  if (tx.screenshotUrl) {
    try {
      return await telegram.sendPhoto(chatId, tx.screenshotUrl, extra);
    } catch (err) {
      if (!FILE_ID_ERROR.test(err.message || '')) {
        // Caption/parse or other non-portability error — buffer retry would fail the same way
        console.error(`[Screenshot] send failed (non-file_id) for ${tx.txId}:`, err.message);
        return null;
      }
      /* file_id belongs to another bot token — try stored bytes */
    }
  }

  // 2) MongoDB-stored bytes — works on any bot instance
  try {
    const stored = await ScreenshotStore.findOne({ txId: tx.txId });
    if (stored?.data?.length) {
      return await telegram.sendPhoto(
        chatId,
        { source: stored.data, filename: `${tx.txId}.jpg` },
        extra
      );
    }
  } catch (err) {
    console.error(`[Screenshot] buffer send failed for ${tx.txId}:`, err.message);
  }

  return null;
}

module.exports = { saveScreenshot, sendScreenshot };
