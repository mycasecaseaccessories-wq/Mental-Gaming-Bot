/**
 * Banner — Promotion banners shown on the Mini App home page.
 *
 * Admin manages via /bannermgr command.
 * Mini App fetches GET /banners → active banners sorted by priority.
 */

const mongoose = require('mongoose');

const bannerSchema = new mongoose.Schema(
  {
    title:       { type: String, required: true, trim: true },
    subtitle:    { type: String, default: null, trim: true },
    imageUrl:    { type: String, default: null },

    targetType: {
      type:    String,
      enum:    ['shop', 'category', 'product', 'url', 'none'],
      default: 'none',
    },
    targetId:   { type: String, default: null },
    buttonText: { type: String, default: null },

    startAt:  { type: Date,    default: null },
    endAt:    { type: Date,    default: null },
    isActive: { type: Boolean, default: true },
    priority: { type: Number,  default: 0 },

    createdBy: { type: Number, default: null },
    updatedBy: { type: Number, default: null },
  },
  { timestamps: true, versionKey: false }
);

bannerSchema.index({ isActive: 1, priority: -1, createdAt: -1 });

bannerSchema.statics.getActive = async function () {
  const now = new Date();
  return this.find({
    isActive: true,
    $or: [{ startAt: null }, { startAt: { $lte: now } }],
  }).where({
    $or: [{ endAt: null }, { endAt: { $gte: now } }],
  }).sort({ priority: -1, createdAt: -1 }).limit(10);
};

module.exports = mongoose.model('Banner', bannerSchema);
