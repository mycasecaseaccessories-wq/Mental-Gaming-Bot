const mongoose = require('mongoose');

const announcementRunSchema = new mongoose.Schema({
  scheduleId: { type: mongoose.Schema.Types.ObjectId, ref: 'AnnouncementSchedule', default: null, index: true },
  trigger: { type: String, enum: ['manual', 'scheduled'], required: true },
  fingerprint: { type: String, default: null, index: true },
  startedAt: { type: Date, default: Date.now },
  completedAt: { type: Date, default: null },
  status: { type: String, enum: ['running', 'completed', 'failed', 'skipped_duplicate'], default: 'running' },
  selectedCount: { type: Number, default: 0 },
  channelSent: { type: Number, default: 0 },
  userSent: { type: Number, default: 0 },
  blocked: { type: Number, default: 0 },
  failed: { type: Number, default: 0 },
  error: { type: String, default: null },
  createdBy: { type: Number, default: null },
}, { timestamps: true });

announcementRunSchema.index({ scheduleId: 1, startedAt: -1 });

module.exports = mongoose.model('AnnouncementRun', announcementRunSchema);
