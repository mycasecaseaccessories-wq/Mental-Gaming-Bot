/**
 * NotificationService — Create in-app notifications for users.
 *
 * Called by OrderService, FeedbackService, admin broadcast, etc.
 * Mini App reads via GET /api/store/notifications.
 */

const Notification = require('../models/Notification');
const User         = require('../models/User');

// ── Factory helpers ───────────────────────────────────────────────────────────

async function _create(telegramId, { type, title, body = null, imageUrl = null, targetType = 'none', targetId = null }) {
  try {
    const user = await User.findByTelegramId(telegramId);
    if (!user) return null;
    return await Notification.create({
      userId: user._id,
      telegramId: Number(telegramId),
      type,
      title,
      body,
      imageUrl,
      targetType,
      targetId,
    });
  } catch (err) {
    console.error('[NotificationService] create error:', err.message);
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

async function notifyOrderCompleted(telegramId, { orderId, productName, amount }) {
  return _create(telegramId, {
    type:       'order_completed',
    title:      '✅ Order Completed',
    body:       `Your order for *${productName}* (${amount.toLocaleString()} KS) has been completed.`,
    targetType: 'order',
    targetId:   String(orderId),
  });
}

async function notifyOrderCancelled(telegramId, { orderId, productName, reason = null }) {
  return _create(telegramId, {
    type:       'order_cancelled',
    title:      '❌ Order Cancelled',
    body:       `Your order for *${productName}* was cancelled.${reason ? ` Reason: ${reason}` : ''}`,
    targetType: 'order',
    targetId:   String(orderId),
  });
}

async function notifyRefundCompleted(telegramId, { orderId, productName, amount }) {
  return _create(telegramId, {
    type:       'refund_completed',
    title:      '💰 Refund Processed',
    body:       `${amount.toLocaleString()} KS has been refunded to your wallet for *${productName}*.`,
    targetType: 'order',
    targetId:   String(orderId),
  });
}

async function notifyPromotion(telegramId, { title, body, imageUrl = null, targetType = 'shop', targetId = null }) {
  return _create(telegramId, {
    type: 'new_promotion',
    title,
    body,
    imageUrl,
    targetType,
    targetId,
  });
}

async function notifyRewardUnlocked(telegramId, { featureName }) {
  return _create(telegramId, {
    type:       'reward_unlocked',
    title:      '🎉 Feature Unlocked!',
    body:       `*${featureName}* is now available for you!`,
    targetType: 'none',
  });
}

async function notifyReviewReward(telegramId, { amount }) {
  return _create(telegramId, {
    type:       'review_reward',
    title:      '🪙 Review Reward',
    body:       `Thank you for your review! You earned *${amount} Mental Coins*.`,
    targetType: 'none',
  });
}

/**
 * Broadcast system announcement to all active users.
 * @param {string} title
 * @param {string} body
 * @param {number} batchSize  - users per batch (default 100)
 */
async function broadcastAnnouncement(title, body, { batchSize = 100 } = {}) {
  try {
    let page = 0;
    let total = 0;
    while (true) {
      const users = await User.find({ isBlocked: false })
        .skip(page * batchSize)
        .limit(batchSize)
        .select('_id telegramId');
      if (!users.length) break;

      const docs = users.map((u) => ({
        userId:     u._id,
        telegramId: u.telegramId,
        type:       'system_announcement',
        title,
        body,
        targetType: 'none',
        targetId:   null,
        isRead:     false,
      }));
      await Notification.insertMany(docs, { ordered: false });
      total += docs.length;
      page++;
    }
    return total;
  } catch (err) {
    console.error('[NotificationService] broadcastAnnouncement error:', err.message);
    return 0;
  }
}

/**
 * Get unread count for a user (fast).
 */
async function getUnreadCount(telegramId) {
  try {
    return await Notification.countDocuments({ telegramId: Number(telegramId), isRead: false });
  } catch {
    return 0;
  }
}

module.exports = {
  notifyOrderCompleted,
  notifyOrderCancelled,
  notifyRefundCompleted,
  notifyPromotion,
  notifyRewardUnlocked,
  notifyReviewReward,
  broadcastAnnouncement,
  getUnreadCount,
};
