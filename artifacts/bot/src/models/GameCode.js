const mongoose = require('mongoose');

const gameCodeSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
      index: true,
    },
    code: {
      type: String,
      required: true,
      trim: true,
      comment: 'The actual gift card code or digital key',
    },
    isUsed: {
      type: Boolean,
      default: false,
      index: true,
    },
    usedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      default: null,
    },
    usedAt: {
      type: Date,
      default: null,
    },
    addedBy: {
      type: Number,
      default: null,
      comment: 'Admin Telegram ID who added this code',
    },
  },
  { timestamps: true, versionKey: false }
);

gameCodeSchema.index({ productId: 1, isUsed: 1 });

gameCodeSchema.statics.pullCode = async function (productId) {
  const code = await this.findOneAndUpdate(
    { productId, isUsed: false },
    { isUsed: true, usedAt: new Date() },
    { new: true, sort: { createdAt: 1 } }
  );
  return code;
};

gameCodeSchema.statics.countAvailable = function (productId) {
  return this.countDocuments({ productId, isUsed: false });
};

module.exports = mongoose.model('GameCode', gameCodeSchema);
