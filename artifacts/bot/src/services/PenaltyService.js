/**
 * PenaltyService — Smart Warning & Restriction System
 *
 * Warning Levels (cumulative):
 *   1st Warning → 3-day ban from Spin Wheel & Daily Check-In only
 *   2nd Warning → 7-day ban from ALL reward features + 10% Mental Coin penalty
 *   3rd Warning → Permanent ban from the entire bot
 *
 * Auto-Recovery:
 *   Before any restricted command, checkRestrictions middleware calls
 *   autoRecoverIfExpired() — if restrictedUntil has passed, rights are restored
 *   (warning count is NOT reset — it stays as a permanent record).
 *
 * Restriction scopes:
 *   'spin'    — Spin Wheel
 *   'checkin' — Daily Check-In
 *   'referral'— Referral Bonus triggers
 *   'rewards' — All above combined
 */

const User = require('../models/User');
const { debitCoin } = require('./WalletService');
const { auditLog } = require('./logger');
const { config } = require('../../config/settings');

// ── Restriction scope maps ────────────────────────────────────────────────────
const WARNING_RESTRICTIONS = {
  1: { rights: ['spin', 'checkin'],                   days: 3,   level: 'light',  coinPenaltyPct: 0   },
  2: { rights: ['spin', 'checkin', 'rewards'],        days: 7,   level: 'heavy',  coinPenaltyPct: 10  },
  3: { rights: ['all'],                               days: null, level: 'banned', coinPenaltyPct: 0   },
};

// ── Issue a warning with automatic penalty ────────────────────────────────────
async function issueWarning(targetId, adminId, reason, telegram = null) {
  const user = await User.findByTelegramId(Number(targetId));
  if (!user) throw new Error('User not found');
  if (user.isBlocked) throw new Error('User is already permanently banned');

  user.warningsCount = (user.warningsCount || 0) + 1;
  const level = Math.min(user.warningsCount, 3);
  const cfg   = WARNING_RESTRICTIONS[level];

  // Set restriction rights
  const newRights = [...new Set([...user.restrictedRights, ...cfg.rights])];
  user.restrictedRights = newRights;
  user.restrictionReason = reason;

  let expiresAt = null;
  if (cfg.days) {
    expiresAt = new Date(Date.now() + cfg.days * 24 * 60 * 60 * 1000);
    user.restrictedUntil = expiresAt;
  }

  // Coin penalty on 2nd warning
  let coinPenalty = 0;
  if (cfg.coinPenaltyPct > 0 && user.balanceCoin > 0) {
    coinPenalty = Math.floor(user.balanceCoin * (cfg.coinPenaltyPct / 100));
    if (coinPenalty > 0) {
      await debitCoin(user._id, coinPenalty, {
        type: 'Debit',
        note: `Penalty deduction — Warning ${level}: ${reason}`,
      });
      user.balanceCoin = Math.max(0, user.balanceCoin - coinPenalty);
    }
  }

  let autoBanned = false;
  if (level >= 3) {
    user.isBlocked = true;
    user.restrictedUntil = null;
    autoBanned = true;
  }

  await user.save();

  await auditLog(adminId, 'WARNING_ISSUED', user._id.toString(), 'User', {
    warningsCount: user.warningsCount,
    level,
    reason,
    restrictions: cfg.rights,
    coinPenalty,
    autoBanned,
  });

  // Notify user
  if (telegram) {
    try {
      const restrictionText = buildRestrictionText(cfg, expiresAt, reason, level, coinPenalty);
      await telegram.sendMessage(user.telegramId, restrictionText, { parse_mode: 'Markdown' });
    } catch {}

    if (autoBanned) {
      try {
        await telegram.sendMessage(
          config.bot.adminId,
          `🚫 *Auto-Banned*\n\n` +
          `User \`${user.telegramId}\` has been permanently banned after 3 warnings.\n` +
          `Last reason: ${reason}`,
          { parse_mode: 'Markdown' }
        );
      } catch {}
    }
  }

  return { user, autoBanned, level, coinPenalty, expiresAt };
}

// ── Build user-facing restriction message ────────────────────────────────────
function buildRestrictionText(cfg, expiresAt, reason, level, coinPenalty) {
  const levelLabel = { 1: '1st ⚠️', 2: '2nd ⚠️⚠️', 3: '3rd 🚫' }[level] || `${level}th`;
  const untilText  = expiresAt
    ? `📅 Restrictions lift: *${expiresAt.toLocaleDateString('en-GB')}*`
    : '🚫 *Permanent — contact support to appeal*';

  const penaltyLine = coinPenalty > 0 ? `\n🪙 Coin Penalty: *-${coinPenalty.toLocaleString()} MC*` : '';

  const restrictedList = cfg.rights.includes('all')
    ? 'All bot features'
    : cfg.rights.join(', ');

  return (
    `⚠️ *Warning ${levelLabel} Issued*\n\n` +
    `📝 Reason: ${reason}\n` +
    `🔒 Restricted: *${restrictedList}*\n` +
    penaltyLine + `\n` +
    untilText + `\n\n` +
    `_Appeal via /support if you believe this is a mistake._`
  );
}

// ── Auto-recover expired restrictions ─────────────────────────────────────────
async function autoRecoverIfExpired(user) {
  if (!user.restrictedUntil) return false;
  if (new Date() < user.restrictedUntil) return false;

  // Restriction period has passed — lift it
  user.restrictedUntil  = null;
  user.restrictionReason = null;

  // Remove time-based rights (keep 'all' if permanently banned)
  user.restrictedRights = user.restrictedRights.filter((r) => r === 'all');

  await user.save();

  await auditLog(user.telegramId, 'RESTRICTION_AUTO_LIFTED', user._id.toString(), 'User', {
    previousWarnings: user.warningsCount,
  });

  return true;
}

// ── Check if user is restricted for a specific right ─────────────────────────
function isRestricted(user, right) {
  if (!user) return false;
  if (user.isBlocked) return true;
  if (user.restrictedRights.includes('all')) return true;
  return user.restrictedRights.includes(right);
}

// ── Get human-readable penalty status for a user ─────────────────────────────
async function getPenaltyStatus(telegramId) {
  const user = await User.findByTelegramId(Number(telegramId));
  if (!user) return null;

  const expired = user.restrictedUntil && new Date() > user.restrictedUntil;

  return {
    warningsCount:    user.warningsCount,
    isBlocked:        user.isBlocked,
    restrictedRights: user.restrictedRights,
    restrictedUntil:  user.restrictedUntil,
    restrictionReason: user.restrictionReason,
    isExpired:        expired,
    isClean:          !user.isBlocked && user.restrictedRights.length === 0,
  };
}

// ── /user_log — combined activity log for admin ───────────────────────────────
async function getUserLog(telegramId) {
  const User       = require('../models/User');
  const Order      = require('../models/Order');
  const Transaction = require('../models/Transaction');
  const SupportTicket = require('../models/SupportTicket');

  const user = await User.findByTelegramId(Number(telegramId));
  if (!user) return null;

  const [orders, transactions, tickets] = await Promise.all([
    Order.find({ userId: user._id }).populate('productId', 'name').sort({ timestamp: -1 }).limit(5),
    Transaction.find({ userId: user._id }).sort({ timestamp: -1 }).limit(5),
    SupportTicket.find({ userId: user._id }).sort({ createdAt: -1 }).limit(3),
  ]);

  return { user, orders, transactions, tickets };
}

module.exports = {
  issueWarning,
  autoRecoverIfExpired,
  isRestricted,
  getPenaltyStatus,
  getUserLog,
  WARNING_RESTRICTIONS,
  buildRestrictionText,
};
