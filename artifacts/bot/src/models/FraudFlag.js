/**
 * FraudFlag — records each fraud detection event for admin review.
 *
 * Severity:
 *   HIGH    — automatic action taken (commissions frozen)
 *   MEDIUM  — flagged for review, commissions held
 *   LOW     — informational, commissions not affected
 */

const mongoose = require('mongoose');

const FRAUD_TYPES = [
  'SELF_REFERRAL',       // User tried to use their own code
  'CIRCULAR_REFERRAL',   // A referred B and B referred A
  'VELOCITY_ABUSE',      // Too many referrals from one code in 1 hour
  'BOTH_ACCOUNTS_NEW',   // Referrer and referee both created within 10 minutes
  'RAPID_TOPUP',         // Referred user topped up within 2 minutes of joining
  'ADMIN_REVIEW',        // Manually flagged by admin
];

const SEVERITIES = ['HIGH', 'MEDIUM', 'LOW'];

const fraudFlagSchema = new mongoose.Schema(
  {
    referralId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Referral', default: null },
    referrerTid: { type: Number, required: true, index: true },
    refereeTid:  { type: Number, required: true, index: true },
    type:        { type: String, enum: FRAUD_TYPES, required: true },
    severity:    { type: String, enum: SEVERITIES, default: 'MEDIUM' },
    details:     { type: mongoose.Schema.Types.Mixed, default: {} },

    // Admin resolution
    resolved:    { type: Boolean, default: false, index: true },
    resolvedBy:  { type: Number, default: null },
    resolvedAt:  { type: Date,   default: null },
    resolution:  { type: String, enum: ['DISMISSED', 'BLOCKED', 'WARNED', null], default: null },
  },
  { timestamps: true, versionKey: false }
);

fraudFlagSchema.index({ resolved: 1, severity: 1, createdAt: -1 });
fraudFlagSchema.index({ referrerTid: 1, type: 1 });

fraudFlagSchema.statics.FRAUD_TYPES = FRAUD_TYPES;
fraudFlagSchema.statics.SEVERITIES  = SEVERITIES;

module.exports = mongoose.model('FraudFlag', fraudFlagSchema);
