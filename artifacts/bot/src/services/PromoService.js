/**
 * PromoService
 *
 * Promo code validation, application, and management.
 * Also handles Bundle discount logic (5% off when 2+ items share a bundleGroup).
 */

const Promo = require('../models/Promo');
const User = require('../models/User');
const Product = require('../models/Product');
const { auditLog } = require('./logger');

const BUNDLE_DISCOUNT_PCT = 5;

// ── Validate a promo code ─────────────────────────────────────────────────────
async function validatePromo(code, telegramId, orderAmount) {
  const promo = await Promo.findOne({ code: code.toUpperCase().trim() });
  if (!promo) return { valid: false, error: 'Invalid promo code.' };
  if (!promo.isValid()) return { valid: false, error: 'This promo code has expired or is no longer active.' };

  const user = await User.findByTelegramId(telegramId);
  if (!user) return { valid: false, error: 'User not found.' };

  if (promo.restrictedToUserId && promo.restrictedToUserId.toString() !== user._id.toString()) {
    return { valid: false, error: 'This code is not valid for your account.' };
  }

  if (promo.hasUserUsed(user._id)) {
    return { valid: false, error: 'You have already used this promo code.' };
  }

  if (orderAmount < promo.minOrderAmount) {
    return {
      valid: false,
      error: `Minimum order amount for this promo is ${promo.minOrderAmount.toLocaleString()} KS.`,
    };
  }

  const discount = calcDiscount(promo, orderAmount);
  return { valid: true, promo, discount };
}

// ── Calculate discount amount ─────────────────────────────────────────────────
function calcDiscount(promo, orderAmount) {
  if (promo.discountType === 'Flat') {
    return Math.min(promo.value, orderAmount);
  }
  return Math.floor((promo.value / 100) * orderAmount);
}

// ── Apply promo (mark as used) ────────────────────────────────────────────────
async function applyPromo(code, telegramId) {
  const promo = await Promo.findOne({ code: code.toUpperCase().trim() });
  if (!promo) throw new Error('Promo not found');

  const user = await User.findByTelegramId(telegramId);
  if (!user) throw new Error('User not found');

  promo.usedBy.push({ userId: user._id });
  promo.currentUses += 1;
  await promo.save();

  await auditLog(user.telegramId, 'PROMO_USED', promo._id.toString(), 'Promo', {
    code: promo.code,
    discount: calcDiscount(promo, 0),
  });

  return promo;
}

// ── Check bundle discount ──────────────────────────────────────────────────────
async function getBundleDiscount(productIds) {
  if (!productIds || productIds.length < 2) return 0;

  const products = await Product.find({ _id: { $in: productIds }, bundleGroup: { $ne: null } });
  const groups = {};
  for (const p of products) {
    groups[p.bundleGroup] = (groups[p.bundleGroup] || 0) + 1;
  }

  const hasBundlePair = Object.values(groups).some((count) => count >= 2);
  return hasBundlePair ? BUNDLE_DISCOUNT_PCT : 0;
}

// ── Admin: create promo ────────────────────────────────────────────────────────
async function createPromo(adminId, { code, discountType, value, maxUses, expiryDate, minOrderAmount, description }) {
  const promo = await Promo.create({
    code: code.toUpperCase().trim(),
    discountType,
    value,
    maxUses: maxUses || null,
    expiryDate: expiryDate || null,
    minOrderAmount: minOrderAmount || 0,
    createdBy: adminId,
    description: description || '',
  });

  await auditLog(adminId, 'CREATE_PROMO', promo._id.toString(), 'Promo', { code: promo.code });
  return promo;
}

// ── Admin: list promos ────────────────────────────────────────────────────────
async function listPromos({ activeOnly = true } = {}) {
  const query = activeOnly ? { isActive: true } : {};
  return Promo.find(query).sort({ createdAt: -1 });
}

// ── Admin: deactivate promo ───────────────────────────────────────────────────
async function deactivatePromo(code, adminId) {
  const promo = await Promo.findOneAndUpdate(
    { code: code.toUpperCase().trim() },
    { isActive: false },
    { new: true }
  );
  if (!promo) throw new Error('Promo not found');
  await auditLog(adminId, 'DEACTIVATE_PROMO', promo._id.toString(), 'Promo', { code: promo.code });
  return promo;
}

module.exports = {
  validatePromo,
  calcDiscount,
  applyPromo,
  getBundleDiscount,
  createPromo,
  listPromos,
  deactivatePromo,
  BUNDLE_DISCOUNT_PCT,
};
