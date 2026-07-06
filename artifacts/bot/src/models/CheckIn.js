const mongoose = require('mongoose');

const checkInSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    telegramId: {
      type: Number,
      required: true,
      index: true,
    },
    date: {
      type: String,
      required: true,
      comment: 'YYYY-MM-DD in Myanmar Time (UTC+6:30)',
    },
    streakDay: {
      type: Number,
      required: true,
      comment: 'Which day of the streak this was (1-7+)',
    },
    coinReward: { type: Number, default: 0 },
    ksReward:   { type: Number, default: 0 },
    isMilestone: {
      type: Boolean,
      default: false,
      comment: 'True for day 7, 14, 30 milestones',
    },
    milestoneLabel: { type: String, default: null },
  },
  { timestamps: true, versionKey: false }
);

// Unique: one check-in per user per day
checkInSchema.index({ userId: 1, date: 1 }, { unique: true });
checkInSchema.index({ telegramId: 1, date: 1 });

checkInSchema.statics.getMonthRecords = function (userId, year, month) {
  // month = 1-12
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const end   = `${year}-${String(month).padStart(2, '0')}-31`;
  return this.find({ userId, date: { $gte: start, $lte: end } }).sort({ date: 1 });
};

module.exports = mongoose.model('CheckIn', checkInSchema);
