/**
 * RewardService
 *
 * Central handler for the Coin Rewards redemption catalog (RewardItem) and the
 * app-style Redeem Code system (RedeemCode). Both grant ONE of two reward types:
 *
 *   product → creates a coin-paid Order (amount 0) routed through the normal
 *             fulfillment pipeline (admin delivers / DigitalCode auto-pull).
 *   coupon  → issues a personal Promo restricted to the redeemer.
 *
 * Coins are the ONLY spend currency for reward items (balanceCoin / MC).
 * Redeem codes are free — the code itself is the payment.
 */

const RewardItem = require('../models/RewardItem');
const RedeemCode = require('../models/RedeemCode');
const Promo = require('../models/Promo');
const Product = require('../models/Product');
const Order = require('../models/Order');
const User = require('../models/User');
const { debitCoin, creditCoin } = require('./WalletService');
const { resolveCheckoutFields } = require('../utils/checkoutFields');
const { auditLog } = require('./logger');

// ── Personal coupon code generator ────────────────────────────────────────────
function genCouponCode() {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `RW${rand}`;
}

async function uniqueCouponCode() {
  for (let i = 0; i < 12; i++) {
    const code = genCouponCode();
    if (!(await Promo.exists({ code }))) return code;
  }
  throw new Error('Could not generate a unique coupon code');
}

/**
 * Issue a personal (restricted) discount coupon to a user.
 * @returns the created Promo document
 */
async function issuePersonalCoupon(user, { discountType, value, minOrder = 0, expiryDays = null }, { source = 'reward', adminId = null } = {}) {
  if (!['Flat', 'Percentage'].includes(discountType)) throw new Error('Invalid coupon discount type');
  if (!(value > 0)) throw new Error('Coupon value must be positive');

  const code = await uniqueCouponCode();
  const expiryDate = expiryDays ? new Date(Date.now() + expiryDays * 86400000) : null;

  const promo = await Promo.create({
    code,
    discountType,
    value,
    maxUses: 1,
    expiryDate,
    minOrderAmount: minOrder || 0,
    restrictedToUserId: user._id,
    createdBy: adminId,
    description: `Reward coupon (${source})`,
  });

  return promo;
}

/**
 * Create a coin-paid redemption Order for a product reward.
 * Debits MC first, then creates the Order (Pending). Refunds MC on failure.
 * @returns the created Order document
 */
async function createRedemptionOrder(user, product, { checkoutData = [], coinCost = 0, source = 'reward_item' } = {}) {
  if (coinCost > 0) {
    await debitCoin(user._id, coinCost, { type: 'Debit', note: `Coin reward: ${product.name}` });
  }

  try {
    const order = await Order.create({
      userId: user._id,
      productId: product._id,
      productType: product.productType,
      amount: 0,
      originalAmount: 0,
      quantity: 1,
      paidWith: 'coin',
      coinCost,
      rewardSource: source,
      catalogId: product.catalogId || null,
      checkoutData,
      status: 'Pending',
      statusHistory: [{ status: 'Pending', at: new Date(), note: `Coin redemption (${coinCost} MC)` }],
    });

    if (product.stockCount !== -1) {
      await Product.findByIdAndUpdate(product._id, { $inc: { stockCount: -1 } });
    }

    return order;
  } catch (err) {
    if (coinCost > 0) {
      await creditCoin(user._id, coinCost, { type: 'Refund', note: 'Reward redemption failed — coin refund' }).catch(() => {});
    }
    throw err;
  }
}

// ── Reward grant shape helpers (shared by RewardItem + RedeemCode) ────────────
function grantSpecFrom(doc) {
  if (doc.rewardType === 'coupon') {
    return {
      type: 'coupon',
      discountType: doc.couponDiscountType,
      value: doc.couponValue,
      minOrder: doc.couponMinOrder || 0,
      expiryDays: doc.couponExpiryDays || null,
    };
  }
  return { type: 'product', productId: doc.productId };
}

// ── Reward Item redemption ────────────────────────────────────────────────────

/**
 * Validate whether a user may redeem a reward item.
 * @returns { ok:true, item } | { ok:false, error }
 */
async function checkRewardItem(user, rewardItemId) {
  const item = await RewardItem.findById(rewardItemId).populate('productId');
  if (!item) return { ok: false, error: 'Reward not found.' };
  if (!item.isRedeemable()) return { ok: false, error: 'This reward is not available right now.' };

  if (item.perUserLimit > 0 && item.userRedeemCount(user._id) >= item.perUserLimit) {
    return { ok: false, error: 'You have reached the redemption limit for this reward.' };
  }
  if (user.balanceCoin < item.coinPrice) {
    return { ok: false, error: `Not enough Mental Coins. You have ${user.balanceCoin.toLocaleString()} MC but need ${item.coinPrice.toLocaleString()} MC.` };
  }
  if (item.rewardType === 'product') {
    const product = item.productId;
    if (!product || product.isActive === false || product.status === 'hidden') {
      return { ok: false, error: 'The linked product is no longer available.' };
    }
    if (!product.isInStock()) return { ok: false, error: 'The linked product is out of stock.' };
  }
  return { ok: true, item };
}

/**
 * Record a successful reward-item redemption (stock/limit bookkeeping).
 */
async function recordRewardItemRedemption(item, user) {
  const update = {
    $inc: { redeemCount: 1 },
    $push: { redeemedBy: { userId: user._id, at: new Date() } },
  };
  if (item.stockCount !== -1) update.$inc.stockCount = -1;
  await RewardItem.findByIdAndUpdate(item._id, update);
}

/**
 * Redeem a COUPON reward item (immediate, no field collection).
 * @returns { promo, item }
 */
async function redeemCouponItem(user, item) {
  const check = await checkRewardItem(user, item._id || item);
  if (!check.ok) throw new Error(check.error);
  const rw = check.item;
  if (rw.rewardType !== 'coupon') throw new Error('This reward is not a coupon.');

  await debitCoin(user._id, rw.coinPrice, { type: 'Debit', note: `Coin reward: ${rw.name}` });

  let promo;
  try {
    promo = await issuePersonalCoupon(user, grantSpecFrom(rw), { source: 'reward_item' });
  } catch (err) {
    await creditCoin(user._id, rw.coinPrice, { type: 'Refund', note: 'Reward coupon failed — coin refund' }).catch(() => {});
    throw err;
  }

  await recordRewardItemRedemption(rw, user);
  await auditLog(user.telegramId, 'REWARD_REDEEM_COUPON', rw._id.toString(), 'RewardItem', { name: rw.name, coinPrice: rw.coinPrice, code: promo.code });
  return { promo, item: rw };
}

/**
 * Complete a PRODUCT reward item redemption after checkout fields are collected.
 * @returns { order, item, product }
 */
async function redeemProductItem(user, item, checkoutData = []) {
  const check = await checkRewardItem(user, item._id || item);
  if (!check.ok) throw new Error(check.error);
  const rw = check.item;
  if (rw.rewardType !== 'product') throw new Error('This reward is not a product.');

  const product = rw.productId;
  const order = await createRedemptionOrder(user, product, { checkoutData, coinCost: rw.coinPrice, source: 'reward_item' });
  await recordRewardItemRedemption(rw, user);
  await auditLog(user.telegramId, 'REWARD_REDEEM_PRODUCT', rw._id.toString(), 'RewardItem', { name: rw.name, coinPrice: rw.coinPrice, orderId: order._id.toString() });
  return { order, item: rw, product };
}

// ── Redeem Code ───────────────────────────────────────────────────────────────

/**
 * Validate a redeem code for a user (does NOT consume it).
 * @returns { ok:true, code } | { ok:false, error }
 */
async function checkRedeemCode(user, codeStr) {
  const code = await RedeemCode.findOne({ code: String(codeStr || '').toUpperCase().trim() }).populate('productId');
  if (!code) return { ok: false, error: 'Invalid redeem code.' };
  if (!code.isValid()) return { ok: false, error: 'This code has expired or is no longer active.' };
  if (code.perUserLimit > 0 && code.userUseCount(user._id) >= code.perUserLimit) {
    return { ok: false, error: 'You have already redeemed this code.' };
  }
  if (code.rewardType === 'product') {
    const product = code.productId;
    if (!product || product.isActive === false || product.status === 'hidden') {
      return { ok: false, error: 'The linked product is no longer available.' };
    }
    if (!product.isInStock()) return { ok: false, error: 'The linked product is out of stock.' };
  }
  return { ok: true, code };
}

/**
 * Record a redeem-code use (usage bookkeeping).
 */
async function recordRedeemCodeUse(code, user) {
  await RedeemCode.findByIdAndUpdate(code._id, {
    $inc: { currentUses: 1 },
    $push: { usedBy: { userId: user._id, at: new Date() } },
  });
}

/**
 * Redeem a COUPON-type code (immediate).
 * @returns { promo, code }
 */
async function redeemCouponCode(user, code) {
  const check = await checkRedeemCode(user, code.code || code);
  if (!check.ok) throw new Error(check.error);
  const rc = check.code;
  if (rc.rewardType !== 'coupon') throw new Error('This code does not grant a coupon.');

  const promo = await issuePersonalCoupon(user, grantSpecFrom(rc), { source: 'redeem_code' });
  await recordRedeemCodeUse(rc, user);
  await auditLog(user.telegramId, 'REDEEM_CODE_COUPON', rc._id.toString(), 'RedeemCode', { code: rc.code, issued: promo.code });
  return { promo, code: rc };
}

/**
 * Complete a PRODUCT-type code redemption after fields are collected.
 * @returns { order, code, product }
 */
async function redeemProductCode(user, code, checkoutData = []) {
  const check = await checkRedeemCode(user, code.code || code);
  if (!check.ok) throw new Error(check.error);
  const rc = check.code;
  if (rc.rewardType !== 'product') throw new Error('This code does not grant a product.');

  const product = rc.productId;
  const order = await createRedemptionOrder(user, product, { checkoutData, coinCost: 0, source: 'redeem_code' });
  await recordRedeemCodeUse(rc, user);
  await auditLog(user.telegramId, 'REDEEM_CODE_PRODUCT', rc._id.toString(), 'RedeemCode', { code: rc.code, orderId: order._id.toString() });
  return { order, code: rc, product };
}

// ── Listings (customer) ───────────────────────────────────────────────────────
async function listActiveRewardItems() {
  return RewardItem.find({ status: 'active' }).sort({ sortOrder: 1, createdAt: -1 }).populate('productId');
}

module.exports = {
  // coupons
  issuePersonalCoupon,
  createRedemptionOrder,
  resolveCheckoutFields,
  grantSpecFrom,
  // reward items
  checkRewardItem,
  redeemCouponItem,
  redeemProductItem,
  recordRewardItemRedemption,
  listActiveRewardItems,
  // redeem codes
  checkRedeemCode,
  redeemCouponCode,
  redeemProductCode,
  recordRedeemCodeUse,
};
