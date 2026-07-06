const mongoose = require('mongoose');

const promoSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },
    discountType: {
      type: String,
      enum: ['Flat', 'Percentage'],
      required: true,
      comment: 'Flat = fixed KS off | Percentage = % off',
    },
    value: {
      type: Number,
      required: true,
      min: 0,
      comment: 'Amount in KS (Flat) or percentage (Percentage)',
    },
    maxUses: {
      type: Number,
      default: null,
      comment: 'null = unlimited',
    },
    currentUses: {
      type: Number,
      default: 0,
    },
    expiryDate: {
      type: Date,
      default: null,
      comment: 'null = never expires',
    },
    minOrderAmount: {
      type: Number,
      default: 0,
      comment: 'Minimum order total to use this promo',
    },
    usedBy: [
      {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        usedAt: { type: Date, default: Date.now },
      },
    ],
    restrictedToUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      comment: 'When set, only this user may use the code (personal reward coupons)',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: Number,
      default: null,
      comment: 'Admin Telegram ID',
    },
    description: {
      type: String,
      default: '',
    },
  },
  { timestamps: true, versionKey: false }
);

promoSchema.index({ isActive: 1, expiryDate: 1 });

promoSchema.methods.isValid = function () {
  if (!this.isActive) return false;
  if (this.expiryDate && new Date() > this.expiryDate) return false;
  if (this.maxUses !== null && this.currentUses >= this.maxUses) return false;
  return true;
};

promoSchema.methods.hasUserUsed = function (userId) {
  return this.usedBy.some((u) => u.userId?.toString() === userId?.toString());
};

module.exports = mongoose.model('Promo', promoSchema);
