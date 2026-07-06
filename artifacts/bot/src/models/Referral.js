/**
 * Referral model — 1-level referral with commission-based rewards.
 *
 * Modes (stored in SystemStatus.referralCommissionMode):
 *   'first'  — commission paid once on first successful top-up
 *   'every'  — commission paid on every top-up by referred user
 *
 * Fraud:
 *   isFraudSuspected = true  →  commissions are frozen until admin review
 */

const mongoose = require('mongoose');

const commissionEntrySchema = new mongoose.Schema(
  {
    topupAmount:     { type: Number, required: true },
    commissionRate:  { type: Number, required: true },  // % at time of payment
    commissionKS:    { type: Number, default: 0 },
    commissionCoins: { type: Number, default: 0 },
    paidAt:          { type: Date, default: Date.now },
    txId:            { type: String, default: null },
  },
  { _id: false }
);

const referralSchema = new mongoose.Schema(
  {
    referrerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    refereeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
      comment: 'Each user can only be referred once',
    },
    referralCode: {
      type: String,
      required: true,
      index: true,
    },

    // ── Status ───────────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ['Pending', 'Active', 'Completed', 'Frozen'],
      default: 'Pending',
      comment: 'Pending=joined | Active=first topup done | Completed=first-only mode done | Frozen=fraud hold',
    },

    // ── Commission tracking ───────────────────────────────────────────────────
    commissionMode: {
      type: String,
      enum: ['first', 'every'],
      default: 'first',
      comment: 'Inherited from SystemStatus at time of registration',
    },
    commissionRate: {
      type: Number,
      default: 2,
      comment: 'Percentage of top-up amount (e.g. 2 = 2%)',
    },
    totalCommissionKS:    { type: Number, default: 0 },
    totalCommissionCoins: { type: Number, default: 0 },
    commissionHistory: {
      type: [commissionEntrySchema],
      default: [],
      comment: 'Each entry = one paid commission event',
    },

    // ── Legacy fixed bonuses (kept for backwards compat) ─────────────────────
    bonusPaid:    { type: Boolean, default: false },
    referrerBonus: { ks: { type: Number, default: 0 }, coins: { type: Number, default: 0 } },
    refereeBonus:  { ks: { type: Number, default: 0 }, coins: { type: Number, default: 0 } },
    completedAt:  { type: Date, default: null },
    topupAmount:  { type: Number, default: null },

    // ── Fraud detection ───────────────────────────────────────────────────────
    isFraudSuspected: { type: Boolean, default: false, index: true },
    fraudReason:      { type: String, default: null },
    fraudReviewedBy:  { type: Number, default: null },
    fraudReviewedAt:  { type: Date,   default: null },
  },
  { timestamps: true, versionKey: false }
);

referralSchema.index({ referrerId: 1, status: 1 });
referralSchema.index({ referralCode: 1 });
referralSchema.index({ isFraudSuspected: 1, status: 1 });

module.exports = mongoose.model('Referral', referralSchema);
