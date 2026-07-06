/**
 * FAQ model — Dynamic FAQ library with inline search and optional video tutorials.
 *
 * Search: MongoDB text index on question + answer + tags.
 * Video:  videoId = Telegram file_id (type='telegram') or URL (type='url')
 */

const mongoose = require('mongoose');

const FAQ_CATEGORIES = ['general', 'order', 'payment', 'game', 'account', 'promo'];

const faqSchema = new mongoose.Schema(
  {
    faqId: {
      type: String,
      required: true,
      unique: true,
      comment: 'Short human-readable ID e.g. FAQ-A1B2',
    },
    question: { type: String, required: true, trim: true },
    answer:   { type: String, required: true, trim: true },
    tags:     { type: [String], default: [], index: true },
    category: {
      type: String,
      enum: FAQ_CATEGORIES,
      default: 'general',
      index: true,
    },

    // ── Video tutorial ────────────────────────────────────────────────────────
    videoId: {
      type: String,
      default: null,
      comment: 'Telegram file_id or YouTube URL',
    },
    videoType: {
      type: String,
      enum: ['telegram', 'url', null],
      default: null,
    },
    videoCaption: {
      type: String,
      default: null,
    },

    isActive:   { type: Boolean, default: true,  index: true },
    viewCount:  { type: Number,  default: 0, min: 0 },
    sortOrder:  { type: Number,  default: 0 },
    addedBy:    { type: Number,  default: null, comment: 'Admin telegramId' },
  },
  { timestamps: true, versionKey: false }
);

// ── Text search index ─────────────────────────────────────────────────────────
faqSchema.index({ question: 'text', answer: 'text', tags: 'text' }, { weights: { question: 10, tags: 5, answer: 1 } });
faqSchema.index({ category: 1, isActive: 1, sortOrder: 1 });

faqSchema.statics.FAQ_CATEGORIES = FAQ_CATEGORIES;

faqSchema.statics.generateId = async function () {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  let attempts = 0;
  do {
    const rand = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    id = `FAQ-${rand}`;
    if (++attempts > 20) throw new Error('Could not generate unique FAQ ID');
  } while (await this.findOne({ faqId: id }));
  return id;
};

module.exports = mongoose.model('FAQ', faqSchema);
