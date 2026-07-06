const mongoose = require('mongoose');

const paymentMethodSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      comment: 'e.g. KBZ Pay, Wave Money, AYA Pay',
    },
    shortCode: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      comment: 'e.g. KPAY, WAVE, AYA, CB',
    },
    accountName: {
      type: String,
      required: true,
      trim: true,
    },
    accountNumber: {
      type: String,
      required: true,
      trim: true,
    },
    emoji: {
      type: String,
      default: '💳',
    },
    instructions: {
      type: String,
      default: 'Transfer the exact amount and upload your screenshot.',
    },
    qrImageUrl: {
      type: String,
      default: null,
      comment: 'Telegram file_id or URL for QR code image',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    displayOrder: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true, versionKey: false }
);

paymentMethodSchema.statics.getActive = function () {
  return this.find({ isActive: true }).sort({ displayOrder: 1, name: 1 });
};

module.exports = mongoose.model('PaymentMethod', paymentMethodSchema);
