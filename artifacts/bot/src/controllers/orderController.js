const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const { computeProductPrice } = require('./pricingController');

async function createOrder(telegramId, productId, screenshotUrl = null) {
  const user = await User.findByTelegramId(telegramId);
  if (!user) throw new Error('User not found');
  if (!user.hasRight('order')) throw new Error('User is restricted from placing orders');

  const product = await Product.findById(productId);
  if (!product || !product.isActive) throw new Error('Product not found or unavailable');
  if (!product.isInStock()) throw new Error('Product is out of stock');

  const amount = await computeProductPrice(product);

  const order = await Order.create({
    userId: user._id,
    productId: product._id,
    amount,
    screenshotUrl,
    status: 'Pending',
  });

  return { order, product, user, amount };
}

async function processOrder(orderId, adminId, deliveredData = null) {
  const order = await Order.findById(orderId).populate('userId').populate('productId');
  if (!order) throw new Error('Order not found');
  if (order.status !== 'Pending') throw new Error(`Order is already ${order.status}`);

  order.status = 'Success';
  order.processedBy = adminId;
  order.deliveredData = deliveredData;
  await order.save();

  if (order.productId.stockCount > 0) {
    await Product.findByIdAndUpdate(order.productId._id, { $inc: { stockCount: -1 } });
  }

  return order;
}

async function cancelOrder(orderId, adminId, reason = '') {
  const order = await Order.findById(orderId);
  if (!order) throw new Error('Order not found');
  if (order.status !== 'Pending') throw new Error(`Cannot cancel a ${order.status} order`);

  order.status = 'Cancelled';
  order.processedBy = adminId;
  order.notes = reason;
  await order.save();

  return order;
}

async function getUserOrders(telegramId, status = null) {
  const user = await User.findByTelegramId(telegramId);
  if (!user) return [];
  return Order.findByUser(user._id, status);
}

module.exports = { createOrder, processOrder, cancelOrder, getUserOrders };
