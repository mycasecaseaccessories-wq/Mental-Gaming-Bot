/**
 * WebhookEvent — Stores incoming webhook notifications from external providers
 * and payment gateways.
 *
 * Written by the API server (native MongoDB driver).
 * Processed by WebhookProcessor watcher in the bot.
 *
 * Status lifecycle:  pending → processing → processed | failed | ignored
 */

const mongoose = require('mongoose');

const webhookEventSchema = new mongoose.Schema(
  {
    // ── Source identification ──────────────────────────────────────────────────
    source: {
      type: String,
      enum: ['smileone', 'unipin', 'codashop', 'kpay', 'wave', 'ayapay', 'manual', 'unknown'],
      default: 'unknown',
      index: true,
    },
    eventType: {
      type: String,
      required: true,
      index: true,
      comment: 'e.g. payment.completed | topup.delivered | topup.failed',
    },

    // ── Payload ────────────────────────────────────────────────────────────────
    payload:     { type: mongoose.Schema.Types.Mixed, default: {} },
    rawBody:     { type: String,  default: null, comment: 'Original raw body for signature re-verification' },
    signature:   { type: String,  default: null },
    ipAddress:   { type: String,  default: null },

    // ── Resolution ─────────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ['pending', 'processing', 'processed', 'failed', 'ignored'],
      default: 'pending',
      index: true,
    },
    orderId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null, index: true },
    externalRef: { type: String, default: null, comment: 'Provider transaction ID' },

    // ── Processing result ──────────────────────────────────────────────────────
    processedAt: { type: Date,   default: null },
    error:       { type: String, default: null },
    retryCount:  { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false }
);

webhookEventSchema.index({ status: 1, createdAt: 1 });
webhookEventSchema.index({ externalRef: 1 }, { sparse: true });

module.exports = mongoose.model('WebhookEvent', webhookEventSchema);
