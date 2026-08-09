/**
 * LiveFeedDelivery — durable idempotency marker for public activity posts.
 *
 * One record is created per event/channel pair before sending. The unique
 * index prevents duplicate posts after callback retries or bot restarts.
 * Failed sends remove their marker so a later attempt can retry safely.
 */
const mongoose = require('mongoose');

const liveFeedDeliverySchema = new mongoose.Schema(
  {
    eventKey: { type: String, required: true },
    channelId: { type: String, required: true },
    eventType: { type: String, required: true },
    sentAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

liveFeedDeliverySchema.index({ eventKey: 1, channelId: 1 }, { unique: true });

module.exports = mongoose.model('LiveFeedDelivery', liveFeedDeliverySchema);