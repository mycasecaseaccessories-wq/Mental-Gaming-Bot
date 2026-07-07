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
    perUserLimit: {
      type: Number,
      default: 1,
      min: 1,
      comment: 'Max times a single account may use this code',
    },
    scopeType: {
      type: String,
      enum: ['all', 'category', 'product'],
      default: 'all',
      comment: 'Which products this code applies to',
    },
    scopeCategories: {
      type: [String],
      default: () => [],
      comment: 'Category names (when scopeType = category)',
    },
    scopeProducts: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'Product',
      default: () => [],
      comment: 'Product IDs (when scopeType = product)',
    },
    source: {
      type: String,
      enum: ['admin', 'topup', 'reward'],
      default: 'admin',
      comment: 'How this promo was created',
    },
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
  return this.userUseCount(userId) >= (this.perUserLimit || 1);
};

promoSchema.methods.userUseCount = function (userId) {
  return this.usedBy.filter((u) => u.userId?.toString() === userId?.toString()).length;
};

/** true if this promo applies to the given product (id + category). No product info = pass. */
promoSchema.methods.appliesToProduct = function ({ productId, category } = {}) {
  const scope = this.scopeType || 'all';
  if (scope === 'all') return true;
  if (scope === 'category') {
    if (!category) return false;
    return (this.scopeCategories || []).some((c) => c.toLowerCase() === String(category).toLowerCase());
  }
  if (scope === 'product') {
    if (!productId) return false;
    return (this.scopeProducts || []).some((p) => p.toString() === productId.toString());
  }
  return true;
};

module.exports = mongoose.model('Promo', promoSchema);
