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
// product (optional): { productId, category } — enforces scope when provided
async function validatePromo(code, telegramId, orderAmount, product = null) {
  const promo = await Promo.findOne({ code: code.toUpperCase().trim() });
  if (!promo) return { valid: false, error: 'Invalid promo code.' };
  if (!promo.isValid()) return { valid: false, error: 'This promo code has expired or is no longer active.' };

  const user = await User.findByTelegramId(telegramId);
  if (!user) return { valid: false, error: 'User not found.' };

  if (promo.restrictedToUserId && promo.restrictedToUserId.toString() !== user._id.toString()) {
    return { valid: false, error: 'This code is not valid for your account.' };
  }

  if (promo.hasUserUsed(user._id)) {
    return {
      valid: false,
      error: (promo.perUserLimit || 1) > 1
        ? `You have already used this code ${promo.perUserLimit} times (the limit).`
        : 'You have already used this promo code.',
    };
  }

  if (product && !promo.appliesToProduct(product)) {
    return { valid: false, error: `This code only applies to: ${scopeText(promo)}.` };
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

// ── Human-readable scope label ────────────────────────────────────────────────
function scopeText(promo) {
  if (!promo.scopeType || promo.scopeType === 'all') return 'All products';
  if (promo.scopeType === 'category') return (promo.scopeCategories || []).join(', ') || 'selected categories';
  return promo._scopeProductNames || 'selected products';
}

// ── Human-readable discount label ─────────────────────────────────────────────
function discountText(promo) {
  return promo.discountType === 'Flat'
    ? `${promo.value.toLocaleString()} KS off`
    : `${promo.value}% off`;
}

// ── List a user's usable coupons ──────────────────────────────────────────────
// product (optional) filters to codes usable for that product.
async function listUserCoupons(userMongoId, product = null) {
  const now = new Date();
  const promos = await Promo.find({
    restrictedToUserId: userMongoId,
    isActive: true,
    $or: [{ expiryDate: null }, { expiryDate: { $gt: now } }],
  }).sort({ createdAt: -1 }).limit(30);

  return promos.filter((p) => {
    if (!p.isValid()) return false;
    if (p.hasUserUsed(userMongoId)) return false;
    if (product && !p.appliesToProduct(product)) return false;
    return true;
  });
}

// ── Auto-generate a coupon code ───────────────────────────────────────────────
function generateCode(prefix = 'MGS') {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}-${s}`;
}

// ── Create an auto-generated coupon (shared or personal) ─────────────────────
async function generateCoupon(adminId, {
  discountType, value, maxUses = null, perUserLimit = 1, expiryDate = null,
  scopeType = 'all', scopeCategories = [], scopeProducts = [],
  restrictedToUserId = null, source = 'admin', description = '', prefix = 'MGS',
}) {
  let promo = null;
  for (let attempt = 0; attempt < 5 && !promo; attempt++) {
    try {
      promo = await Promo.create({
        code: generateCode(prefix),
        discountType, value,
        maxUses, perUserLimit,
        expiryDate,
        scopeType, scopeCategories, scopeProducts,
        restrictedToUserId, source,
        createdBy: adminId,
        description,
      });
    } catch (e) {
      if (e.code !== 11000) throw e; // duplicate code → retry, else rethrow
    }
  }
  if (!promo) throw new Error('Could not generate a unique coupon code');
  await auditLog(adminId, 'CREATE_PROMO', promo._id.toString(), 'Promo', { code: promo.code, source });
  return promo;
}

// ── Calculate discount amount ─────────────────────────────────────────────────
function calcDiscount(promo, orderAmount) {
  if (promo.discountType === 'Flat') {
    return Math.min(promo.value, orderAmount);
  }
  return Math.floor((promo.value / 100) * orderAmount);
}

// ── Apply promo (mark as used) — atomic guards on maxUses & perUserLimit ─────
async function applyPromo(code, telegramId) {
  const normCode = code.toUpperCase().trim();
  const base = await Promo.findOne({ code: normCode });
  if (!base) throw new Error('Promo not found');

  const user = await User.findByTelegramId(telegramId);
  if (!user) throw new Error('User not found');

  const perUserLimit = base.perUserLimit || 1;

  // Conditional update: only consume if total & per-user limits still hold.
  const query = {
    code: normCode,
    isActive: true,
    ...(base.maxUses ? { currentUses: { $lt: base.maxUses } } : {}),
    $expr: {
      $lt: [
        {
          $size: {
            $filter: {
              input: { $ifNull: ['$usedBy', []] },
              as: 'u',
              cond: { $eq: ['$$u.userId', user._id] },
            },
          },
        },
        perUserLimit,
      ],
    },
  };

  const promo = await Promo.findOneAndUpdate(
    query,
    { $push: { usedBy: { userId: user._id } }, $inc: { currentUses: 1 } },
    { new: true }
  );
  if (!promo) throw new Error('Promo code is no longer available (limit reached)');

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
  listUserCoupons,
  generateCoupon,
  scopeText,
  discountText,
  getBundleDiscount,
  createPromo,
  listPromos,
  deactivatePromo,
  BUNDLE_DISCOUNT_PCT,
};
