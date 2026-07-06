/**
 * Quick-Reply Template — pre-written admin messages for common scenarios.
 */

const mongoose = require('mongoose');

const CATEGORIES = ['order', 'payment', 'warning', 'general'];

const templateSchema = new mongoose.Schema(
  {
    name:       { type: String, required: true, trim: true },
    content:    { type: String, required: true },
    category:   { type: String, enum: CATEGORIES, default: 'general' },
    createdBy:  { type: Number, required: true },
    isActive:   { type: Boolean, default: true },
    usageCount: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false }
);

templateSchema.statics.CATEGORIES = CATEGORIES;

module.exports = mongoose.model('Template', templateSchema);
