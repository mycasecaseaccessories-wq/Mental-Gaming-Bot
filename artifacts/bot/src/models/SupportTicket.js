/**
 * SupportTicket model — enhanced with assignedAdmin, screenshots, archive, subject.
 */

const mongoose = require('mongoose');

const replySchema = new mongoose.Schema({
  from:      { type: String, enum: ['admin', 'user'], required: true },
  message:   { type: String, required: true },
  adminId:   { type: Number, default: null },
  timestamp: { type: Date,   default: Date.now },
});

const supportTicketSchema = new mongoose.Schema(
  {
    ticketId: {
      type: String,
      required: true,
      unique: true,
      comment: 'Short readable ID e.g. TKT-A3B9',
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    telegramId: { type: Number, required: true, index: true },
    username:   { type: String, default: null },

    subject: {
      type: String,
      default: null,
      comment: 'Optional one-line subject extracted from message',
    },

    topic: {
      type: String,
      enum: ['order', 'payment', 'game', 'bug', 'general'],
      required: true,
    },
    userMessage: { type: String, required: true },

    screenshots: {
      type: [String],
      default: [],
      comment: 'Telegram file_ids of screenshots attached by user',
    },

    aiResponse: {
      type: String,
      default: null,
      comment: 'The AI answer shown to user before escalation',
    },

    status: {
      type: String,
      enum: ['Open', 'InProgress', 'Resolved', 'Closed'],
      default: 'Open',
      index: true,
    },

    // ── Assignment ────────────────────────────────────────────────────────────
    assignedAdmin: {
      type: Number,
      default: null,
      comment: 'Telegram ID of admin who claimed this ticket',
    },
    assignedAt: { type: Date, default: null },

    replies:    { type: [replySchema], default: [] },

    resolvedBy: { type: Number, default: null },
    priority:   { type: String, enum: ['Normal', 'High', 'Urgent'], default: 'Normal' },

    // ── Archive ───────────────────────────────────────────────────────────────
    isArchived:  { type: Boolean, default: false, index: true },
    archivedAt:  { type: Date,    default: null },
    archivedBy:  { type: Number,  default: null },
  },
  { timestamps: true, versionKey: false }
);

supportTicketSchema.index({ status: 1, createdAt: -1 });
supportTicketSchema.index({ assignedAdmin: 1, status: 1 });

supportTicketSchema.statics.generateId = async function () {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  let attempts = 0;
  do {
    const rand = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    id = `TKT-${rand}`;
    if (++attempts > 20) throw new Error('Could not generate unique ticket ID');
  } while (await this.findOne({ ticketId: id }));
  return id;
};

module.exports = mongoose.model('SupportTicket', supportTicketSchema);
