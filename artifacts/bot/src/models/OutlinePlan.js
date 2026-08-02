/**
 * OutlinePlan — paid VPN key plans that users can purchase.
 */
const mongoose = require('mongoose');

const outlinePlanSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    // Price in KS (Kyat Store)
    priceKs: {
      type: Number,
      required: true,
      min: 0,
    },
    // Data cap in GB (null = unlimited)
    dataLimitGb: {
      type: Number,
      default: null,
    },
    // Duration in days (null = no expiry)
    durationDays: {
      type: Number,
      default: null,
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

outlinePlanSchema.index({ isActive: 1, displayOrder: 1 });

outlinePlanSchema.statics.getActive = function () {
  return this.find({ isActive: true }).sort({ displayOrder: 1, priceKs: 1 });
};

module.exports = mongoose.model('OutlinePlan', outlinePlanSchema);
