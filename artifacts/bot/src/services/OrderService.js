/**
 * OrderService
 *
 * Central handler for order lifecycle:
 *   createOrder → completeOrder | cancelAndRefund
 *
 * Handles both product types:
 *   DirectTopup  → admin delivers manually
 *   DigitalCode  → code pulled from GameCode collection automatically
 */

const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const GameCode = require('../models/GameCode');
const User = require('../models/User');
const { debitKS, creditKS } = require('./WalletService');
const { auditLog } = require('./logger');
const { config } = require('../../config/settings');

const LOW_STOCK_THRESHOLD = 5;

// ── Stock warning helper ─────────────────────────────────────────────────────
async function checkStockWarning(product, telegram) {
  const threshold = (typeof product.stockWarningThreshold === 'number' && product.stockWarningThreshold > 0)
    ? product.stockWarningThreshold
    : LOW_STOCK_THRESHOLD;
  if (product.productType === 'DigitalCode') {
    const available = await GameCode.countAvailable(product._id);
    if (available <= threshold && available > 0) {
      try {
        await telegram.sendMessage(
          config.bot.adminId,
          `⚠️ *Low Stock Warning*\n\n` +
          `📦 Product: *${product.name}*\n` +
          `🗂 Type: Digital Code\n` +
          `📉 Remaining Codes: *${available}*\n\n` +
          `_Add more codes with /addcodes_`,
          { parse_mode: 'Markdown' }
        );
      } catch {}
    }
    if (available === 0) return false;
  } else {
    if (product.stockCount !== -1 && product.stockCount <= threshold && product.stockCount > 0) {
      try {
        await telegram.sendMessage(
          config.bot.adminId,
          `⚠️ *Low Stock Warning*\n\n` +
          `📦 Product: *${product.name}*\n` +
          `📉 Units Left: *${product.stockCount}*`,
          { parse_mode: 'Markdown' }
        );
      } catch {}
    }
  }
  return true;
}

// ── Create order (deducts wallet atomically) ─────────────────────────────────
async function createOrder(telegramId, productId, { gameId = null, zoneId = null, gameName = null, promoCode = null, promoDiscount = 0, tierDiscount = 0, tierDiscountPct = 0, finalAmount = null, checkoutData = [] } = {}) {
  const user = await User.findByTelegramId(telegramId);
  if (!user) throw new Error('User not found');

  const product = await Product.findById(productId);
  if (!product || !product.isActive) throw new Error('Product not available');
  if (!product.isInStock()) throw new Error('Product is out of stock');

  const { price: effectivePrice } = product.getEffectivePrice();
  const amount = finalAmount !== null ? finalAmount : effectivePrice;

  if (user.balanceKS < amount) {
    throw new Error(`Insufficient balance. You have ${user.balanceKS.toLocaleString()} KS but need ${amount.toLocaleString()} KS.`);
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  let order;
  try {
    order = await Order.create([{
      userId: user._id,
      productId: product._id,
      productType: product.productType,
      amount,
      originalAmount: effectivePrice,
      promoCode,
      promoDiscount,
      tierDiscount,
      tierDiscountPct,
      gameId,
      zoneId,
      gameName,
      checkoutData,
      status: 'Pending',
    }], { session });
    order = order[0];

    // Deduct wallet
    user.balanceKS -= amount;
    await user.save({ session });

    await session.commitTransaction();
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }

  // Decrement stock count for non-unlimited products
  if (product.stockCount !== -1) {
    await Product.findByIdAndUpdate(product._id, { $inc: { stockCount: -1 } });
  }

  await auditLog(telegramId, 'ORDER_CREATED', order._id.toString(), 'Order', {
    product: product.name,
    amount,
    productType: product.productType,
  });

  return { order, product, user };
}

// ── Mark order as Processing ──────────────────────────────────────────────────
async function markProcessing(orderId, adminId) {
  const order = await Order.findById(orderId).populate('userId').populate('productId');
  if (!order) throw new Error('Order not found');
  if (order.status === 'Processing') throw new Error('Order is already Processing');
  if (order.status !== 'Pending') throw new Error(`Cannot mark Processing — order is ${order.status}`);

  order.status = 'Processing';
  order.statusHistory.push({ status: 'Processing', at: new Date(), byAdminId: adminId });
  await order.save();

  await auditLog(adminId, 'ORDER_MARK_PROCESSING', orderId, 'Order', {});
  return order;
}

// ── Complete order — admin triggered ─────────────────────────────────────────
async function completeOrder(orderId, adminId, deliveredData, telegram) {
  const order = await Order.findById(orderId).populate('userId').populate('productId');
  if (!order) throw new Error('Order not found');
  if (!['Pending', 'Processing'].includes(order.status)) throw new Error(`Order is already ${order.status}`);

  let finalDelivery = deliveredData;

  // Auto-pull code for DigitalCode products
  if (order.productType === 'DigitalCode' && !deliveredData) {
    const gameCode = await GameCode.pullCode(order.productId._id);
    if (!gameCode) throw new Error('No digital codes available. Add codes with /addcodes.');
    await GameCode.findByIdAndUpdate(gameCode._id, { usedBy: order._id });
    finalDelivery = gameCode.code;
  }

  order.status = 'Success';
  order.deliveredData = finalDelivery;
  order.processedBy = adminId;
  order.statusHistory.push({ status: 'Success', at: new Date(), byAdminId: adminId, note: 'Delivered' });
  await order.save();

  // Stock warning after completion
  if (telegram && order.productId) {
    await checkStockWarning(order.productId, telegram);
  }

  await auditLog(adminId, 'ORDER_COMPLETED', orderId, 'Order', { productType: order.productType });

  // ── Notifications + Tier recalc (non-blocking) ─────────────────────────────
  setImmediate(async () => {
    try {
      const NotificationService = require('./NotificationService');
      const TierService         = require('./TierService');
      const telegramId = order.userId?.telegramId;
      if (telegramId) {
        await NotificationService.notifyOrderCompleted(telegramId, {
          orderId:     order._id,
          productName: order.productId?.name || 'Unknown',
          amount:      order.amount,
        });
      }
      await TierService.recalcUserTiers(order.userId._id);
    } catch (e) {
      console.error('[OrderService] post-complete hooks error:', e.message);
    }
  });

  return order;
}

// ── Cancel & Refund ───────────────────────────────────────────────────────────
async function cancelAndRefund(orderId, adminId, reason) {
  const order = await Order.findById(orderId).populate('userId').populate('productId');
  if (!order) throw new Error('Order not found');
  if (order.status !== 'Pending') throw new Error(`Order is already ${order.status}`);

  order.status = 'Cancelled';
  order.cancelReason = reason;
  order.processedBy = adminId;
  order.statusHistory.push({ status: 'Cancelled', at: new Date(), byAdminId: adminId, note: reason });
  await order.save();

  // Refund KS
  const { transaction } = await creditKS(order.userId._id, order.amount, {
    type: 'Refund',
    note: `Refund for cancelled order #${orderId.slice(-8).toUpperCase()}`,
  });

  order.refundTransactionId = transaction.txId;
  await order.save();

  // Restore stock if non-unlimited
  if (order.productId && order.productId.stockCount !== -1) {
    await Product.findByIdAndUpdate(order.productId._id, { $inc: { stockCount: 1 } });
  }

  await auditLog(adminId, 'ORDER_CANCELLED_REFUNDED', orderId, 'Order', { reason, refundAmount: order.amount });

  // ── Notifications (non-blocking) ──────────────────────────────────────────
  setImmediate(async () => {
    try {
      const NotificationService = require('./NotificationService');
      const telegramId = order.userId?.telegramId;
      if (telegramId) {
        await NotificationService.notifyOrderCancelled(telegramId, {
          orderId:     order._id,
          productName: order.productId?.name || 'Unknown',
          reason,
        });
        await NotificationService.notifyRefundCompleted(telegramId, {
          orderId:     order._id,
          productName: order.productId?.name || 'Unknown',
          amount:      order.amount,
        });
      }
    } catch (e) {
      console.error('[OrderService] cancel notification error:', e.message);
    }
  });

  return order;
}

// ── Pull digital code (for preview) ──────────────────────────────────────────
async function peekDigitalStock(productId) {
  return GameCode.countAvailable(productId);
}

// ── Add digital codes (admin) ─────────────────────────────────────────────────
async function addDigitalCodes(productId, codes, adminId) {
  const docs = codes.map((code) => ({ productId, code: code.trim(), addedBy: adminId }));
  const inserted = await GameCode.insertMany(docs, { ordered: false });

  // Sync stockCount on product
  const available = await GameCode.countAvailable(productId);
  await Product.findByIdAndUpdate(productId, { stockCount: available });

  await auditLog(adminId, 'ADD_DIGITAL_CODES', productId.toString(), 'Product', {
    count: inserted.length,
  });

  return inserted.length;
}

module.exports = {
  createOrder,
  markProcessing,
  completeOrder,
  cancelAndRefund,
  checkStockWarning,
  peekDigitalStock,
  addDigitalCodes,
};
