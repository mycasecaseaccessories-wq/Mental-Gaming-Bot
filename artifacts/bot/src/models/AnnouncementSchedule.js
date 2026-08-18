const mongoose = require('mongoose');

const announcementScheduleSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  isActive: { type: Boolean, default: true, index: true },
  targetType: { type: String, enum: ['category', 'product', 'account', 'all'], required: true },
  category: { type: String, default: null, trim: true },
  categories: [{ type: String, trim: true }],
  productIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
  accountProductIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'AccountProduct' }],
  style: { type: String, enum: ['new', 'flash', 'restock', 'price'], default: 'new' },
  frequency: { type: String, enum: ['once', 'hourly', 'every_6_hours', 'daily', 'weekly', 'monthly', 'interval'], required: true },
  intervalMinutes: { type: Number, min: 60, max: 10080, default: null },
  timeZone: { type: String, default: 'Asia/Rangoon' },
  runAt: { type: Date, default: null },
  localHour: { type: Number, min: 0, max: 23, default: null },
  localMinute: { type: Number, min: 0, max: 59, default: 0 },
  monthDay: { type: Number, min: 1, max: 31, default: 1 },
  weekdays: [{ type: Number, min: 0, max: 6 }],
  destination: { type: String, enum: ['users', 'channel', 'both'], default: 'both' },
  retentionSeconds: { type: Number, min: 0, max: 172800, default: 0 },
  lastRunAt: { type: Date, default: null },
  nextRunAt: { type: Date, default: null, index: true },
  lastFingerprint: { type: String, default: null },
  claimedAt: { type: Date, default: null },
  claimToken: { type: String, default: null },
  sendCount: { type: Number, default: 0 },
  failedCount: { type: Number, default: 0 },
  createdBy: { type: Number, required: true },
}, { timestamps: true });

announcementScheduleSchema.index({ isActive: 1, nextRunAt: 1 });

module.exports = mongoose.model('AnnouncementSchedule', announcementScheduleSchema);
