/**
 * ProviderLog — Audit trail for all external API calls to game top-up providers.
 *
 * Every outbound request to SmileOne, UniPin, Codashop, etc. is logged here
 * for debugging, cost tracking, and dispute resolution.
 */

const mongoose = require('mongoose');

const providerLogSchema = new mongoose.Schema(
  {
    // ── Request identity ───────────────────────────────────────────────────────
    orderId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null, index: true },
    provider:    { type: String, required: true, index: true }, // 'smileone' | 'unipin' | 'codashop'
    action:      { type: String, required: true },              // 'topup' | 'verifyPlayer' | 'checkBalance'
    externalRef: { type: String, default: null },               // provider's transaction/order ID

    // ── Request payload (sanitised — no secrets) ──────────────────────────────
    requestData: { type: mongoose.Schema.Types.Mixed, default: {} },

    // ── Response ──────────────────────────────────────────────────────────────
    statusCode:   { type: Number, default: null },
    responseData: { type: mongoose.Schema.Types.Mixed, default: {} },
    success:      { type: Boolean, required: true },
    errorMessage: { type: String,  default: null },

    // ── Performance ───────────────────────────────────────────────────────────
    durationMs: { type: Number, default: null },

    // ── Retry tracking ────────────────────────────────────────────────────────
    attempt: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false }
);

providerLogSchema.index({ provider: 1, createdAt: -1 });
providerLogSchema.index({ orderId: 1, provider: 1 });
providerLogSchema.index({ success: 1, createdAt: -1 });

module.exports = mongoose.model('ProviderLog', providerLogSchema);
