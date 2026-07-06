/**
 * My Orders — Full order history
 *
 * /orders       — paginated list (8 per page) with status filter
 * order_detail  — rich detail: price breakdown, delivered code, reorder
 * order_reorder — one-tap reorder from a previous order
 */

const { Markup } = require('telegraf');
const Nav = require('../services/NavigationService');
const { getTheme } = require('../services/ThemeService');
const { buildMessage, price, statusBadge, formatDate, truncate } = require('../utils/ui');
const Order = require('../models/Order');

const PAGE_SIZE = 8;

// ── Status filter icon map ─────────────────────────────────────────────────────
const STATUS_ICON = {
  Pending:    '🟡',
  Processing: '🔵',
  Success:    '🟢',
  Cancelled:  '🔴',
  Refunded:   '🔵',
};

// ── Build orders list text + keyboard ─────────────────────────────────────────
async function buildOrdersPage(telegramId, page = 1, filter = 'all') {
  const User = require('../models/User');
  const user = await User.findByTelegramId(telegramId);
  if (!user) return null;

  const query = { userId: user._id };
  if (filter !== 'all') {
    const filterMap = { pending: 'Pending', completed: 'Success', cancelled: 'Cancelled' };
    if (filterMap[filter]) query.status = filterMap[filter];
  }

  const total   = await Order.countDocuments(query);
  const orders  = await Order.find(query)
    .populate('productId', 'name productType')
    .sort({ timestamp: -1 })
    .skip((page - 1) * PAGE_SIZE)
    .limit(PAGE_SIZE);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const counts = await Order.aggregate([
    { $match: { userId: user._id } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const cMap = Object.fromEntries(counts.map((c) => [c._id, c.count]));

  return { orders, total, page, totalPages, filter, cMap };
}

// ── Keyboard helpers ──────────────────────────────────────────────────────────
function ordersKeyboard(page, totalPages, filter, orderRows) {
  const filterBtns = [
    Markup.button.callback(filter === 'all'       ? '● All'       : '○ All',       `orders_list:1:all`),
    Markup.button.callback(filter === 'pending'   ? '● Pending'   : '○ Pending',   `orders_list:1:pending`),
    Markup.button.callback(filter === 'completed' ? '● Done'      : '○ Done',      `orders_list:1:completed`),
  ];

  const navBtns = [];
  if (page > 1)          navBtns.push(Markup.button.callback('◀ Prev', `orders_list:${page - 1}:${filter}`));
  if (page < totalPages) navBtns.push(Markup.button.callback('Next ▶', `orders_list:${page + 1}:${filter}`));

  const rows = [
    filterBtns,
    ...orderRows,
  ];
  if (navBtns.length) rows.push(navBtns);
  rows.push(Nav.backButton('🔙 Main Menu'));

  return Markup.inlineKeyboard(rows);
}

// ── Nav view (entry point) ────────────────────────────────────────────────────
Nav.register({
  id: 'my_orders',
  title: '📦 My Orders',
  build: async (ctx, theme) => {
    const data = await buildOrdersPage(ctx.from.id, 1, 'all');
    if (!data) return { text: '❌ Could not load orders.', keyboard: Markup.inlineKeyboard([Nav.backButton()]) };

    if (!data.orders.length) {
      return {
        text: buildMessage(theme, [{
          title: '📦 My Orders',
          lines: [
            `${theme.emoji.bullet} You have no orders yet.`,
            `${theme.emoji.store} Use /shop to browse products.`,
          ],
        }]),
        keyboard: Markup.inlineKeyboard([
          [Markup.button.callback('🛒 Go to Shop', 'nav:go:shop')],
          Nav.backButton('🔙 Main Menu'),
        ]),
      };
    }

    const { orders, total, totalPages, cMap } = data;
    const orderRows = orders.map((o) => [
      Markup.button.callback(
        `${STATUS_ICON[o.status] || '⚪'} ${truncate(o.productId?.name || 'Order', 22)} — ${price(o.amount)}`,
        `order_detail:${o._id}`
      ),
    ]);

    const text = buildMessage(theme, [{
      title: '📦 My Orders',
      lines: [
        `${theme.emoji.bullet} Total: ${theme.format.bold(String(total))}`,
        `🟡 Pending: ${cMap['Pending'] || 0}  🟢 Done: ${cMap['Success'] || 0}  🔴 Cancelled: ${cMap['Cancelled'] || 0}`,
        ``,
        `_Tap an order to view details:_`,
      ],
    }]);

    return {
      text,
      keyboard: ordersKeyboard(1, totalPages, 'all', orderRows),
    };
  },
});

module.exports = function registerOrders(bot) {

  bot.command('orders', async (ctx) => {
    await Nav.navigate(ctx, 'my_orders');
  });

  bot.hears(['📦 My Orders', '📦 အော်ဒါများ'], async (ctx) => {
    await Nav.navigate(ctx, 'my_orders');
  });

  // ── Entry point from product page ─────────────────────────────────────────
  bot.action(/^order_start:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const productId = ctx.match[1];
    ctx.session.orderProductId = productId;
    ctx.session.orderProduct = null;
    await ctx.scene.enter('order_scene');
  });

  // ── Paginated orders list ─────────────────────────────────────────────────
  bot.action(/^orders_list:(\d+):(\w+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const page   = parseInt(ctx.match[1], 10);
    const filter = ctx.match[2];
    const theme  = getTheme(ctx.user);

    const data = await buildOrdersPage(ctx.from.id, page, filter);
    if (!data || !data.orders.length) {
      return ctx.answerCbQuery('No orders found for this filter.', { show_alert: true });
    }

    const { orders, total, totalPages, cMap } = data;
    const orderRows = orders.map((o) => [
      Markup.button.callback(
        `${STATUS_ICON[o.status] || '⚪'} ${truncate(o.productId?.name || 'Order', 22)} — ${price(o.amount)}`,
        `order_detail:${o._id}`
      ),
    ]);

    const filterLabel = { all: 'All', pending: 'Pending', completed: 'Completed' }[filter] || 'All';
    const text = buildMessage(theme, [{
      title: `📦 My Orders — ${filterLabel}`,
      lines: [
        `${theme.emoji.bullet} Total: ${theme.format.bold(String(total))}`,
        `🟡 Pending: ${cMap['Pending'] || 0}  🟢 Done: ${cMap['Success'] || 0}  🔴 Cancelled: ${cMap['Cancelled'] || 0}`,
        total > PAGE_SIZE ? `📄 Page ${page}/${totalPages}` : null,
        ``,
        `_Tap an order to view details:_`,
      ].filter(Boolean),
    }]);

    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...ordersKeyboard(page, totalPages, filter, orderRows),
    }).catch(() => ctx.reply(text, {
      parse_mode: 'Markdown',
      ...ordersKeyboard(page, totalPages, filter, orderRows),
    }));
  });

  // ── Order detail view ─────────────────────────────────────────────────────
  bot.action(/^order_detail:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const orderId = ctx.match[1];

    try {
      const order = await Order.findById(orderId).populate('productId');
      if (!order) return ctx.reply('❌ Order not found.');

      const theme   = getTheme(ctx.user);
      const product = order.productId;
      const shortId = orderId.slice(-8).toUpperCase();

      // ── Price breakdown ────────────────────────────────────────────────────
      const basePrice  = order.originalAmount || order.amount;
      const tierDis    = order.tierDiscount || 0;
      const tierPct    = order.tierDiscountPct || 0;
      const promoDis   = order.promoDiscount || 0;
      const charged    = order.amount;
      const hasDiscount = tierDis > 0 || promoDis > 0 || basePrice !== charged;

      const breakdownLines = [];
      if (hasDiscount) {
        breakdownLines.push(``, `💰 *Price Breakdown:*`);
        breakdownLines.push(`  Base: ${price(basePrice)}`);
        if (tierDis > 0) breakdownLines.push(`  🏷 Tier Discount (${tierPct}%): −${price(tierDis)}`);
        if (order.promoCode) breakdownLines.push(`  🎟 Promo ${order.promoCode}: −${price(promoDis)}`);
        breakdownLines.push(`  ──────────────`);
        breakdownLines.push(`  ✨ Charged: *${price(charged)}*`);
      }

      // ── Delivery info (checkoutData array or legacy gameId) ───────────────
      let gameIdLine = null;
      if (order.checkoutData && order.checkoutData.length > 0) {
        gameIdLine = order.checkoutData
          .map((d) => `📋 ${d.label}: ${theme.format.code(d.value)}`)
          .join('\n');
      } else if (order.gameId) {
        gameIdLine = `🎮 Game ID: ${theme.format.code(order.gameId)}${order.zoneId ? ` / Zone: ${order.zoneId}` : ''}`;
      }

      // ── Delivered code ─────────────────────────────────────────────────────
      const deliveryLines = [];
      if (order.status === 'Success' && order.deliveredData) {
        deliveryLines.push(``, `📬 *Delivered:*`);
        deliveryLines.push(theme.format.code(order.deliveredData));
      }

      // ── Cancel reason ──────────────────────────────────────────────────────
      const cancelLine = order.status === 'Cancelled' && order.cancelReason
        ? [``, `❌ *Reason:* ${order.cancelReason}`]
        : [];

      const lines = [
        `🆔 Order: ${theme.format.code(shortId)}`,
        `📦 *${product?.name || 'Unknown Product'}*`,
        gameIdLine,
        `📊 Status: ${statusBadge(order.status)}`,
        `🗂 Type: ${product?.productType === 'DigitalCode' ? '🎁 Digital Code' : '🎮 Direct Top-up'}`,
        `🕐 Placed: ${formatDate(order.timestamp)}`,
        ...breakdownLines,
        ...deliveryLines,
        ...cancelLine,
      ].filter(Boolean);

      const text = buildMessage(theme, [{ title: '📦 Order Details', lines }]);

      // ── Buttons ────────────────────────────────────────────────────────────
      const buttons = [];
      if (['Pending', 'Processing'].includes(order.status)) {
        buttons.push([Markup.button.callback('📍 Track Live Status', `track_show:${orderId}`)]);
      }
      if (order.status === 'Pending') {
        buttons.push([Markup.button.callback('❌ Cancel This Order', `user_cancel_order:${orderId}`)]);
      }
      if (order.status === 'Success' && product?.isActive) {
        buttons.push([Markup.button.callback('🔄 Reorder', `order_reorder:${orderId}`)]);
      }
      if (order.status === 'Success' && order.deliveredData) {
        buttons.push([Markup.button.callback('📋 Copy Code', `order_copy_code:${orderId}`)]);
      }
      buttons.push(Nav.backButton('🔙 My Orders'));

      await ctx.reply(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(buttons),
      });
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  // ── Copy delivered code (resend cleanly) ──────────────────────────────────
  bot.action(/^order_copy_code:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('Sending code...');
    const orderId = ctx.match[1];
    const order = await Order.findById(orderId);
    if (!order?.deliveredData) return ctx.answerCbQuery('No code available.', { show_alert: true });

    await ctx.reply(
      `📬 *Your Game Code*\n\n` +
      `📦 Order: \`${orderId.slice(-8).toUpperCase()}\`\n\n` +
      `\`${order.deliveredData}\`\n\n` +
      `_Keep this code safe!_`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Reorder ────────────────────────────────────────────────────────────────
  bot.action(/^order_reorder:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('Loading product...');
    const orderId = ctx.match[1];

    try {
      const order = await Order.findById(orderId).populate('productId');
      if (!order?.productId) return ctx.reply('❌ Product not found.');
      if (!order.productId.isActive) {
        return ctx.reply('❌ This product is no longer available.');
      }
      if (!order.productId.isInStock()) {
        return ctx.reply('❌ This product is currently out of stock.');
      }

      ctx.session.orderProductId = order.productId._id.toString();
      ctx.session.orderProduct   = null;

      await ctx.reply(
        `🔄 *Reordering:* ${order.productId.name}`,
        { parse_mode: 'Markdown' }
      );
      await ctx.scene.enter('order_scene');
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  // ── User self-cancel ───────────────────────────────────────────────────────
  bot.action(/^user_cancel_order:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const orderId = ctx.match[1];
    const { cancelOrder } = require('../controllers/orderController');

    try {
      await cancelOrder(orderId, ctx.from.id, 'Cancelled by customer');
      await ctx.editMessageText(
        `❌ *Order Cancelled*\n\nYour order \`${orderId.slice(-8).toUpperCase()}\` has been cancelled.\n_Your refund will be processed shortly._`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });
};
