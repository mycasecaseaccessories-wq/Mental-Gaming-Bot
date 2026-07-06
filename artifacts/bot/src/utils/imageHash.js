/**
 * imageHash — Screenshot Duplicate Detection
 *
 * Strategy:
 *   Telegram assigns a persistent, content-based file_id to every uploaded file.
 *   The same image uploaded multiple times (even by different users) will produce
 *   the same file_id. We use this as a fingerprint.
 *
 *   We also compute an MD5 of the file_id string as the stored hash, so the
 *   system is extensible if you later download and hash actual file bytes.
 *
 * Fraud detection:
 *   - Same screenshot used for multiple top-up requests → FRAUD
 *   - Different user uploads same screenshot → FRAUD
 *   - Same user re-submits own screenshot → DUPLICATE
 */

const crypto = require('crypto');
const Transaction = require('../models/Transaction');

/**
 * Compute a hash from a Telegram file_id.
 * @param {string} fileId
 * @returns {string} MD5 hex digest
 */
function hashFileId(fileId) {
  return crypto.createHash('md5').update(fileId).digest('hex');
}

/**
 * Check if a screenshot (by fileId) has been used in any previous top-up.
 *
 * @param {string} fileId - Telegram file_id of the uploaded photo
 * @param {ObjectId} currentUserId - MongoDB user ID of the uploader
 * @returns {{ isDuplicate: boolean, isFraud: boolean, existingTx: object|null }}
 */
async function checkDuplicateScreenshot(fileId, currentUserId) {
  const hash = hashFileId(fileId);

  // Find any transaction that used this exact file_id (stored as screenshotUrl)
  // OR matching screenshot hash
  const existing = await Transaction.findOne({
    $or: [
      { screenshotUrl: fileId },
      { screenshotHash: hash },
    ],
  }).populate('userId', 'telegramId username');

  if (!existing) return { isDuplicate: false, isFraud: false, existingTx: null, hash };

  const isSameUser = existing.userId?._id?.toString() === currentUserId?.toString();

  return {
    isDuplicate: isSameUser,
    isFraud:     !isSameUser,
    existingTx:  existing,
    hash,
  };
}

/**
 * Notify admin of a suspected fraudulent screenshot reuse.
 */
async function notifyAdminFraud(telegram, uploader, existingTx, hash) {
  const { config } = require('../../config/settings');
  const uploaderTag = uploader.username ? `@${uploader.username}` : `ID: ${uploader.telegramId}`;
  const origUserId  = existingTx.userId?.telegramId || 'unknown';
  const origTag     = existingTx.userId?.username
    ? `@${existingTx.userId.username}`
    : `ID: ${origUserId}`;

  try {
    await telegram.sendMessage(
      config.bot.adminId,
      `🚨 *FRAUD ALERT — Duplicate Screenshot!*\n\n` +
      `⚠️ A screenshot has been reused across multiple top-up requests.\n\n` +
      `*Current Upload:*\n` +
      `👤 User: ${uploaderTag}\n\n` +
      `*Original Submission:*\n` +
      `👤 User: ${origTag}\n` +
      `🆔 TxID: \`${existingTx.txId}\`\n` +
      `💰 Amount: ${existingTx.amount?.toLocaleString()} KS\n\n` +
      `🔑 Hash: \`${hash}\`\n\n` +
      `⚡ _This top-up has been automatically blocked._`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('[ImageHash] Failed to notify admin:', err.message);
  }
}

module.exports = { hashFileId, checkDuplicateScreenshot, notifyAdminFraud };
