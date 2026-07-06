/**
 * FraudDetector
 *
 * Behavioral anti-fraud engine for the referral program.
 * Since Telegram bot API does not expose IP addresses, detection is based
 * entirely on behavioral and timing patterns.
 *
 * Patterns detected:
 *   HIGH   SELF_REFERRAL       — user used their own code
 *   HIGH   CIRCULAR_REFERRAL   — A referred B and B already referred A
 *   MEDIUM VELOCITY_ABUSE      — >N new referrals from same code within 1 hour
 *   MEDIUM BOTH_ACCOUNTS_NEW   — referrer AND referee both registered <10 min ago
 *   LOW    RAPID_TOPUP         — referred user tops up within 2 minutes of joining
 *
 * On HIGH severity: commissions are frozen immediately + admin notified.
 * On MEDIUM severity: flagged for review + admin notified.
 * On LOW severity: logged only.
 */

const FraudFlag    = require('../models/FraudFlag');
const Referral     = require('../models/Referral');
const User         = require('../models/User');
const SystemStatus = require('../models/SystemStatus');
const { config }   = require('../../config/settings');

// ── Admin notification builder ───────────────────────────────────────────────

const TYPE_LABELS = {
  SELF_REFERRAL:     '🔴 Self-Referral Attempt',
  CIRCULAR_REFERRAL: '🔴 Circular Referral Chain',
  VELOCITY_ABUSE:    '🟠 Velocity Abuse',
  BOTH_ACCOUNTS_NEW: '🟡 Both Accounts Very New',
  RAPID_TOPUP:       '🟡 Suspiciously Fast Top-Up',
  ADMIN_REVIEW:      '🔵 Manual Flag',
};

async function notifyAdmin(telegram, flag, referrerUser, refereeUser) {
  if (!telegram) return;

  const adminId = config.bot.adminId;
  const referrerTag = referrerUser?.username
    ? `@${referrerUser.username}`
    : `ID: \`${referrerUser?.telegramId || '?'}\``;
  const refereeTag = refereeUser?.username
    ? `@${refereeUser.username}`
    : `ID: \`${refereeUser?.telegramId || '?'}\``;

  const label = TYPE_LABELS[flag.type] || flag.type;
  const frozenNote = ['HIGH', 'MEDIUM'].includes(flag.severity)
    ? '\n🔒 _Commission frozen pending review._'
    : '';

  const text =
    `⚠️ *Referral Fraud Alert*\n\n` +
    `*Pattern:* ${label}\n` +
    `*Severity:* ${flag.severity}\n\n` +
    `👤 *Referrer:* ${referrerTag}\n` +
    `👤 *Referee:* ${refereeTag}\n` +
    (flag.details?.count ? `📊 Count: ${flag.details.count}\n` : '') +
    (flag.details?.note  ? `📝 ${flag.details.note}\n` : '') +
    frozenNote;

  const { Markup } = require('telegraf');

  try {
    await telegram.sendMessage(adminId, text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(`🚫 Block Referrer`, `fraud_block:${flag.referrerTid}`),
          Markup.button.callback(`🚫 Block Referee`,  `fraud_block:${flag.refereeTid}`),
        ],
        [Markup.button.callback(`✅ Dismiss`, `fraud_dismiss:${flag._id}`)],
      ]),
    });
  } catch (err) {
    console.error('[FraudDetector] Admin notification failed:', err.message);
  }
}

// ── Core detection ────────────────────────────────────────────────────────────

/**
 * Run all fraud checks when a new referral link is clicked.
 *
 * @param {object} opts
 * @param {mongoose.Types.ObjectId} opts.newUserId       — new user's MongoDB _id
 * @param {mongoose.Types.ObjectId} opts.referrerId      — referrer's MongoDB _id
 * @param {string}                  opts.refCode         — the referral code used
 * @param {object|null}             opts.telegram        — ctx.telegram for admin notify
 * @param {mongoose.Document|null}  opts.referral        — created Referral doc (may be null before creation)
 *
 * @returns {{ shouldBlock: boolean, flags: FraudFlag[] }}
 */
async function checkReferralFraud({ newUserId, referrerId, refCode, telegram, referral = null }) {
  const [status, referrer, newUser] = await Promise.all([
    SystemStatus.get(),
    User.findById(referrerId),
    User.findById(newUserId),
  ]);

  const velocityLimit = status.referralVelocityLimit || 10;
  const detectedFlags = [];

  const referrerTid = referrer?.telegramId || 0;
  const refereeTid  = newUser?.telegramId  || 0;

  // ── Pattern 1: Self-referral ───────────────────────────────────────────────
  if (newUserId.toString() === referrerId.toString()) {
    detectedFlags.push({ type: 'SELF_REFERRAL', severity: 'HIGH', details: {} });
  }

  // ── Pattern 2: Circular referral — did newUser already refer this referrer?
  const circular = await Referral.findOne({ referrerId: newUserId, refereeId: referrerId });
  if (circular) {
    detectedFlags.push({
      type: 'CIRCULAR_REFERRAL',
      severity: 'HIGH',
      details: { note: 'A referred B and B referred A — mutual referral farm.' },
    });
  }

  // ── Pattern 3: Velocity abuse ─────────────────────────────────────────────
  const oneHourAgo = new Date(Date.now() - 3_600_000);
  const recentCount = await Referral.countDocuments({
    referralCode: refCode,
    createdAt: { $gte: oneHourAgo },
  });
  if (recentCount >= velocityLimit) {
    detectedFlags.push({
      type: 'VELOCITY_ABUSE',
      severity: 'MEDIUM',
      details: { count: recentCount, limit: velocityLimit, note: `${recentCount} referrals in the last hour.` },
    });
  }

  // ── Pattern 4: Both accounts very new (< 10 minutes) ─────────────────────
  const tenMinutes = 10 * 60_000;
  const now = Date.now();
  const referrerAge = referrer?.joinDate ? now - new Date(referrer.joinDate).getTime() : Infinity;
  const refereeAge  = newUser?.joinDate  ? now - new Date(newUser.joinDate).getTime()  : Infinity;
  if (referrerAge < tenMinutes && refereeAge < tenMinutes) {
    detectedFlags.push({
      type: 'BOTH_ACCOUNTS_NEW',
      severity: 'MEDIUM',
      details: {
        referrerAgeMinutes: Math.floor(referrerAge / 60_000),
        refereeAgeMinutes:  Math.floor(refereeAge  / 60_000),
        note: 'Both accounts registered within the last 10 minutes.',
      },
    });
  }

  if (!detectedFlags.length) return { shouldBlock: false, flags: [] };

  // ── Persist flags and notify admin ────────────────────────────────────────
  const savedFlags = [];
  for (const f of detectedFlags) {
    const flag = await FraudFlag.create({
      referralId:  referral?._id || null,
      referrerTid,
      refereeTid,
      type:        f.type,
      severity:    f.severity,
      details:     f.details,
    });
    savedFlags.push(flag);
    if (f.severity === 'HIGH' || f.severity === 'MEDIUM') {
      await notifyAdmin(telegram, flag, referrer, newUser);
    }
  }

  // ── Freeze referral if HIGH/MEDIUM flag detected ──────────────────────────
  const shouldBlock = detectedFlags.some((f) => ['HIGH', 'MEDIUM'].includes(f.severity));
  return { shouldBlock, flags: savedFlags };
}

/**
 * Check for RAPID_TOPUP fraud when a referral commission is about to be paid.
 *
 * @param {mongoose.Document} referral
 * @param {object|null} telegram
 */
async function checkTopupFraud(referral, telegram) {
  if (!referral) return { shouldBlock: false };

  const [referrer, referee] = await Promise.all([
    User.findById(referral.referrerId),
    User.findById(referral.refereeId),
  ]);

  const refereeTid  = referee?.telegramId  || 0;
  const referrerTid = referrer?.telegramId || 0;

  // Rapid topup: referred user tops up < 2 minutes after joining
  const twoMinutes = 2 * 60_000;
  const refereeAge = referee?.joinDate ? Date.now() - new Date(referee.joinDate).getTime() : Infinity;

  if (refereeAge < twoMinutes) {
    const flag = await FraudFlag.create({
      referralId:  referral._id,
      referrerTid,
      refereeTid,
      type:     'RAPID_TOPUP',
      severity: 'LOW',
      details:  { refereeAgeSeconds: Math.floor(refereeAge / 1000) },
    });
    await notifyAdmin(telegram, flag, referrer, referee);
    return { shouldBlock: false, flag };
  }

  return { shouldBlock: false };
}

// ── Admin action handlers ─────────────────────────────────────────────────────

/**
 * Register fraud_block and fraud_dismiss callback handlers on the bot.
 * Called once from index.js or referral.js.
 */
function registerFraudActions(bot) {
  const { requireRole } = require('../middlewares/adminCheck');
  const { Markup } = require('telegraf');

  // Block a user flagged for fraud
  bot.action(/^fraud_block:(\d+)$/, requireRole('STAFF'), async (ctx) => {
    await ctx.answerCbQuery('Blocking user...');
    const targetTid = Number(ctx.match[1]);

    const user = await User.findByTelegramId(targetTid);
    if (!user) return ctx.reply('❌ User not found.');

    user.isBlocked = true;
    await user.save();

    // Freeze all pending referrals for this user
    await Referral.updateMany(
      { $or: [{ referrerId: user._id }, { refereeId: user._id }], status: { $in: ['Pending', 'Active'] } },
      { $set: { status: 'Frozen', isFraudSuspected: true, fraudReason: 'Blocked by admin after fraud alert' } }
    );

    await ctx.editMessageText(
      `🚫 *User Blocked*\n\n` +
      `ID: \`${targetTid}\`\n` +
      (user.username ? `Username: @${user.username}\n` : '') +
      `All referrals frozen.`,
      { parse_mode: 'Markdown' }
    );

    try {
      await ctx.telegram.sendMessage(
        targetTid,
        `🚫 *Your account has been blocked.*\n\n` +
        `If you believe this is a mistake, please contact support.`,
        { parse_mode: 'Markdown' }
      );
    } catch {}
  });

  // Dismiss a fraud flag (admin reviewed and decided it's OK)
  bot.action(/^fraud_dismiss:(.+)$/, requireRole('STAFF'), async (ctx) => {
    await ctx.answerCbQuery('Dismissed.');
    const flagId = ctx.match[1];

    await FraudFlag.findByIdAndUpdate(flagId, {
      resolved:   true,
      resolvedBy: ctx.from.id,
      resolvedAt: new Date(),
      resolution: 'DISMISSED',
    });

    await ctx.editMessageText(
      `✅ *Fraud flag dismissed.*\n_Reviewed by admin — no action taken._`,
      { parse_mode: 'Markdown' }
    );
  });
}

module.exports = { checkReferralFraud, checkTopupFraud, registerFraudActions };
