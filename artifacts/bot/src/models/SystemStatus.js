/**
 * SystemStatus — singleton document storing bot-wide operational settings.
 *
 * Usage:
 *   const status = await SystemStatus.get();           // always returns the one document
 *   await SystemStatus.set({ maintenanceMode: true });  // partial update, auto-creates
 */

const mongoose = require('mongoose');

const SINGLETON_ID = 'global';

const systemStatusSchema = new mongoose.Schema(
  {
    _id: { type: String, default: SINGLETON_ID },

    // ── Maintenance Mode ───────────────────────────────────────────────────────
    maintenanceMode:    { type: Boolean, default: false },
    maintenanceSince:   { type: Date,    default: null },
    maintenanceUntil:   { type: Date,    default: null },
    maintenanceMessage: {
      type:    String,
      default: '🔧 We are performing scheduled maintenance. We\'ll be back shortly!',
    },

    // ── Holiday Mode ───────────────────────────────────────────────────────────
    holidayMode:    { type: Boolean, default: false },
    holidayUntil:   { type: Date,    default: null },
    holidayMessage: {
      type:    String,
      default: '🎉 We are on holiday! You can browse but orders and top-ups are temporarily disabled.',
    },

    // ── Referral Program Config ────────────────────────────────────────────────
    referralEnabled:           { type: Boolean, default: true },
    referralCommissionRate:    { type: Number,  default: 2, min: 0, max: 50 },
    referralCommissionMode:    { type: String,  enum: ['first', 'every'], default: 'first' },
    referralCommissionType:    { type: String,  enum: ['KS', 'Coin', 'Both'], default: 'KS' },
    referralMinTopup:          { type: Number,  default: 1000 },
    referralVelocityLimit:     { type: Number,  default: 10 },
    referralWelcomeBonusKS:    { type: Number,  default: 200 },
    referralWelcomeBonusCoins: { type: Number,  default: 50 },

    // ── Feedback & Review Channel ──────────────────────────────────────────────
    feedbackChannelId: {
      type:    String,
      default: null,
      comment: 'Telegram channel ID or @username where 4-5★ reviews are forwarded',
    },
    feedbackEnabled: {
      type:    Boolean,
      default: true,
      comment: 'Master switch for the automated feedback watcher',
    },

    // ── Payment Gateway Status (admin-controlled, shown to users in /topup) ──
    kpayStatus: { type: String, enum: ['Online', 'Busy', 'Offline'], default: 'Online' },
    waveStatus: { type: String, enum: ['Online', 'Busy', 'Offline'], default: 'Online' },
    ayaStatus:  { type: String, enum: ['Online', 'Busy', 'Offline'], default: 'Online' },
    cbStatus:   { type: String, enum: ['Online', 'Busy', 'Offline'], default: 'Online' },
    gatewayNote: {
      type:    String,
      default: null,
      comment: 'Optional message shown alongside gateway status (e.g. "KPay slow due to bank maintenance")',
    },

    // ── Product Announcement Channel ──────────────────────────────────────────
    announcementChannelId: {
      type:    String,
      default: null,
      comment: 'Channel to forward new product alerts / flash sale announcements',
    },

    // ── Backup Channel ─────────────────────────────────────────────────────────
    backupChannelId: {
      type:    String,
      default: null,
      comment: 'Private channel ID or @username to receive daily encrypted DB backups. Falls back to owner DM.',
    },

    // ── Seasonal Theme Engine ─────────────────────────────────────────────────
    seasonalTheme: {
      type:    String,
      enum:    ['standard', 'thingyan', 'christmas', 'lunarnewyear', 'eid', 'custom'],
      default: 'standard',
      comment: 'Active seasonal/event theme for welcome messages and UI decoration',
    },
    customSeasonEmoji: {
      type:    String,
      default: null,
      comment: 'Emoji for custom season (e.g. 🌸)',
    },
    customSeasonLabel: {
      type:    String,
      default: null,
      comment: 'Display label for custom season (e.g. "Blossom Season")',
    },
    customSeasonGreeting: {
      type:    String,
      default: null,
      comment: 'Custom greeting shown in welcome message',
    },

    // ── Stale-Order Support Prompt ────────────────────────────────────────────
    orderSupportThresholdMinutes: {
      type:    Number,
      default: 30,
      comment: 'Minutes a Pending/Processing order must wait before the [Contact Support] button appears on the tracking card',
    },

    // ── Referral Tier System ──────────────────────────────────────────────────
    referralTiers: {
      type: [{
        minRefs: { type: Number },
        rate:    { type: Number },
        label:   { type: String },
        emoji:   { type: String, default: '🏅' },
      }],
      default: () => [
        { minRefs: 1,  rate: 2, label: 'Bronze', emoji: '🥉' },
        { minRefs: 6,  rate: 3, label: 'Silver', emoji: '🥈' },
        { minRefs: 16, rate: 5, label: 'Gold',   emoji: '🥇' },
      ],
      comment: 'Escalating commission rates based on number of successful referrals',
    },

    // ── Mini App Reply-Keyboard Button ────────────────────────────────────────
    miniAppButtonEnabled: {
      type:    Boolean,
      default: false,
      comment: 'Show a persistent Reply-Keyboard WebApp button at the top of the main menu',
    },
    miniAppButtonText: {
      type:    String,
      default: '🛍️ Mental Gaming Store',
      comment: 'Label shown on the Reply-Keyboard WebApp button',
    },
    miniAppButtonUrl: {
      type:    String,
      default: null,
      comment: 'Override URL for the WebApp button; null = use MINI_APP_URL env var',
    },

    // ── Webhook Security ───────────────────────────────────────────────────────
    webhookSecret: {
      type:    String,
      default: null,
      comment: 'HMAC secret used to verify incoming webhook payloads',
    },
    webhookIpWhitelist: {
      type:    [String],
      default: [],
      comment: 'Extra allowed IPs beyond the env-var WEBHOOK_ALLOWED_IPS list',
    },

    // ── Feature Gate System ───────────────────────────────────────────────────
    featureGateEnabled: {
      type:    Boolean,
      default: true,
      comment: 'Master switch — when true, reward features are locked until unlockTargetUsers is reached',
    },
    unlockTargetUsers: {
      type:    Number,
      default: 500,
      comment: 'Total user count required to auto-unlock reward features',
    },
    // Admin can manually override individual features before target is reached
    manuallyUnlockedFeatures: {
      type:    [String],
      default: [],
      comment: 'Feature IDs force-unlocked by admin regardless of user count',
    },
    manuallyLockedFeatures: {
      type:    [String],
      default: [],
      comment: 'Feature IDs force-locked by admin regardless of user count',
    },

    // ── Mental Coin Exchange Config ───────────────────────────────────────────
    mcRedeemEnabled: {
      type:    Boolean,
      default: false,
      comment: 'Allow users to redeem MC as discount at checkout',
    },
    mcExchangeRate: {
      type:    Number,
      default: 1,
      comment: '1 MC = N KS discount',
    },
    mcMinRedeem: {
      type:    Number,
      default: 500,
      comment: 'Minimum MC required to redeem',
    },
    mcMaxDiscountPct: {
      type:    Number,
      default: 20,
      comment: 'Maximum discount % per order from MC redemption',
    },

    // ── Review MC Reward ──────────────────────────────────────────────────────
    reviewRewardEnabled: {
      type:    Boolean,
      default: false,
      comment: 'Award MC coins when user submits a 4+ star review with comment',
    },
    reviewRewardAmount: {
      type:    Number,
      default: 50,
      comment: 'MC coins awarded per qualifying review',
    },

    // ── Admin Group / Review Channel ──────────────────────────────────────────
    adminGroupId: {
      type:    String,
      default: null,
      comment: 'Telegram group ID for admin notifications',
    },
    reviewChannelId: {
      type:    String,
      default: null,
      comment: 'Alias for feedbackChannelId — review destination channel',
    },
    supportUsername: {
      type:    String,
      default: null,
      comment: '@username of support contact shown to users',
    },

    // ── Meta ───────────────────────────────────────────────────────────────────
    updatedBy: { type: Number, default: null },
  },
  { timestamps: true, versionKey: false }
);

systemStatusSchema.statics.get = async function () {
  let doc = await this.findById(SINGLETON_ID);
  if (!doc) doc = await this.create({ _id: SINGLETON_ID });
  return doc;
};

systemStatusSchema.statics.set = async function (fields, updatedBy = null) {
  if (updatedBy) fields.updatedBy = updatedBy;
  return this.findByIdAndUpdate(
    SINGLETON_ID,
    { $set: fields },
    { upsert: true, new: true }
  );
};

module.exports = mongoose.model('SystemStatus', systemStatusSchema);
