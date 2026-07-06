/**
 * FeedbackService — Automated post-order feedback collection and review wall.
 *
 * Watcher lifecycle (runs every 60 minutes):
 *   1. Find 'Success' orders completed 24–48 hours ago with no feedback record
 *   2. Create a placeholder Review document (marks request as sent)
 *   3. Send rating prompt (1–5 stars) to user via bot message
 *
 * Rating flow:
 *   1. User clicks star → rating saved
 *   2. If rating ≥ 3 → ask for optional comment
 *   3. Rating ≥ 4 with comment → forward to configured review channel
 *
 * Channel forwarding:
 *   SystemStatus.feedbackChannelId must be set via /setfeedbackchannel
 */

const { Markup } = require('telegraf');
const Review       = require('../models/Review');
const Order        = require('../models/Order');
const User         = require('../models/User');
const SystemStatus = require('../models/SystemStatus');

const WATCHER_INTERVAL_MS = 60 * 60_000; // 1 hour

// ── Rating request sender ─────────────────────────────────────────────────────

function ratingKeyboard(orderId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('1 ⭐',   `rate:${orderId}:1`),
      Markup.button.callback('2 ⭐⭐',  `rate:${orderId}:2`),
      Markup.button.callback('3 ⭐⭐⭐', `rate:${orderId}:3`),
      Markup.button.callback('4 ⭐⭐⭐⭐',`rate:${orderId}:4`),
      Markup.button.callback('5 ⭐⭐⭐⭐⭐',`rate:${orderId}:5`),
    ],
    [Markup.button.callback('⏭️ Skip for now', `rate:${orderId}:skip`)],
  ]);
}

async function sendFeedbackRequest(telegram, order) {
  const productName = order.productId?.name || 'your order';
  const emoji = order.productId?.category === 'DirectTopup' ? '🎮' : '🎁';

  try {
    await telegram.sendMessage(
      order.userId.telegramId,
      `${emoji} *How was your experience?*\n\n` +
      `You ordered: *${productName}*\n\n` +
      `Your feedback helps us improve the store!\n` +
      `_(Tap a star to rate — takes 10 seconds)_`,
      { parse_mode: 'Markdown', ...ratingKeyboard(order._id.toString()) }
    );
  } catch (err) {
    // User may have blocked the bot — not an error
    if (!err.message?.includes('blocked')) {
      console.error('[FeedbackService] Send failed:', err.message);
    }
  }
}

// ── Main watcher ──────────────────────────────────────────────────────────────

async function checkAndSendFeedback(telegram) {
  try {
    const now          = new Date();
    const cutoffStart  = new Date(now.getTime() - 48 * 3600_000);
    const cutoffEnd    = new Date(now.getTime() - 24 * 3600_000);

    const orders = await Order.find({
      status:    'Success',
      timestamp: { $gte: cutoffStart, $lte: cutoffEnd },
    })
      .populate('userId',    'telegramId username')
      .populate('productId', 'name category')
      .limit(100);

    let sent = 0;
    for (const order of orders) {
      if (!order.userId?.telegramId) continue;

      // Already requested?
      const existing = await Review.findOne({ orderId: order._id });
      if (existing) continue;

      // Create placeholder (marks request as sent)
      await Review.create({
        userId:                order.userId._id,
        telegramId:            order.userId.telegramId,
        orderId:               order._id,
        productName:           order.productId?.name || 'Unknown',
        feedbackRequestSentAt: new Date(),
      });

      await sendFeedbackRequest(telegram, order);
      sent++;
    }

    if (sent > 0) console.log(`[FeedbackService] 📩 Sent ${sent} feedback request(s)`);
  } catch (err) {
    console.error('[FeedbackService] Watcher error:', err.message);
  }
}

// ── Submit rating (called from callback handler) ──────────────────────────────

async function submitRating(orderId, telegramId, rating) {
  const review = await Review.findOne({ orderId, telegramId });
  if (!review) return null;

  review.rating      = rating;
  review.respondedAt = new Date();
  review.isPublic    = rating >= 4;
  await review.save();
  return review;
}

// ── Submit comment (called after rating) ──────────────────────────────────────

async function submitComment(reviewId, comment, telegram) {
  const review = await Review.findById(reviewId);
  if (!review) return null;

  review.comment  = comment.slice(0, 500);
  review.isPublic = (review.rating || 0) >= 4;
  await review.save();

  // Forward to channel if 4-5 stars with comment
  if (review.isPublic && review.comment && !review.forwardedToChannel) {
    await forwardToChannel(review, telegram);
  }

  return review;
}

// ── Forward to public review channel ─────────────────────────────────────────

async function forwardToChannel(review, telegram) {
  if (!telegram) return;

  const status    = await SystemStatus.get();
  const channelId = status.feedbackChannelId;
  if (!channelId) return;

  const stars = '⭐'.repeat(review.rating || 0);
  const user  = await User.findOne({ telegramId: review.telegramId });
  const name  = user?.username ? `@${user.username}` : (user?.first_name || 'Anonymous Customer');

  try {
    const msg = await telegram.sendMessage(
      channelId,
      `${stars} *${review.rating}/5 Stars*\n\n` +
      `_"${review.comment}"_\n\n` +
      `— *${name}*\n` +
      `🛒 ${review.productName}\n\n` +
      `#MentalGamingStore #Review`,
      { parse_mode: 'Markdown' }
    );

    review.forwardedToChannel = true;
    review.channelMessageId   = msg.message_id;
    await review.save();
  } catch (err) {
    console.error('[FeedbackService] Channel forward failed:', err.message);
  }
}

// ── Get public reviews (review wall) ─────────────────────────────────────────

async function getPublicReviews(limit = 10) {
  return Review.find({ isPublic: true, rating: { $gte: 4 }, comment: { $ne: null } })
    .sort({ rating: -1, createdAt: -1 })
    .limit(limit);
}

// ── Get stats ─────────────────────────────────────────────────────────────────

async function getStats() {
  const [total, rated, avg] = await Promise.all([
    Review.countDocuments({ feedbackRequestSentAt: { $ne: null } }),
    Review.countDocuments({ rating: { $ne: null } }),
    Review.aggregate([
      { $match: { rating: { $ne: null } } },
      { $group: { _id: null, avg: { $avg: '$rating' }, fiveStars: { $sum: { $cond: [{ $eq: ['$rating', 5] }, 1, 0] } } } },
    ]),
  ]);

  return {
    total,
    rated,
    responseRate: total ? Math.round((rated / total) * 100) : 0,
    avgRating: avg[0]?.avg ? Math.round(avg[0].avg * 10) / 10 : 0,
    fiveStars: avg[0]?.fiveStars || 0,
  };
}

// ── Watcher starter ───────────────────────────────────────────────────────────

function startFeedbackWatcher(telegram) {
  // Run immediately, then every hour
  checkAndSendFeedback(telegram);
  setInterval(() => checkAndSendFeedback(telegram), WATCHER_INTERVAL_MS);
  console.log('[FeedbackService] ✅ Feedback watcher started');
}

module.exports = {
  startFeedbackWatcher,
  checkAndSendFeedback,
  submitRating,
  submitComment,
  forwardToChannel,
  getPublicReviews,
  getStats,
  ratingKeyboard,
};
