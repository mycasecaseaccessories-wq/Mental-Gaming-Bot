/**
 * Review model — post-order feedback and public review wall.
 *
 * Lifecycle:
 *   1. FeedbackService detects a 'Success' order 24h old → creates a placeholder (no rating)
 *   2. Bot sends rating request to user
 *   3. User clicks star rating → rating saved
 *   4. If rating ≥ 4, ask for optional comment
 *   5. If rating ≥ 4 + has comment → forwardedToChannel = true → published to review channel
 */

const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    telegramId:  { type: Number, required: true, index: true },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
      unique: true,
      comment: 'One review per order',
    },
    productName: { type: String, default: 'Unknown Product' },

    // ── Rating ────────────────────────────────────────────────────────────────
    rating:  { type: Number, min: 1, max: 5, default: null },
    comment: { type: String, default: null, trim: true, maxlength: 500 },
    skipped: { type: Boolean, default: false, comment: 'User dismissed the rating prompt' },

    // ── Publication ───────────────────────────────────────────────────────────
    isPublic:           { type: Boolean, default: false, comment: '≥4 stars → public' },
    forwardedToChannel: { type: Boolean, default: false },
    channelMessageId:   { type: Number,  default: null },

    // ── AI Sentiment Analysis ─────────────────────────────────────────────────
    sentimentLabel: {
      type:    String,
      enum:    ['positive', 'neutral', 'negative'],
      default: null,
      index:   true,
    },
    sentimentAnalyzedAt: { type: Date, default: null },

    // ── Timing ────────────────────────────────────────────────────────────────
    feedbackRequestSentAt: { type: Date, default: null },
    respondedAt:           { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

reviewSchema.index({ isPublic: 1, rating: -1, createdAt: -1 });
reviewSchema.index({ telegramId: 1, createdAt: -1 });

module.exports = mongoose.model('Review', reviewSchema);
