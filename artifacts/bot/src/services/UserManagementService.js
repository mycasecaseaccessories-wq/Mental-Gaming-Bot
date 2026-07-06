/**
 * UserManagementService
 *
 * Centralizes all admin user operations:
 *   warn / unwarn / ban / unban / restrict / unrestrict / info / list
 *
 * Every action writes to AuditLog automatically.
 */

const User = require('../models/User');
const { auditLog } = require('./logger');

const ALL_RIGHTS = ['order', 'topup', 'support', 'chat'];

// ── Resolve user by Telegram ID, @username, or numeric string ───────────────
async function resolveUser(identifier) {
  if (!identifier) return null;

  const clean = String(identifier).trim().replace(/^@/, '');
  const asNumber = parseInt(clean, 10);

  if (!isNaN(asNumber)) {
    const user = await User.findOne({ telegramId: asNumber });
    if (user) return user;
  }

  return User.findOne({ username: new RegExp(`^${clean}$`, 'i') });
}

// ── Warn ─────────────────────────────────────────────────────────────────────
async function warnUser(targetIdentifier, adminId, reason = 'No reason given') {
  const user = await resolveUser(targetIdentifier);
  if (!user) throw new Error('User not found');
  if (user.telegramId === adminId) throw new Error('Cannot warn the admin');

  user.warningsCount = (user.warningsCount || 0) + 1;

  let autoBanned = false;
  if (user.warningsCount >= 3) {
    user.isBlocked = true;
    autoBanned = true;
  }

  await user.save();
  await auditLog(adminId, 'WARN_USER', String(user.telegramId), 'User', {
    reason,
    warningsCount: user.warningsCount,
    autoBanned,
  });

  return { user, autoBanned };
}

// ── Unwarn ────────────────────────────────────────────────────────────────────
async function unwarnUser(targetIdentifier, adminId) {
  const user = await resolveUser(targetIdentifier);
  if (!user) throw new Error('User not found');

  user.warningsCount = Math.max(0, (user.warningsCount || 1) - 1);
  if (user.warningsCount < 3 && user.isBlocked) user.isBlocked = false;
  await user.save();

  await auditLog(adminId, 'UNWARN_USER', String(user.telegramId), 'User', {
    newCount: user.warningsCount,
  });

  return user;
}

// ── Ban ───────────────────────────────────────────────────────────────────────
async function banUser(targetIdentifier, adminId, reason = 'No reason given') {
  const user = await resolveUser(targetIdentifier);
  if (!user) throw new Error('User not found');
  if (user.telegramId === adminId) throw new Error('Cannot ban the admin');

  user.isBlocked = true;
  await user.save();

  await auditLog(adminId, 'BAN_USER', String(user.telegramId), 'User', { reason });
  return user;
}

// ── Unban ─────────────────────────────────────────────────────────────────────
async function unbanUser(targetIdentifier, adminId) {
  const user = await resolveUser(targetIdentifier);
  if (!user) throw new Error('User not found');

  user.isBlocked = false;
  user.warningsCount = 0;
  await user.save();

  await auditLog(adminId, 'UNBAN_USER', String(user.telegramId), 'User');
  return user;
}

// ── Restrict (block specific rights) ─────────────────────────────────────────
async function restrictUser(targetIdentifier, adminId, rights = []) {
  const user = await resolveUser(targetIdentifier);
  if (!user) throw new Error('User not found');

  const toAdd = rights.filter((r) => ALL_RIGHTS.includes(r) && !user.restrictedRights.includes(r));
  user.restrictedRights.push(...toAdd);
  await user.save();

  await auditLog(adminId, 'RESTRICT_USER', String(user.telegramId), 'User', { rights: toAdd });
  return { user, restricted: toAdd };
}

// ── Unrestrict ────────────────────────────────────────────────────────────────
async function unrestrictUser(targetIdentifier, adminId, rights = []) {
  const user = await resolveUser(targetIdentifier);
  if (!user) throw new Error('User not found');

  const toRemove = rights.length ? rights : ALL_RIGHTS;
  user.restrictedRights = user.restrictedRights.filter((r) => !toRemove.includes(r));
  await user.save();

  await auditLog(adminId, 'UNRESTRICT_USER', String(user.telegramId), 'User', { rights: toRemove });
  return user;
}

// ── Full user info object ─────────────────────────────────────────────────────
async function getUserInfo(identifier) {
  const user = await resolveUser(identifier);
  if (!user) return null;

  const Order  = require('../models/Order');
  const Transaction = require('../models/Transaction');

  const [orderCount, pendingOrders, totalSpent, pendingTopup] = await Promise.all([
    Order.countDocuments({ userId: user._id }),
    Order.countDocuments({ userId: user._id, status: 'Pending' }),
    Order.aggregate([
      { $match: { userId: user._id, status: 'Success' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    Transaction.findOne({ userId: user._id, type: 'Topup', status: 'Pending' }),
  ]);

  return {
    user,
    orderCount,
    pendingOrders,
    totalSpent: totalSpent[0]?.total || 0,
    hasPendingTopup: !!pendingTopup,
  };
}

// ── Paginated user list ───────────────────────────────────────────────────────
async function listUsers({ page = 1, limit = 10, filter = {} } = {}) {
  const skip = (page - 1) * limit;
  const [users, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    User.countDocuments(filter),
  ]);
  return { users, total, page, totalPages: Math.ceil(total / limit) };
}

// ── Search users ──────────────────────────────────────────────────────────────
async function searchUsers(query) {
  const asNumber = parseInt(query, 10);
  const conditions = [{ username: new RegExp(query, 'i') }];
  if (!isNaN(asNumber)) conditions.push({ telegramId: asNumber });
  return User.find({ $or: conditions }).limit(10);
}

// ── Adjust wallet balance (admin credit/debit) ─────────────────────────────────
async function adjustBalance(targetIdentifier, adminId, amountKS, note = '') {
  const user = await resolveUser(targetIdentifier);
  if (!user) throw new Error('User not found');

  const { creditKS, debitKS } = require('./WalletService');

  let result;
  if (amountKS > 0) {
    result = await creditKS(user._id, amountKS, { type: 'AdminCredit', note });
  } else {
    result = await debitKS(user._id, Math.abs(amountKS), { type: 'AdminDebit', note });
  }

  await auditLog(adminId, amountKS > 0 ? 'ADMIN_CREDIT' : 'ADMIN_DEBIT', String(user.telegramId), 'User', {
    amount: amountKS,
    note,
  });

  return result;
}

module.exports = {
  resolveUser,
  warnUser,
  unwarnUser,
  banUser,
  unbanUser,
  restrictUser,
  unrestrictUser,
  getUserInfo,
  listUsers,
  searchUsers,
  adjustBalance,
  ALL_RIGHTS,
};
