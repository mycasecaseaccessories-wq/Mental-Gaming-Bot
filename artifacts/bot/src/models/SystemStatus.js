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
    referralVelocityLimit:     { type: Number,  default: 10, min: 1, max: 1000 },
    referralNewAccountWindowMinutes: { type: Number, default: 10, min: 0, max: 1440 },
    referralRapidTopupSeconds: { type: Number, default: 120, min: 0, max: 86400 },
    referralBudgetEnabled:    { type: Boolean, default: false },
    referralDailyBudgetCoins: { type: Number, default: 0, min: 0 },
    referralMonthlyBudgetCoins: { type: Number, default: 0, min: 0 },
    referralBudgetDayKey:      { type: String, default: null },
    referralBudgetDayUsed:     { type: Number, default: 0, min: 0 },
    referralBudgetMonthKey:    { type: String, default: null },
    referralBudgetMonthUsed:   { type: Number, default: 0, min: 0 },
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

    // ── Game News / Knowledge Channel ─────────────────────────────────────────
    gameNewsChannelId: {
      type:    String,
      default: null,
      comment: 'Channel whose posts are stored as game-update knowledge for support AI',
    },

    // ── FAQ Knowledge Channel ─────────────────────────────────────────────────
    faqChannelId: {
      type:    String,
      default: null,
      comment: 'Channel whose posts are stored as evergreen FAQ knowledge (no age cutoff)',
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

    // ── Live Activity Feed Channel ─────────────────────────────────────────────
    liveFeedChannelId: {
      type:    String,
      default: null,
      comment: 'Channel to receive live activity posts (purchases, top-ups, giveaway claims)',
    },
    liveFeedChannels: {
      type: [{ chatId: String, title: String, link: String }],
      default: () => [],
      comment: 'Additional live activity destinations; liveFeedChannelId is retained for backwards compatibility',
    },
    liveFeedEnabled: {
      type:    Boolean,
      default: false,
      comment: 'Master switch for live activity feed notifications',
    },

    // ── Product Announcement Channel ──────────────────────────────────────────
    announcementChannelId: {
      type:    String,
      default: null,
      comment: 'Channel to forward new product alerts / flash sale announcements',
    },

    // ── Saved Coupon Announce Channels ────────────────────────────────────────
    couponAnnounceChannels: {
      type: [{ chatId: String, title: String }],
      default: () => [],
      comment: 'Saved channels for one-tap coupon announcements (/gencoupon 📢 flow)',
    },

    // ── Channel Manager display aliases ────────────────────────────────────────
    channelRegistryAliases: {
      type: [{ chatId: String, title: String }],
      default: () => [],
      comment: 'Admin-defined display names used by the unified /channels manager',
    },

    // ── Backup Channel ─────────────────────────────────────────────────────────
    backupChannelId: {
      type:    String,
      default: null,
      comment: 'Private channel ID or @username to receive daily encrypted DB backups. Falls back to owner DM.',
    },
    backupLastAt: { type: Date, default: null },
    backupLastSize: { type: String, default: null },
    backupLastFile: { type: String, default: null },
    backupLastStatus: { type: String, enum: ['success', 'failed', 'running', 'never'], default: 'never' },
    backupLastError: { type: String, default: null },

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

    // ── Support Direct-Contact Account ────────────────────────────────────────
    supportContactUsername: {
      type:    String,
      default: null,
      comment: 'Telegram username (without @) shown as the "message admin directly" button in /support; null = auto-use owner account username',
    },

    // ── Stale-Order Support Prompt ────────────────────────────────────────────
    orderSupportThresholdMinutes: {
      type:    Number,
      default: 30,
      comment: 'Minutes a Pending/Processing order must wait before the [Contact Support] button appears on the tracking card',
    },

    // ── Admin-controlled delivery retention ───────────────────────────────────
    accountPaymentClaimTimeoutMinutes: {
      type: Number,
      default: null,
      min: 1,
      max: 48 * 60,
      comment: 'Minutes before an abandoned Premium Account payment claim is released; null disables cleanup',
    },
    broadcastRetentionMinutes: {
      type: Number,
      default: null,
      min: 1,
      max: 48 * 60,
      comment: 'Minutes before bot-user broadcast copies are deleted; null keeps them permanently',
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

    // ── Ambient Text Reply / AI Chat ──────────────────────────────────────────
    ambientRepliesEnabled: {
      type: Boolean,
      default: true,
      comment: 'Master switch for unsolicited replies to ordinary user text; wizard inputs remain unaffected',
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

    // ── Promotion Perks ───────────────────────────────────────────────────────
    birthdayGiftMC: {
      type:    Number,
      default: 0,
      min:     0,
      comment: 'MC gifted on user birthday (0 = off)',
    },
    happyHourEnabled: { type: Boolean, default: false },
    happyHourStartMMT: { type: Number, default: 18, min: 0, max: 23, comment: 'Start hour (MMT, 0-23)' },
    happyHourEndMMT:   { type: Number, default: 20, min: 0, max: 23, comment: 'End hour (MMT, exclusive)' },
    happyHourBonusPct: { type: Number, default: 5, min: 0, max: 100, comment: 'Extra MC bonus % on top-ups during happy hour' },
    cashbackPct: {
      type:    Number,
      default: 0,
      min:     0,
      max:     100,
      comment: 'MC cashback % of order amount on completed orders (0 = off)',
    },
    firstOrderDiscountPct: {
      type:    Number,
      default: 0,
      min:     0,
      max:     90,
      comment: 'Discount % on a user\'s very first order (0 = off)',
    },
    winbackEnabled: { type: Boolean, default: false },
    winbackDays:    { type: Number, default: 30, min: 7, comment: 'Days of inactivity before win-back message' },
    winbackBonusMC: { type: Number, default: 0, min: 0, comment: 'MC credited with the win-back message' },
    leaderboardEnabled: { type: Boolean, default: false, comment: 'Monthly top-spender leaderboard + auto prizes' },
    leaderboardPrizes: {
      type:    [Number],
      default: () => [3000, 2000, 1000],
      comment: 'MC prizes for monthly top spenders (index 0 = 1st place)',
    },

    // ── Top-up reward coupon (auto-grant coupon on qualifying top-ups) ────────
    topupCouponEnabled: { type: Boolean, default: false },
    topupCouponMinKS:   { type: Number, default: 10000, min: 0, comment: 'Minimum top-up amount (KS) to earn a coupon' },
    topupCouponType:    { type: String, enum: ['Flat', 'Percentage'], default: 'Percentage' },
    topupCouponValue:   { type: Number, default: 5, min: 0, comment: 'KS (Flat) or % (Percentage) discount of the granted coupon' },
    topupCouponExpiryDays: { type: Number, default: 7, min: 1, comment: 'Coupon validity in days from grant' },
    topupCouponScopeType: { type: String, enum: ['all', 'category', 'product'], default: 'all' },
    topupCouponScopeCategories: { type: [String], default: () => [] },
    topupCouponScopeProducts: { type: [mongoose.Schema.Types.ObjectId], default: () => [] },

    // ── Outline VPN Bot ───────────────────────────────────────────────────────
    outlineBotUsername: {
      type:    String,
      default: null,
      comment: '@username of the separate Outline VPN bot (without @). Set to show VPN button in user menu.',
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

function budgetPeriodKeys(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Rangoon', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).reduce((acc, item) => ({ ...acc, [item.type]: item.value }), {});
  return { dayKey: `${parts.year}-${parts.month}-${parts.day}`, monthKey: `${parts.year}-${parts.month}` };
}

// Atomically reserves both daily and monthly referral MC budget windows.
systemStatusSchema.statics.reserveReferralBudget = async function (amount, now = new Date()) {
  const requested = Math.max(0, Math.floor(Number(amount) || 0));
  const current = await this.get();
  if (!current.referralBudgetEnabled || requested === 0) return { allowed: true, reserved: false };
  const { dayKey, monthKey } = budgetPeriodKeys(now);

  // Reset stale period counters before the conditional reservation. The
  // subsequent update is the gate: concurrent requests can only win once.
  await this.updateOne({ _id: SINGLETON_ID }, [
    { $set: {
      referralBudgetDayUsed: { $cond: [{ $eq: ['$referralBudgetDayKey', dayKey] }, '$referralBudgetDayUsed', 0] },
      referralBudgetDayKey: dayKey,
      referralBudgetMonthUsed: { $cond: [{ $eq: ['$referralBudgetMonthKey', monthKey] }, '$referralBudgetMonthUsed', 0] },
      referralBudgetMonthKey: monthKey,
    } },
  ]);

  const reserved = await this.findOneAndUpdate(
    {
      _id: SINGLETON_ID,
      referralBudgetEnabled: true,
      $and: [
        { $or: [
          { referralDailyBudgetCoins: { $lte: 0 } },
          { $expr: { $lte: [{ $add: ['$referralBudgetDayUsed', requested] }, '$referralDailyBudgetCoins'] } },
        ] },
        { $or: [
          { referralMonthlyBudgetCoins: { $lte: 0 } },
          { $expr: { $lte: [{ $add: ['$referralBudgetMonthUsed', requested] }, '$referralMonthlyBudgetCoins'] } },
        ] },
      ],
    },
    { $inc: { referralBudgetDayUsed: requested, referralBudgetMonthUsed: requested } },
    { new: true },
  );
  return { allowed: !!reserved, reserved: !!reserved, dayKey, monthKey };
};

systemStatusSchema.statics.releaseReferralBudget = async function (amount, now = new Date()) {
  const requested = Math.max(0, Math.floor(Number(amount) || 0));
  if (!requested) return false;
  const { dayKey, monthKey } = budgetPeriodKeys(now);
  const released = await this.findOneAndUpdate(
    {
      _id: SINGLETON_ID,
      referralBudgetDayKey: dayKey,
      referralBudgetMonthKey: monthKey,
      referralBudgetDayUsed: { $gte: requested },
      referralBudgetMonthUsed: { $gte: requested },
    },
    { $inc: { referralBudgetDayUsed: -requested, referralBudgetMonthUsed: -requested } },
    { new: true },
  );
  return !!released;
};

module.exports = mongoose.model('SystemStatus', systemStatusSchema);
