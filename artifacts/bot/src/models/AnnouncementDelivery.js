const mongoose = require('mongoose');

const announcementDeliverySchema = new mongoose.Schema({
  scheduleId: { type: mongoose.Schema.Types.ObjectId, ref: 'AnnouncementSchedule', default: null, index: true },
  runId: { type: mongoose.Schema.Types.ObjectId, ref: 'AnnouncementRun', default: null, index: true },
  chatId: { type: Number, required: true },
  messageId: { type: Number, required: true },
  destination: { type: String, enum: ['user', 'channel'], required: true },
  deleteAt: { type: Date, default: null, index: true },
  status: { type: String, enum: ['sent', 'deleted', 'failed'], default: 'sent', index: true },
  attempts: { type: Number, default: 0 },
  lastError: { type: String, default: null },
}, { timestamps: true });

announcementDeliverySchema.index({ deleteAt: 1, status: 1 });
announcementDeliverySchema.index({ chatId: 1, messageId: 1 }, { unique: true });

module.exports = mongoose.model('AnnouncementDelivery', announcementDeliverySchema);
