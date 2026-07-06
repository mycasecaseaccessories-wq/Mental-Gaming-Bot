/**
 * OrderArchive — Mirror of Order for completed orders older than 6 months.
 *
 * CronService moves Success/Cancelled/Refunded orders here daily at 3 AM
 * to keep the main `orders` collection lean and fast to query.
 *
 * The archive is read-only — no order processing happens here.
 * Admins can query it via /sysinfo and analytics range queries.
 */

const mongoose = require('mongoose');

const orderArchiveSchema = new mongoose.Schema(
  {
    // ── Original order fields (mirrored from Order) ───────────────────────────
    userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    productId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    amount:        { type: Number, default: 0 },
    originalAmount:{ type: Number, default: null },
    promoCode:     { type: String, default: null },
    promoDiscount: { type: Number, default: 0 },
    tierDiscount:  { type: Number, default: 0 },
    tierDiscountPct:{ type: Number, default: 0 },
    status:        { type: String, enum: ['Success', 'Cancelled', 'Refunded'], index: true },
    productType:   { type: String, enum: ['DirectTopup', 'DigitalCode'], default: 'DirectTopup' },
    gameId:        { type: String, default: null },
    zoneId:        { type: String, default: null },
    gameName:      { type: String, default: null },
    transactionId: { type: String, default: null },
    deliveredData: { type: String, default: null },
    notes:         { type: String, default: '' },
    cancelReason:  { type: String, default: null },
    processedBy:   { type: Number, default: null },
    refundTransactionId: { type: String, default: null },
    timestamp:     { type: Date,   index: true },

    // ── Archive metadata ──────────────────────────────────────────────────────
    archivedAt:    { type: Date, default: Date.now, index: true },
    originalCreatedAt: { type: Date, default: null },
    originalUpdatedAt: { type: Date, default: null },
  },
  { versionKey: false, collection: 'orders_archive' }
);

orderArchiveSchema.index({ userId: 1, status: 1 });
orderArchiveSchema.index({ timestamp: -1 });
orderArchiveSchema.index({ archivedAt: -1 });

module.exports = mongoose.model('OrderArchive', orderArchiveSchema);
