/**
 * ChannelAutoPost — admin-configured promotional auto-posts.
 *
 * Each document = one scheduled post that the bot pushes to a Telegram
 * channel at a fixed local-time slot (Myanmar Time, HH:MM 24h).
 *
 * Tick:
 *   CronService runs ChannelAutoPostService.runDuePosts() every 10 minutes;
 *   posts whose scheduledHour:scheduledMinute matches "now in MMT" and
 *   that haven't been sent today (MST date) are dispatched.
 */

const mongoose = require('mongoose');

const channelAutoPostSchema = new mongoose.Schema(
  {
    channelId:       { type: String, required: true },          // chat id (e.g. -1001234567890) or @username
    channelLabel:    { type: String, default: '' },             // free-form label for admin display
    title:           { type: String, default: '' },             // optional bold header
    body:            { type: String, required: true },          // markdown body
    scheduledHour:   { type: Number, required: true, min: 0, max: 23 },
    scheduledMinute: { type: Number, default: 0, min: 0, max: 59 },
    isActive:        { type: Boolean, default: true },
    lastSentDate:    { type: String, default: null },           // 'YYYY-MM-DD' MST
    lastSentAt:      { type: Date,   default: null },
    sendCount:       { type: Number, default: 0 },
    createdBy:       { type: Number, default: null },           // telegram id
  },
  { timestamps: true, versionKey: false }
);

channelAutoPostSchema.index({ isActive: 1, scheduledHour: 1, scheduledMinute: 1 });

module.exports = mongoose.model('ChannelAutoPost', channelAutoPostSchema);
