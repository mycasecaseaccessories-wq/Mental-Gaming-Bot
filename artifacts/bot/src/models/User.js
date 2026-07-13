const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    telegramId: { type: Number, required: true, unique: true },
    username:   { type: String, default: null },
    first_name: { type: String, default: null },

    // ── Dual Wallet ──────────────────────────────────────────────────────────
    balanceKS:      { type: Number, default: 0, min: 0 },
    balanceCoin:    { type: Number, default: 0, min: 0 },
    totalDeposited: { type: Number, default: 0, min: 0 },

    membershipTier: { type: String, enum: ['Silver', 'Gold', 'Platinum'], default: 'Silver' },

    // ── Dual Tier System (based on completed order spending) ─────────────────
    lifetimeTier:  { type: String, default: 'Bronze' },
    activeTier:    { type: String, default: 'Bronze' },
    lifetimeSpend: { type: Number, default: 0, min: 0, comment: 'All-time completed order spend (KS)' },
    yearlySpend:   { type: Number, default: 0, min: 0, comment: 'Last 365 days completed order spend (KS)' },

    // ── Spin Wheel ───────────────────────────────────────────────────────────
    lastSpinAt: { type: Date, default: null },

    // ── Daily Check-In ───────────────────────────────────────────────────────
    checkInStreak:   { type: Number, default: 0, min: 0 },
    longestStreak:   { type: Number, default: 0, min: 0 },
    totalCheckIns:   { type: Number, default: 0, min: 0 },
    lastCheckInDate: { type: String, default: null },

    // ── Moderation ───────────────────────────────────────────────────────────
    warningsCount:     { type: Number, default: 0, min: 0 },
    restrictedRights:  { type: [String], default: [] },
    restrictedUntil:   { type: Date, default: null },
    restrictionReason: { type: String, default: null },
    isBlocked:         { type: Boolean, default: false },

    // ── Referral ─────────────────────────────────────────────────────────────
    referralCode: { type: String, default: null },

    // ── Attribution Analytics ─────────────────────────────────────────────────
    // Tracks where the user came from on first join (never overwritten after set).
    joinSource: {
      type: String,
      enum:    ['direct', 'referral', 'channel', 'share', 'unknown'],
      default: 'unknown',
      index:   true,
      comment: 'How the user first found the bot',
    },
    joinRef: {
      type:    String,
      default: null,
      comment: 'referral code | channel post ID | product ID | null',
    },

    // ── Onboarding ────────────────────────────────────────────────────────────
    onboardingDone: {
      type:    Boolean,
      default: false,
      comment: 'True after user completes or skips the first-time tour',
    },
    onboardingBonusClaimed: {
      type:    Boolean,
      default: false,
      comment: 'True once the 100 MC welcome bonus has been credited',
    },

    // ── Birthday Gift ────────────────────────────────────────────────────────
    birthdayMonth: { type: Number, default: null, min: 1, max: 12 },
    birthdayDay:   { type: Number, default: null, min: 1, max: 31 },
    lastBirthdayGiftYear: { type: Number, default: null, comment: 'Year the birthday MC gift was last credited' },

    // ── Win-back ─────────────────────────────────────────────────────────────
    lastWinbackAt: { type: Date, default: null, comment: 'When the last win-back bonus was sent' },

    // ── Preferences ──────────────────────────────────────────────────────────
    theme:    { type: String, enum: ['light', 'dark', 'auto'], default: 'auto' },
    language: { type: String, enum: ['en', 'mm'], default: 'en' },
    joinDate:   { type: Date, default: Date.now },
    lastActive: { type: Date, default: Date.now },
  },
  { timestamps: true, versionKey: false }
);

// ── Indexes ───────────────────────────────────────────────────────────────────
// Partial (NOT sparse): a sparse unique index still indexes documents whose
// referralCode is explicitly null. Because the schema applies `default: null`,
// every new user is created with referralCode === null, so the FIRST such user
// occupies the single allowed null slot and every subsequent signup fails with a
// duplicate-key error (E11000) — findOrCreate then returns null and the user is
// never saved (invisible to admin, uncounted, "press /start first" on buttons).
// A partial index only enforces uniqueness when referralCode is an actual string,
// so nulls/missing are never indexed.
userSchema.index(
  { referralCode: 1 },
  { unique: true, partialFilterExpression: { referralCode: { $type: 'string' } } }
);

userSchema.methods.hasRight = function (right) {
  return !this.restrictedRights.includes(right);
};

userSchema.methods.recalcTier = function () {
  const d = this.totalDeposited || 0;
  if (d >= 2_000_000)    this.membershipTier = 'Platinum';
  else if (d >= 500_000) this.membershipTier = 'Gold';
  else                   this.membershipTier = 'Silver';
};

userSchema.statics.findByTelegramId = function (telegramId) {
  return this.findOne({ telegramId });
};

userSchema.statics.findOrCreate = async function (telegramId, username, firstName) {
  // Always coerce to Number — Telegram IDs are always numeric
  const numId = Number(telegramId);

  // Step 1 — find by number OR string (handles legacy docs stored as string)
  let user = await this.findOne({ $or: [{ telegramId: numId }, { telegramId: String(telegramId) }] });

  if (user) {
    // Normalise type in background if stored as string
    if (typeof user.telegramId !== 'number') {
      this.updateOne({ _id: user._id }, { $set: { telegramId: numId, lastActive: new Date() } }).catch(() => {});
    } else {
      const patch = { lastActive: new Date() };
      if (username)  patch.username   = username;
      if (firstName) patch.first_name = firstName;
      this.updateOne({ _id: user._id }, { $set: patch }).catch(() => {});
    }
    return user;
  }

  // Step 2 — not found; create
  try {
    user = await this.create({
      telegramId: numId,
      username:   username   || null,
      first_name: firstName  || null,
      lastActive: new Date(),
    });
    return user;
  } catch (createErr) {
    console.error('[User] create error for', numId, ':', createErr.code, createErr.message);
    // Duplicate key — race condition; try both forms again
    if (createErr.code === 11000) {
      return this.findOne({ $or: [{ telegramId: numId }, { telegramId: String(telegramId) }] });
    }
    return null;
  }
};

module.exports = mongoose.model('User', userSchema);
