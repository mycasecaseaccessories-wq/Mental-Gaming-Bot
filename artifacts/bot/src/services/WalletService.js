/**
 * WalletService
 *
 * All financial operations go through here — never mutate User.balanceKS
 * or User.balanceCoin directly. Every operation writes a Transaction record.
 *
 * Coin Bonus on Top-up (applied automatically):
 *   Silver  → 1.0% of KS amount → Coins
 *   Gold    → 1.5%
 *   Platinum → 2.0%
 */

const mongoose = require('mongoose');
const User = require('../models/User');
const Transaction = require('../models/Transaction');

const COIN_BONUS_RATE = { Silver: 0.01, Gold: 0.015, Platinum: 0.02 };

// ── Dynamic coin bonus rates (from GameConfig with 60s in-memory cache) ──────
let _ratesCache = null;
let _ratesCacheExpiry = 0;

async function getCoinBonusRates() {
  if (Date.now() < _ratesCacheExpiry && _ratesCache) return _ratesCache;
  try {
    const GameConfig = require('../models/GameConfig');
    const cfg = await GameConfig.get();
    _ratesCache = {
      Silver:   cfg.coinBonusRateSilver,
      Gold:     cfg.coinBonusRateGold,
      Platinum: cfg.coinBonusRatePlatinum,
    };
    _ratesCacheExpiry = Date.now() + 60_000; // 60s cache
    return _ratesCache;
  } catch {
    return COIN_BONUS_RATE; // fallback to hardcoded defaults
  }
}

function _invalidateRateCache() {
  _ratesCache = null;
  _ratesCacheExpiry = 0;
}

// ── Unique txId generator ────────────────────────────────────────────────────
function generateTxId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `MGS-${date}-${rand}`;
}

// ── Guard: ensure txId is unique ─────────────────────────────────────────────
async function ensureUniqueTxId() {
  let txId;
  let attempts = 0;
  do {
    txId = generateTxId();
    attempts++;
    if (attempts > 10) throw new Error('Could not generate unique txId');
  } while (await Transaction.isDuplicate(txId));
  return txId;
}

// ── Core credit / debit (atomic using Mongoose session) ──────────────────────

/**
 * Credit KS to a user's wallet.
 * @returns { transaction, user }
 */
async function creditKS(userId, amount, { type = 'AdminCredit', note = '', paymentMethod = null, screenshotUrl = null, txId = null } = {}) {
  if (amount <= 0) throw new Error('Credit amount must be positive');

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const user = await User.findById(userId).session(session);
    if (!user) throw new Error('User not found');

    const before = user.balanceKS;
    user.balanceKS += amount;

    if (type === 'Topup') {
      user.totalDeposited = (user.totalDeposited || 0) + amount;
      user.recalcTier();
    }

    await user.save({ session });

    const finalTxId = txId || (await ensureUniqueTxId());

    const tx = await Transaction.create([{
      userId: user._id,
      type,
      wallet: 'KS',
      amount,
      balanceBefore: before,
      balanceAfter: user.balanceKS,
      txId: finalTxId,
      status: 'Completed',
      paymentMethod,
      screenshotUrl,
      note,
    }], { session });

    await session.commitTransaction();
    return { transaction: tx[0], user };
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
}

/**
 * Debit KS from a user's wallet (validates sufficient balance).
 */
async function debitKS(userId, amount, { type = 'Purchase', note = '', txId = null } = {}) {
  if (amount <= 0) throw new Error('Debit amount must be positive');

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const user = await User.findById(userId).session(session);
    if (!user) throw new Error('User not found');
    if (user.balanceKS < amount) throw new Error(`Insufficient KS balance. Have: ${user.balanceKS}, Need: ${amount}`);

    const before = user.balanceKS;
    user.balanceKS -= amount;
    await user.save({ session });

    const finalTxId = txId || (await ensureUniqueTxId());

    const tx = await Transaction.create([{
      userId: user._id,
      type,
      wallet: 'KS',
      amount: -amount,
      balanceBefore: before,
      balanceAfter: user.balanceKS,
      txId: finalTxId,
      status: 'Completed',
      note,
    }], { session });

    await session.commitTransaction();
    return { transaction: tx[0], user };
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
}

/**
 * Credit Mental Coins to a user.
 */
async function creditCoin(userId, amount, { type = 'Bonus', note = '' } = {}) {
  if (amount <= 0) throw new Error('Coin credit must be positive');

  const user = await User.findById(userId);
  if (!user) throw new Error('User not found');

  const before = user.balanceCoin;
  user.balanceCoin += amount;
  await user.save();

  await Transaction.create({
    userId: user._id,
    type,
    wallet: 'Coin',
    amount,
    balanceBefore: before,
    balanceAfter: user.balanceCoin,
    status: 'Completed',
    note,
  });

  return user;
}

/**
 * Debit Mental Coins from a user.
 */
async function debitCoin(userId, amount, { type = 'Debit', note = '' } = {}) {
  if (amount <= 0) throw new Error('Coin debit must be positive');

  const user = await User.findById(userId);
  if (!user) throw new Error('User not found');
  if (user.balanceCoin < amount) throw new Error('Insufficient coin balance');

  const before = user.balanceCoin;
  user.balanceCoin -= amount;
  await user.save();

  await Transaction.create({
    userId: user._id,
    type,
    wallet: 'Coin',
    amount: -amount,
    balanceBefore: before,
    balanceAfter: user.balanceCoin,
    status: 'Completed',
    note,
  });

  return user;
}

/**
 * Calculate coin bonus for a given KS amount and membership tier.
 * Reads dynamic rates from GameConfig (with 60s cache).
 */
async function calcCoinBonus(amountKS, tier = 'Silver') {
  const rates = await getCoinBonusRates();
  const rate = rates[tier] || rates.Silver;
  return Math.floor(amountKS * rate);
}

/**
 * Create a PENDING top-up transaction (before admin approval).
 */
async function createPendingTopup(userId, { amountKS, paymentMethod, screenshotUrl }) {
  const user = await User.findById(userId);
  if (!user) throw new Error('User not found');

  const alreadyPending = await Transaction.hasPendingTopup(userId);
  if (alreadyPending) throw new Error('You already have a pending top-up request. Please wait for it to be processed.');

  const txId = await ensureUniqueTxId();

  const tx = await Transaction.create({
    userId: user._id,
    type: 'Topup',
    wallet: 'KS',
    amount: amountKS,
    balanceBefore: user.balanceKS,
    balanceAfter: user.balanceKS,
    txId,
    status: 'Pending',
    paymentMethod,
    screenshotUrl,
    note: 'Awaiting admin approval',
  });

  return { transaction: tx, txId, user };
}

/**
 * Approve a pending top-up: credit KS + award coin bonus.
 */
async function approveTopup(txId, adminId) {
  const tx = await Transaction.findOne({ txId, type: 'Topup', status: 'Pending' }).populate('userId');
  if (!tx) throw new Error('Pending top-up not found');

  if (await Transaction.isDuplicate(`${txId}_approved`)) {
    throw new Error('This top-up was already approved');
  }

  const user = tx.userId;
  const amountKS = tx.amount;
  const bonusCoins = await calcCoinBonus(amountKS, user.membershipTier);

  // Mark original pending tx as Completed
  tx.status = 'Completed';
  tx.processedBy = adminId;
  tx.balanceAfter = user.balanceKS + amountKS;
  tx.note = 'Approved by admin';
  tx.txId = `${txId}_approved`;
  await tx.save();

  // Credit KS
  const { user: updatedUser } = await creditKS(user._id, amountKS, {
    type: 'Topup',
    note: `Top-up approved — ${tx.paymentMethod}`,
    paymentMethod: tx.paymentMethod,
    screenshotUrl: tx.screenshotUrl,
    txId,
  });

  // Award coin bonus
  if (bonusCoins > 0) {
    const rates = await getCoinBonusRates();
    await creditCoin(user._id, bonusCoins, {
      type: 'Bonus',
      note: `Top-up bonus — ${user.membershipTier} tier (${Math.round((rates[user.membershipTier] || 0.01) * 100 * 10) / 10}%)`,
    });
  }

  const finalUser = await User.findById(user._id);
  return { user: finalUser, amountKS, bonusCoins, txId };
}

/**
 * Reject a pending top-up.
 */
async function rejectTopup(txId, adminId, reason) {
  const tx = await Transaction.findOne({ txId, type: 'Topup', status: 'Pending' }).populate('userId');
  if (!tx) throw new Error('Pending top-up not found');

  tx.status = 'Rejected';
  tx.processedBy = adminId;
  tx.rejectionReason = reason;
  tx.note = `Rejected: ${reason}`;
  await tx.save();

  return { transaction: tx, user: tx.userId };
}

/**
 * Get wallet balances for a user (by Telegram ID).
 */
async function getBalance(telegramId) {
  const user = await User.findByTelegramId(telegramId);
  if (!user) return null;
  return { balanceKS: user.balanceKS, balanceCoin: user.balanceCoin, tier: user.membershipTier };
}

/**
 * Get transaction history for a user.
 */
async function getHistory(userId, { limit = 10, wallet = null, type = null } = {}) {
  const query = { userId };
  if (wallet) query.wallet = wallet;
  if (type) query.type = type;
  return Transaction.find(query).sort({ timestamp: -1 }).limit(limit);
}

module.exports = {
  creditKS,
  debitKS,
  creditCoin,
  debitCoin,
  calcCoinBonus,
  getCoinBonusRates,
  _invalidateRateCache,
  createPendingTopup,
  approveTopup,
  rejectTopup,
  getBalance,
  getHistory,
  generateTxId,
  COIN_BONUS_RATE,
};
