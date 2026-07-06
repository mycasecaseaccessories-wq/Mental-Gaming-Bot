const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['Topup', 'Purchase', 'Refund', 'Bonus', 'Debit', 'AdminCredit', 'AdminDebit'],
      required: true,
    },
    wallet: {
      type: String,
      enum: ['KS', 'Coin'],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      comment: 'Positive = credit, Negative = debit',
    },
    balanceBefore: {
      type: Number,
      required: true,
    },
    balanceAfter: {
      type: Number,
      required: true,
    },
    txId: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
      comment: 'Unique reference ID — prevents duplicate processing',
    },
    status: {
      type: String,
      enum: ['Pending', 'Completed', 'Rejected'],
      default: 'Completed',
    },
    paymentMethod: {
      type: String,
      default: null,
      comment: 'e.g. KPay, Wave, AYA Pay',
    },
    screenshotUrl: {
      type: String,
      default: null,
      comment: 'Telegram file_id of payment screenshot',
    },
    screenshotHash: {
      type: String,
      default: null,
      index: true,
      comment: 'MD5 of file_id — used for duplicate screenshot detection',
    },
    note: {
      type: String,
      default: '',
    },
    processedBy: {
      type: Number,
      default: null,
      comment: 'Admin Telegram ID who approved/rejected',
    },
    rejectionReason: {
      type: String,
      default: null,
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  { versionKey: false }
);

transactionSchema.index({ userId: 1, status: 1 });
transactionSchema.index({ userId: 1, type: 1, timestamp: -1 });

transactionSchema.statics.isDuplicate = async function (txId) {
  if (!txId) return false;
  const existing = await this.findOne({ txId });
  return !!existing;
};

transactionSchema.statics.hasPendingTopup = async function (userId) {
  const pending = await this.findOne({ userId, type: 'Topup', status: 'Pending' });
  return !!pending;
};

module.exports = mongoose.model('Transaction', transactionSchema);
