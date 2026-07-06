/**
 * Notification — In-app notification center for users.
 *
 * Created by bot on order events, promotions, reward unlocks.
 * Mini App fetches GET /notifications → list with unread count.
 */

const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    telegramId: { type: Number, required: true, index: true },

    type: {
      type: String,
      enum: [
        'order_completed',
        'order_cancelled',
        'refund_completed',
        'new_promotion',
        'reward_unlocked',
        'review_reward',
        'system_announcement',
      ],
      required: true,
    },

    title:    { type: String, required: true },
    body:     { type: String, default: null },
    imageUrl: { type: String, default: null },

    targetType: {
      type:    String,
      enum:    ['order', 'product', 'url', 'none'],
      default: 'none',
    },
    targetId: { type: String, default: null },

    isRead: { type: Boolean, default: false, index: true },
    readAt: { type: Date,    default: null },
  },
  { timestamps: true, versionKey: false }
);

notificationSchema.index({ telegramId: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ telegramId: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
