/**
 * ReferralService — Commission-based 1-level referral system.
 *
 * Commission lifecycle:
 *   1. User A shares their referral link (deep link with ref code)
 *   2. User B clicks link → /start ref_CODE → registerReferral() called
 *      → FraudDetector runs; HIGH/MEDIUM flags freeze the referral
 *   3. Admin approves User B's top-up → processTopupCommission() called
 *      → If mode='first': pays once then status→Completed
 *      → If mode='every': pays on every approved top-up
 *   4. Commission = Math.floor(topupAmount × commissionRate / 100)
 *      awarded to referrer (KS / Coin / Both, per config)
 *   5. Referee gets welcome bonus on their FIRST top-up only
 *
 * All rates are read live from SystemStatus (hot-changeable by admin).
 */

const Referral          = require('../models/Referral');
const User              = require('../models/User');
const SystemStatus      = require('../models/SystemStatus');
const { creditKS, creditCoin, debitCoin } = require('./WalletService');
const { auditLog }      = require('./logger');
const { checkReferralFraud, checkTopupFraud } = require('./FraudDetector');

// ── Code generation ───────────────────────────────────────────────────────────

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function buildCode(telegramId) {
  const suffix = Array.from({ length: 4 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('');
  const prefix = String(telegramId).slice(-3);
  return `${prefix}${suffix}`;
}

async function getOrCreateCode(telegramId) {
  const user = await User.findByTelegramId(telegramId);
  if (!user) throw new Error('User not found');
  if (user.referralCode) return user.referralCode;

  let code;
  let attempts = 0;
  do {
    code = buildCode(telegramId);
    if (++attempts > 20) throw new Error('Could not generate unique referral code');
  } while (await User.findOne({ referralCode: code }));

  user.referralCode = code;
  await user.save();
  return code;
}

function getReferralLink(code, tag = null) {
  const safeTag = tag == null ? '' : String(tag).trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32);
  return `https://t.me/mentalgamingstorebot?start=ref_${code}${safeTag ? `_${safeTag}` : ''}`;
}

// ── Referral tier helpers ─────────────────────────────────────────────────────

const DEFAULT_TIERS = [
  { minRefs: 1,  rate: 2, label: 'Bronze', emoji: '🥉' },
  { minRefs: 6,  rate: 3, label: 'Silver', emoji: '🥈' },
  { minRefs: 16, rate: 5, label: 'Gold',   emoji: '🥇' },
];

/**
 * Resolves the current and next commission tier for a referrer.
 * @param {number} completedCount  — number of Active+Completed referrals
 * @param {Array}  tiers           — from SystemStatus.referralTiers (may be empty)
 */
function resolveTierInfo(completedCount, tiers) {
  const pool   = (tiers && tiers.length) ? tiers : DEFAULT_TIERS;
  const sorted = [...pool].sort((a, b) => b.minRefs - a.minRefs); // desc → find highest match first

  let currentTier = null;
  for (const t of sorted) {
    if (completedCount >= t.minRefs) { currentTier = t; break; }
  }

  // Next tier = first tier above currentTier (ascending)
  const ascending   = [...pool].sort((a, b) => a.minRefs - b.minRefs);
  const currentIdx  = currentTier ? ascending.findIndex((t) => t.minRefs === currentTier.minRefs) : -1;
  const nextTier    = currentIdx >= 0
    ? ascending[currentIdx + 1] || null
    : ascending[0] || null;            // no current tier yet → show first as "next"

  return { currentTier, nextTier };
}

// ── Masked username helper ────────────────────────────────────────────────────

function maskName(username, firstName) {
  const name = username || firstName || 'User';
  if (name.length <= 2) return name + '***';
  return name.slice(0, 2) + '*'.repeat(Math.min(3, name.length - 2));
}

// ── Register referral (called from /start deep link) ─────────────────────────

async function registerReferral(newUserId, refCode, telegram = null) {
  const referee = await User.findById(newUserId);
  if (!referee) return null;

  // Already referred?
  const existing = await Referral.findOne({ refereeId: newUserId });
  if (existing) return null;

  // Find referrer by code
  const referrer = await User.findOne({ referralCode: refCode });
  if (!referrer) return null;

  // No self-referral
  if (referrer._id.toString() === newUserId.toString()) return null;

  // Read live commission config
  const status = await SystemStatus.get();
  if (!status.referralEnabled) return null;

  const referral = await Referral.create({
    referrerId:     referrer._id,
    refereeId:      newUserId,
    referralCode:   refCode,
    status:         'Pending',
    commissionMode: status.referralCommissionMode || 'first',
    commissionRate: status.referralCommissionRate || 2,
  });

  // ── Run fraud detection ────────────────────────────────────────────────────
  const { shouldBlock, flags } = await checkReferralFraud({
    newUserId,
    referrerId: referrer._id,
    refCode,
    telegram,
    referral,
  });

  if (shouldBlock) {
    referral.status           = 'Frozen';
    referral.isFraudSuspected = true;
    referral.fraudReason      = flags.map((f) => f.type).join(', ');
    await referral.save();

    await auditLog(referee.telegramId, 'REFERRAL_FRAUD_FROZEN', referral._id.toString(), 'System', {
      referrerId: referrer.telegramId,
      flags: flags.map((f) => f.type),
    });

    return null; // silently deny — no bonus notice to suspicious user
  }

  await auditLog(referee.telegramId, 'REFERRAL_REGISTERED', referral._id.toString(), 'System', {
    referrerId: referrer.telegramId,
    code: refCode,
  });

  return { referral, referrer };
}

// ── Process top-up commission (replaces processFirstTopup) ────────────────────
//
// Called by topup.js after admin approves a top-up.
// Works for both 'first' and 'every' modes.

async function processTopupCommission(userId, topupAmount, telegram, topupTxId = null) {
  // Find active or pending referral where this user is the referee
  const referral = await Referral.findOne({
    refereeId: userId,
    status:    { $in: ['Pending', 'Active'] },
    isFraudSuspected: false,
  });
  if (!referral) return null;

  // A top-up event can be retried by an admin action or webhook. Referrals must
  // receive at most one commission entry for the same approved source tx.
  if (topupTxId && (referral.commissionHistory || []).some((entry) => entry.txId === topupTxId)) {
    return null;
  }

  const referee  = await User.findById(userId);
  const referrer = await User.findById(referral.referrerId);
  if (!referee || !referrer) return null;

  const status = await SystemStatus.get();
  if (!status.referralEnabled) return null;

  // Minimum top-up threshold
  if (topupAmount < (status.referralMinTopup || 1000)) return null;

  // In 'first' mode: check if we've already paid a commission
  if (referral.commissionMode === 'first' && referral.bonusPaid) return null;

  // Rapid topup fraud check (LOW severity — logged but doesn't block)
  await checkTopupFraud(referral, telegram);

  // ── Tier-based dynamic commission rate ───────────────────────────────────
  const completedBefore = await Referral.countDocuments({
    referrerId: referrer._id,
    status:    { $in: ['Completed', 'Active'] },
    _id:       { $ne: referral._id },
  });
  const thisIsRefN          = completedBefore + 1;
  const { currentTier }     = resolveTierInfo(thisIsRefN, status.referralTiers);
  const { currentTier: prevTier } = resolveTierInfo(completedBefore, status.referralTiers);
  const tierLevelUp         = currentTier && (!prevTier || currentTier.minRefs !== prevTier.minRefs);

  const rate           = currentTier ? currentTier.rate : (referral.commissionRate || status.referralCommissionRate || 2);
  const commissionKS   = Math.floor(topupAmount * rate / 100);
  // Policy: all rewards are paid in Mental Coins only.
  const commissionType = 'Coin';

  // Optional reward budget guard. The check is deliberately before wallet
  // credit; a later retry can still be evaluated against the same source txId.
  if (status.referralBudgetEnabled && commissionKS > 0) {
    const now = new Date();
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const [dailySpent, monthlySpent] = await Promise.all([
      Referral.aggregate([
        { $unwind: '$commissionHistory' },
        { $match: { 'commissionHistory.paidAt': { $gte: dayStart }, 'commissionHistory.reversed': { $ne: true } } },
        { $group: { _id: null, total: { $sum: '$commissionHistory.commissionCoins' } } },
      ]),
      Referral.aggregate([
        { $unwind: '$commissionHistory' },
        { $match: { 'commissionHistory.paidAt': { $gte: monthStart }, 'commissionHistory.reversed': { $ne: true } } },
        { $group: { _id: null, total: { $sum: '$commissionHistory.commissionCoins' } } },
      ]),
    ]);
    const dailyLimit = Number(status.referralDailyBudgetCoins) || 0;
    const monthlyLimit = Number(status.referralMonthlyBudgetCoins) || 0;
    if ((dailyLimit > 0 && (dailySpent[0]?.total || 0) + commissionKS > dailyLimit) ||
        (monthlyLimit > 0 && (monthlySpent[0]?.total || 0) + commissionKS > monthlyLimit)) {
      await auditLog('System', 'REFERRAL_BUDGET_BLOCKED', String(referral._id), 'Referral', { commissionKS, dailyLimit, monthlyLimit });
      return null;
    }
  }

  const commissionTxId = topupTxId ? `referral:commission:${topupTxId}` : null;

  // ── Award referrer commission ─────────────────────────────────────────────
  if (commissionKS > 0) {
    if (commissionType === 'KS' || commissionType === 'Both') {
      await creditKS(referrer._id, commissionKS, {
        type: 'Bonus',
        txId: commissionTxId ? `${commissionTxId}:ks` : null,
        note: `Referral commission ${rate}% of ${topupAmount.toLocaleString()} KS — @${referee.username || referee.telegramId}`,
      });
    }
    if (commissionType === 'Coin' || commissionType === 'Both') {
      await creditCoin(referrer._id, commissionKS, {
        type: 'Bonus',
        txId: commissionTxId,
        note: `Referral coin commission — source ${topupTxId || 'legacy'}`,
      });
    }
  }

  // ── Welcome bonus for referee (first top-up only) ─────────────────────────
  const isFirstTopup = !referral.bonusPaid;
  let welcomeKS    = 0;
  let welcomeCoins = 0;

  if (isFirstTopup) {
    // Policy: all rewards paid in Mental Coins only — fold any KS welcome bonus into MC.
    welcomeKS    = 0;
    welcomeCoins = (status.referralWelcomeBonusCoins || 50) + (status.referralWelcomeBonusKS || 200);

    if (welcomeCoins > 0) {
      await creditCoin(referee._id, welcomeCoins, {
        type: 'Bonus',
        txId: `referral:welcome:${referral._id}`,
        note: 'Welcome bonus — joined via referral',
      });
    }
  }

  // ── Update referral record atomically ─────────────────────────────────────
  // The history txId predicate prevents two concurrent approvals from adding
  // the same commission event twice. Wallet ledger txIds provide the second
  // idempotency guard if a retry happens after the wallet credit.
  const historyEntry = {
    topupAmount,
    commissionRate: rate,
    commissionKS,
    commissionCoins: commissionType === 'Coin' ? commissionKS : 0,
    paidAt: new Date(),
    txId: topupTxId,
  };
  const updateFilter = {
    _id: referral._id,
    status: { $in: ['Pending', 'Active'] },
    isFraudSuspected: false,
    ...(topupTxId ? { 'commissionHistory.txId': { $ne: topupTxId } } : {}),
    ...(referral.commissionMode === 'first' ? { bonusPaid: false } : {}),
  };
  const updateOps = {
    $inc: {
      totalCommissionKS: commissionType === 'Coin' ? 0 : commissionKS,
      totalCommissionCoins: commissionType === 'Coin' ? commissionKS : 0,
    },
    $set: {
      bonusPaid: true,
      completedAt: referral.completedAt || new Date(),
      topupAmount: referral.topupAmount || topupAmount,
      status: referral.commissionMode === 'first' ? 'Completed' : 'Active',
    },
    $push: { commissionHistory: historyEntry },
  };
  let updatedReferral;
  if (typeof Referral.findOneAndUpdate === 'function') {
    updatedReferral = await Referral.findOneAndUpdate(updateFilter, updateOps, { new: true });
  } else {
    // Lightweight test doubles may expose only document.save(); production uses
    // the atomic findOneAndUpdate branch above.
    referral.totalCommissionKS = (referral.totalCommissionKS || 0) + updateOps.$inc.totalCommissionKS;
    referral.totalCommissionCoins = (referral.totalCommissionCoins || 0) + updateOps.$inc.totalCommissionCoins;
    Object.assign(referral, updateOps.$set);
    referral.commissionHistory = [...(referral.commissionHistory || []), historyEntry];
    await referral.save();
    updatedReferral = referral;
  }
  if (!updatedReferral) return null;

  // ── Referral campaign hook (first completion only) ────────────────────────
  if (updatedReferral.commissionHistory.length === 1) {
    try {
      const { onReferralCompleted } = require('./RefCampaignService');
      await onReferralCompleted(referrer, telegram, referee, topupAmount);
    } catch (err) {
      console.error('[ReferralService] ⚠️ Campaign hook failed:', err.message);
    }
  }

  await auditLog(referee.telegramId, 'REFERRAL_COMMISSION_PAID', referral._id.toString(), 'System', {
    referrerId: referrer.telegramId,
    topupAmount,
    commissionKS,
    rate,
  });

  // ── Notify referrer (with tier badge) ────────────────────────────────────
  if (telegram) {
    const refereeTag   = referee.username ? `@${referee.username}` : `your friend`;
    const tierBadge    = currentTier
      ? `${currentTier.emoji} *${currentTier.label} Referrer* (${rate}%)`
      : `${rate}% commission`;
    const levelUpLine  = tierLevelUp
      ? `\n🆙 *You've reached ${currentTier.emoji} ${currentTier.label} tier!*\n`
      : '';
    const milestoneLine = [1, 5, 10, 25, 50, 100].includes(thisIsRefN)
      ? `\n🎯 *Milestone reached:* ${thisIsRefN} completed referrals!\n`
      : '';
    const { nextTier } = resolveTierInfo(thisIsRefN, status.referralTiers);
    const nextLine     = nextTier && !tierLevelUp
      ? `\n_${nextTier.minRefs - thisIsRefN} more referral${nextTier.minRefs - thisIsRefN !== 1 ? 's' : ''} to reach ${nextTier.emoji} ${nextTier.label} (${nextTier.rate}%)_`
      : '';
    try {
      await telegram.sendMessage(
        referrer.telegramId,
        `🎉 *Referral Commission Earned!*\n\n` +
        `${refereeTag} just topped up!\n` +
        `🏅 ${tierBadge}${levelUpLine}${milestoneLine}\n` +
        `💰 Commission (${rate}%): *+${commissionKS.toLocaleString()} ${commissionType === 'Coin' ? 'MC' : 'KS'}*\n` +
        nextLine + `\n` +
        (referral.commissionMode === 'every'
          ? `_You keep earning every time they top up. /referral_`
          : `_Share your link to earn more! /referral_`),
        { parse_mode: 'Markdown' }
      );
    } catch {}

    // Welcome message for referee on first top-up
    if (isFirstTopup && welcomeCoins > 0) {
      const referrerTag = referrer.username ? `@${referrer.username}` : 'a friend';
      try {
        await telegram.sendMessage(
          referee.telegramId,
          `🎁 *Welcome Bonus Unlocked!*\n\n` +
          `You were referred by ${referrerTag}.\n\n` +
          `🪙 *+${welcomeCoins} Mental Coins* added!\n\n` +
          `_Enjoy shopping at Mental Gaming Store! 🎮_`,
          { parse_mode: 'Markdown' }
        );
      } catch {}
    }
  }

  return { referral, commissionKS, rate, isFirstTopup };
}

// ── Reverse a commission when the source top-up is refunded/charged back ────────
async function reverseTopupCommission(topupTxId, actorId = 'System', reason = 'Source top-up refunded') {
  if (!topupTxId) throw new Error('Top-up transaction ID is required');

  const referral = await Referral.findOne({ 'commissionHistory.txId': topupTxId });
  if (!referral) return null;
  const entry = (referral.commissionHistory || []).find((item) => item.txId === topupTxId);
  if (!entry || entry.reversed) return null;

  const reversalTxId = `referral:reversal:${topupTxId}`;
  if (entry.commissionCoins > 0) {
    await debitCoin(referral.referrerId, entry.commissionCoins, {
      type: 'Debit',
      txId: reversalTxId,
      note: `Referral commission reversal — ${reason}`,
    });
  }

  const updated = await Referral.findOneAndUpdate(
    {
      _id: referral._id,
      commissionHistory: { $elemMatch: { txId: topupTxId, reversed: { $ne: true } } },
    },
    {
      $set: {
        'commissionHistory.$.reversed': true,
        'commissionHistory.$.reversedAt': new Date(),
        'commissionHistory.$.reversalTxId': reversalTxId,
      },
      $inc: { totalCommissionCoins: -Math.abs(entry.commissionCoins || 0) },
    },
    { new: true }
  );
  if (!updated) return null;

  await auditLog(actorId, 'REFERRAL_COMMISSION_REVERSED', referral._id.toString(), 'Referral', {
    topupTxId,
    reversalTxId,
    amountCoins: entry.commissionCoins || 0,
    reason,
  });
  return { referral: updated, entry, reversalTxId };
}

// ── Legacy alias kept so old callers don't break during transition ─────────────
const processFirstTopup = processTopupCommission;

// ── Get referral stats for a user ─────────────────────────────────────────────

async function getStats(telegramId) {
  const user = await User.findByTelegramId(telegramId);
  if (!user) throw new Error('User not found');

  const code = user.referralCode || await getOrCreateCode(telegramId);
  const status = await SystemStatus.get();

  const [total, completed, pending, active, frozen] = await Promise.all([
    Referral.countDocuments({ referrerId: user._id }),
    Referral.countDocuments({ referrerId: user._id, status: 'Completed' }),
    Referral.countDocuments({ referrerId: user._id, status: 'Pending' }),
    Referral.countDocuments({ referrerId: user._id, status: 'Active' }),
    Referral.countDocuments({ referrerId: user._id, isFraudSuspected: true }),
  ]);
  const completedCount = completed + active;

  // Sum total commissions earned
  const agg = await Referral.aggregate([
    { $match: { referrerId: user._id, bonusPaid: true } },
    { $group: { _id: null, totalKS: { $sum: '$totalCommissionKS' }, totalCoins: { $sum: '$totalCommissionCoins' } } },
  ]);
  const earned = agg[0] || { totalKS: 0, totalCoins: 0 };

  // Recent referrals (masked)
  const recentReferrals = await Referral
    .find({ referrerId: user._id })
    .populate('refereeId', 'username first_name telegramId')
    .sort({ createdAt: -1 })
    .limit(8);

  const { currentTier, nextTier } = resolveTierInfo(completedCount, status.referralTiers);
  const milestones = [1, 5, 10, 25, 50, 100];
  const nextMilestone = milestones.find((value) => value > completedCount) || null;

  return {
    code,
    link:        getReferralLink(code),
    shareLinks: {
      telegram: getReferralLink(code, 'telegram'),
      facebook: getReferralLink(code, 'facebook'),
      tiktok: getReferralLink(code, 'tiktok'),
    },
    total,
    completed,
    pending,
    active,
    frozen,
    completedCount,
    nextMilestone,
    tier:            currentTier,
    nextTier,
    totalKSEarned:    earned.totalKS,
    totalCoinsEarned: earned.totalCoins,
    commissionRate:   currentTier ? currentTier.rate : (status.referralCommissionRate || 2),
    commissionMode:   status.referralCommissionMode || 'first',
    commissionType:   'Coin', // Policy: all rewards paid in Mental Coins only.
    referralEnabled:  status.referralEnabled,
    welcomeBonus: {
      ks:    0, // Policy: welcome bonus paid in Mental Coins only.
      coins: (status.referralWelcomeBonusCoins || 50) + (status.referralWelcomeBonusKS || 200),
    },
    recentReferrals:     recentReferrals.map((r) => ({
      id:         r._id.toString(),
      status:     r.status,
      earned:     (r.totalCommissionCoins || 0) + (r.totalCommissionKS || 0),
      isFraud:    r.isFraudSuspected,
      maskedName: r.refereeId
        ? maskName(r.refereeId.username, r.refereeId.first_name)
        : 'Unknown',
      createdAt:  r.createdAt,
    })),
  };
}

// ── Get leaderboard (top referrers) ──────────────────────────────────────────

async function getLeaderboard(limit = 10) {
  return Referral.aggregate([
    { $match: { status: { $in: ['Completed', 'Active'] } } },
    {
      $group: {
        _id:        '$referrerId',
        count:      { $sum: 1 },
        totalKS:    { $sum: '$totalCommissionKS' },
        totalCoins: { $sum: '$totalCommissionCoins' },
      },
    },
    { $sort: { count: -1, totalCoins: -1, totalKS: -1 } },
    { $limit: limit },
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
    { $unwind: '$user' },
    {
      $project: {
        count: 1,
        totalKS: 1,
        totalCoins: 1,
        'user.username':      1,
        'user.telegramId':    1,
        'user.membershipTier': 1,
      },
    },
  ]);
}

// ── Admin: manual commission adjustment ───────────────────────────────────────

/**
 * Manually credit or debit referral commission for a user.
 * @param {number}  adminTid   — admin telegram ID
 * @param {number}  userTid    — target user telegram ID
 * @param {number}  amount     — positive = credit, negative = debit (KS)
 * @param {string}  note       — reason
 */
async function adminAdjustCommission(adminTid, userTid, amount, note = '') {
  const user = await User.findByTelegramId(userTid);
  if (!user) throw new Error('User not found');

  if (amount > 0) {
    await creditKS(user._id, amount, { type: 'AdminCredit', note: note || 'Manual referral adjustment' });
  } else {
    // Debit requires importing debitKS — use AdminDebit type credit with negative amount
    const Transaction = require('../models/Transaction');
    const tx = await Transaction.create({
      userId:        user._id,
      type:          'AdminDebit',
      wallet:        'KS',
      amount:        amount,  // negative
      balanceBefore: user.balanceKS,
      balanceAfter:  Math.max(0, user.balanceKS + amount),
      note:          note || 'Manual referral debit',
    });
    user.balanceKS = Math.max(0, user.balanceKS + amount);
    await user.save();
  }

  await auditLog(adminTid, 'REFERRAL_MANUAL_ADJUST', userTid.toString(), 'System', { amount, note });
}

module.exports = {
  getOrCreateCode,
  getReferralLink,
  registerReferral,
  processTopupCommission,
  reverseTopupCommission,
  processFirstTopup,    // legacy alias
  getStats,
  getLeaderboard,
  adminAdjustCommission,
  maskName,
  resolveTierInfo,
  DEFAULT_TIERS,
};
