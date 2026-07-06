/**
 * /trackorder — Live order status lookup + stale-order support escalation
 *
 * Usage:
 *   /trackorder            → list recent Pending/Processing orders with [Track] buttons
 *   /trackorder <shortId>  → show tracking card for that order (last-8 hex chars)
 *
 * Staleness prompt:
 *   When an order has been Pending/Processing longer than `SystemStatus.orderSupportThresholdMinutes`
 *   (default 30 min), a [⚠️ Contact Support] button appears on the tracking card.
 *   Tapping it auto-creates a High-priority SupportTicket and notifies the admin instantly,
 *   without requiring the customer to type anything.
 *
 * Admin commands:
 *   /setstalesupport <minutes>  — update the threshold (5–1440)
 *
 * Customers can only view their own orders.
 * Admins (STAFF+) can look up any order by short ID, and see all active orders.
 */

const { Markup } = require('telegraf');
const { getTheme } = require('../services/ThemeService');
const { buildTimeline } = require('../services/OrderTrackingService');
const { buildMessage, price, formatDate } = require('../utils/ui');
const { isAnyAdmin, adminOnly } = require('../middlewares/adminCheck');
const { auditLog } = require('../services/logger');
const { config } = require('../../config/settings');
const Order         = require('../models/Order');
const User          = require('../models/User');
const SupportTicket = require('../models/SupportTicket');
const SystemStatus  = require('../models/SystemStatus');

// ── Constants ──────────────────────────────────────────────────────────────────

const STATUS_ICON = {
  Pending:    '⏳',
  Processing: '🔄',
  Success:    '✅',
  Cancelled:  '❌',
  Refunded:   '💸',
};

const STATUS_LABEL = {
  Pending:    'Pending — awaiting processing',
  Processing: 'Processing — our team is on it',
  Success:    'Delivered ✅',
  Cancelled:  'Cancelled',
  Refunded:   'Refunded',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minutes since order.timestamp (or last statusHistory entry). */
function ageMinutes(order) {
  const base = order.statusHistory?.length
    ? order.statusHistory[order.statusHistory.length - 1].at
    : order.timestamp;
  return Math.floor((Date.now() - new Date(base).getTime()) / 60000);
}

/** Returns { threshold, isStale } from SystemStatus. */
async function getStaleness(order) {
  if (!['Pending', 'Processing'].includes(order.status)) return { threshold: 30, isStale: false };
  const status    = await SystemStatus.get();
  const threshold = status.orderSupportThresholdMinutes || 30;
  const age       = ageMinutes(order);
  return { threshold, isStale: age >= threshold, ageMin: age };
}

// ── Card builder ──────────────────────────────────────────────────────────────

/**
 * @param {object} order     — populated Order document (productId, userId)
 * @param {object} theme     — from getTheme()
 * @param {number} ageMin    — minutes since last status update (0 = fresh / not active)
 * @param {boolean} isStale  — whether to show the staleness warning line
 */
function buildTrackingCard(order, theme, ageMin = 0, isStale = false) {
  const shortId     = order._id.toString().slice(-8).toUpperCase();
  const productName = order.productId?.name || 'Your Order';
  const icon        = STATUS_ICON[order.status] || '•';
  const statusLabel = STATUS_LABEL[order.status] || order.status;

  const gameIdLine = order.gameId
    ? `🎮 Game ID: ${theme.format.code(order.gameId)}${order.zoneId ? ` / Zone: ${order.zoneId}` : ''}`
    : null;
  const promoLine  = order.promoCode
    ? `🎟 Promo: ${theme.format.code(order.promoCode)}`
    : null;

  const timelineBlock = order.statusHistory?.length
    ? buildTimeline(order.statusHistory)
    : `  ⏳ — No updates yet`;

  const deliveryLines = order.status === 'Success' && order.deliveredData
    ? [``, `📬 *Delivery Data:*`, `\`${order.deliveredData}\``]
    : [];
  const cancelLines = order.status === 'Cancelled' && order.cancelReason
    ? [``, `📝 *Reason:* ${order.cancelReason}`]
    : [];

  const hasDiscount = (order.tierDiscount || 0) > 0 || (order.promoDiscount || 0) > 0;
  const priceLine   = hasDiscount
    ? `💰 Paid: *${price(order.amount)}* _(was ${price(order.originalAmount || order.amount)})_`
    : `💰 Paid: *${price(order.amount)}*`;

  const staleLine = isStale && ageMin > 0
    ? [``, `⚠️ _Waiting for ${ageMin} min — tap [Contact Support] if you need help._`]
    : [];

  const lines = [
    `🆔 Order: ${theme.format.code(shortId)}`,
    `📦 *${productName}*`,
    gameIdLine,
    promoLine,
    priceLine,
    `🗂 Type: ${order.productType === 'DigitalCode' ? '🎁 Digital Code' : '🎮 Direct Top-up'}`,
    `🕐 Placed: ${formatDate(order.timestamp)}`,
    ``,
    `${icon} *Status: ${statusLabel}*`,
    `\`━━━━━━━━━━━━━━━━━━━━━━\``,
    `🕐 *Timeline:*`,
    timelineBlock,
    ...deliveryLines,
    ...cancelLines,
    ...staleLine,
  ].filter((l) => l !== null);

  return buildMessage(theme, [{ title: '📍 Order Tracking', lines }]);
}

// ── Keyboard ───────────────────────────────────────────────────────────────────

function trackKeyboard(orderId, isActive, isStale = false) {
  const rows = [];
  if (isStale) {
    rows.push([Markup.button.callback('⚠️ Contact Support', `track_support:${orderId}`)]);
  }
  if (isActive) {
    rows.push([Markup.button.callback('🔄 Refresh Status', `track_refresh:${orderId}`)]);
  }
  rows.push([Markup.button.callback('📦 All Orders', 'nav:go:my_orders')]);
  return Markup.inlineKeyboard(rows);
}

// ── Short-ID lookup ────────────────────────────────────────────────────────────

async function findByShortId(shortId) {
  return Order.find()
    .populate('productId', 'name productType')
    .populate('userId', 'telegramId username first_name')
    .sort({ timestamp: -1 })
    .limit(2000)
    .lean()
    .then((docs) => docs.filter((d) => d._id.toString().slice(-8).toUpperCase() === shortId));
}

// ── Auto-escalation: create support ticket for stale order ────────────────────

async function autoEscalate(ctx, order, user) {
  const shortId     = order._id.toString().slice(-8).toUpperCase();
  const productName = order.productId?.name || 'Your Order';
  const age         = ageMinutes(order);

  // Deduplicate: don't open a second ticket if one is already open for this order
  const existing = await SupportTicket.findOne({
    telegramId: user.telegramId,
    topic:      'order',
    status:     { $in: ['Open', 'InProgress'] },
    userMessage: new RegExp(shortId),
  });

  if (existing) {
    return { duplicate: true, ticketId: existing.ticketId };
  }

  const ticketId = await SupportTicket.generateId();
  const subject  = `Order delay — #${shortId}`;
  const msg      =
    `My order *#${shortId}* (${productName}) has been *${order.status}* for ${age} minute${age !== 1 ? 's' : ''} ` +
    `without any update. Please check on it.`;

  const ticket = await SupportTicket.create({
    ticketId,
    userId:      user._id,
    telegramId:  user.telegramId,
    username:    user.username || null,
    subject,
    topic:       'order',
    priority:    'High',
    status:      'Open',
    userMessage: msg,
    aiResponse:  null,
  });

  await auditLog(user.telegramId, 'SUPPORT_AUTO_ESCALATE', ticketId, 'SupportTicket', {
    orderId: order._id.toString(),
    ageMin:  age,
  });

  // ── Notify admin ──────────────────────────────────────────────────────────
  const userTag = user.username ? `@${user.username}` : `ID: ${user.telegramId}`;
  try {
    await ctx.telegram.sendMessage(
      config.bot.adminId,
      `📩 *New Support Ticket — Auto-Escalated*\n\n` +
      `🎫 Ticket: \`${ticketId}\`\n` +
      `🟠 Priority: *High*\n` +
      `📦 Topic: Order Delay\n` +
      `👤 User: ${userTag}\n` +
      `🕐 Order Age: *${age} min*\n\n` +
      `*Customer Message:*\n${msg}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('💬 Reply',         `ticket_reply:${ticketId}`),
            Markup.button.callback('📜 Template',      `tpl_pick:ticket:${ticketId}`),
          ],
          [
            Markup.button.callback('✅ Resolve',       `ticket_resolve:${ticketId}`),
            Markup.button.callback('🔵 Assign to Me',  `ticket_assign:${ticketId}`),
          ],
        ]),
      }
    );
  } catch (e) {
    console.error('[TrackOrder] Admin notify failed:', e.message);
  }

  return { duplicate: false, ticketId };
}

// ── Module ────────────────────────────────────────────────────────────────────

module.exports = function registerTrackOrder(bot) {

  // ── /trackorder [shortId] ─────────────────────────────────────────────────
  bot.command('trackorder', async (ctx) => {
    const arg       = ctx.message.text.split(/\s+/)[1]?.toUpperCase().trim();
    const theme     = getTheme(ctx.user);
    const adminFlag = await isAnyAdmin(ctx.from.id);

    // ── No arg: list active orders ─────────────────────────────────────────
    if (!arg) {
      let orders;
      if (adminFlag) {
        orders = await Order.find({ status: { $in: ['Pending', 'Processing'] } })
          .populate('productId', 'name')
          .populate('userId', 'username first_name telegramId')
          .sort({ timestamp: -1 })
          .limit(12);
      } else {
        const user = await User.findByTelegramId(ctx.from.id);
        if (!user) return ctx.reply('❌ User not found.');
        orders = await Order.find({ userId: user._id, status: { $in: ['Pending', 'Processing'] } })
          .populate('productId', 'name')
          .sort({ timestamp: -1 })
          .limit(8);
      }

      if (!orders.length) {
        return ctx.reply(
          buildMessage(theme, [{
            title: '📍 Order Tracking',
            lines: [
              `${theme.emoji.bullet} No active orders right now.`,
              `_All your recent orders are complete._`,
              ``,
              `Use \`/trackorder <ID>\` to look up any past order.`,
              `Use /orders to view your full history.`,
            ],
          }]),
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('📦 My Orders', 'nav:go:my_orders')]]),
          }
        );
      }

      // Fetch threshold once for the whole list
      const sysStatus = await SystemStatus.get();
      const threshold = sysStatus.orderSupportThresholdMinutes || 30;

      const rows = orders.map((o) => {
        const shortId  = o._id.toString().slice(-8).toUpperCase();
        const icon     = STATUS_ICON[o.status] || '•';
        const name     = (o.productId?.name || 'Order').slice(0, 22);
        const age      = ageMinutes(o);
        const stale    = age >= threshold;
        const ageSuffix = stale ? ` ⚠️ ${age}m` : ` ${age}m`;
        const suffix   = adminFlag && o.userId?.username ? ` — @${o.userId.username}` : '';
        return [Markup.button.callback(
          `${icon} [${shortId}] ${name}${ageSuffix}${suffix}`,
          `track_show:${o._id}`
        )];
      });
      rows.push([Markup.button.callback('📦 All Orders', 'nav:go:my_orders')]);

      const staleCount = orders.filter((o) => ageMinutes(o) >= threshold).length;
      const staleNote  = staleCount > 0 ? ` — *${staleCount}* waiting over ${threshold} min ⚠️` : '';
      const headerLine = adminFlag
        ? `🔎 ${orders.length} active order${orders.length !== 1 ? 's' : ''}${staleNote}`
        : `🔎 ${orders.length} active order${orders.length !== 1 ? 's' : ''}${staleNote}`;

      return ctx.reply(
        buildMessage(theme, [{
          title: '📍 Order Tracking',
          lines: [headerLine, ``, `_Tap an order to see its live status:_`],
        }]),
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
      );
    }

    // ── With arg: look up by short ID ────────────────────────────────────────
    const candidates = await findByShortId(arg);

    if (!candidates.length) {
      return ctx.reply(
        `❌ No order found with ID \`${arg}\`.\n\n` +
        `_Use the last 8 characters of your order ID — e.g._ \`/trackorder ABC12345\``,
        { parse_mode: 'Markdown' }
      );
    }

    const order = candidates[0];

    if (!adminFlag) {
      const user = await User.findByTelegramId(ctx.from.id);
      if (!user || order.userId?._id?.toString() !== user._id.toString()) {
        return ctx.reply(`❌ Order \`${arg}\` not found in your account.`, { parse_mode: 'Markdown' });
      }
    }

    const isActive = ['Pending', 'Processing'].includes(order.status);
    const { isStale, ageMin } = await getStaleness(order);
    const text = buildTrackingCard(order, theme, ageMin, isStale);
    return ctx.reply(text, { parse_mode: 'Markdown', ...trackKeyboard(order._id.toString(), isActive, isStale) });
  });

  // ── [Track] inline button → open tracking card ───────────────────────────
  bot.action(/^track_show:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('Loading status…');
    const orderId   = ctx.match[1];
    const theme     = getTheme(ctx.user);
    const adminFlag = await isAnyAdmin(ctx.from.id);

    try {
      const order = await Order.findById(orderId)
        .populate('productId', 'name productType')
        .populate('userId', 'telegramId username');
      if (!order) return ctx.reply('❌ Order not found.');

      if (!adminFlag) {
        const user = await User.findByTelegramId(ctx.from.id);
        if (!user || order.userId?._id?.toString() !== user._id.toString()) {
          return ctx.answerCbQuery('❌ This order is not in your account.', { show_alert: true });
        }
      }

      const isActive = ['Pending', 'Processing'].includes(order.status);
      const { isStale, ageMin } = await getStaleness(order);
      const text = buildTrackingCard(order, theme, ageMin, isStale);
      await ctx.reply(text, { parse_mode: 'Markdown', ...trackKeyboard(orderId, isActive, isStale) });
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  // ── [🔄 Refresh] → re-fetch and edit card in-place ───────────────────────
  bot.action(/^track_refresh:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('Refreshing…');
    const orderId   = ctx.match[1];
    const theme     = getTheme(ctx.user);
    const adminFlag = await isAnyAdmin(ctx.from.id);

    try {
      const order = await Order.findById(orderId)
        .populate('productId', 'name productType')
        .populate('userId', 'telegramId username');
      if (!order) return ctx.answerCbQuery('Order not found.', { show_alert: true });

      if (!adminFlag) {
        const user = await User.findByTelegramId(ctx.from.id);
        if (!user || order.userId?._id?.toString() !== user._id.toString()) {
          return ctx.answerCbQuery('❌ Access denied.', { show_alert: true });
        }
      }

      const isActive = ['Pending', 'Processing'].includes(order.status);
      const { isStale, ageMin } = await getStaleness(order);
      const text = buildTrackingCard(order, theme, ageMin, isStale);

      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...trackKeyboard(orderId, isActive, isStale),
      }).catch(() =>
        ctx.reply(text, { parse_mode: 'Markdown', ...trackKeyboard(orderId, isActive, isStale) })
      );
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  // ── [⚠️ Contact Support] → auto-create High-priority ticket ──────────────
  bot.action(/^track_support:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('Opening support ticket…');
    const orderId = ctx.match[1];

    try {
      const order = await Order.findById(orderId)
        .populate('productId', 'name productType')
        .populate('userId', 'telegramId username _id');
      if (!order) return ctx.reply('❌ Order not found.');

      // Ownership check
      const adminFlag = await isAnyAdmin(ctx.from.id);
      if (!adminFlag) {
        const user = await User.findByTelegramId(ctx.from.id);
        if (!user || order.userId?._id?.toString() !== user._id.toString()) {
          return ctx.answerCbQuery('❌ This order is not in your account.', { show_alert: true });
        }
      }

      const user = await User.findByTelegramId(ctx.from.id);
      if (!user) return ctx.reply('❌ User not found.');

      const { duplicate, ticketId } = await autoEscalate(ctx, order, user);
      const shortId = orderId.slice(-8).toUpperCase();

      if (duplicate) {
        await ctx.reply(
          `ℹ️ *Support Already Requested*\n\n` +
          `A support ticket (\`${ticketId}\`) is already open for order \`${shortId}\`.\n\n` +
          `_Our team will respond shortly. Thank you for your patience!_`,
          { parse_mode: 'Markdown' }
        );
      } else {
        await ctx.reply(
          `✅ *Support Ticket Opened!*\n\n` +
          `🎫 Ticket ID: \`${ticketId}\`\n` +
          `📦 Order: \`${shortId}\`\n` +
          `🟠 Priority: *High*\n\n` +
          `_Our team has been notified and will respond as soon as possible._\n` +
          `_Use /support to check your tickets._`,
          { parse_mode: 'Markdown' }
        );
      }
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  // ── Admin: /setstalesupport <minutes> ────────────────────────────────────
  bot.command('setstalesupport', adminOnly(), async (ctx) => {
    const arg = parseInt(ctx.message.text.split(/\s+/)[1], 10);

    if (isNaN(arg)) {
      const status    = await SystemStatus.get();
      const current   = status.orderSupportThresholdMinutes || 30;
      return ctx.reply(
        `⏱ *Stale Order Support Threshold*\n\n` +
        `Current: *${current} minutes*\n\n` +
        `Usage: \`/setstalesupport <minutes>\` _(5–1440)_\n\n` +
        `_When a Pending or Processing order has been waiting longer than this threshold, ` +
        `customers will see a [⚠️ Contact Support] button on their tracking card. ` +
        `Tapping it instantly opens a High-priority support ticket and alerts the admin._`,
        { parse_mode: 'Markdown' }
      );
    }

    if (arg < 5 || arg > 1440) {
      return ctx.reply('❌ Value must be between 5 and 1440 minutes (24 hours).');
    }

    await SystemStatus.set({ orderSupportThresholdMinutes: arg }, ctx.from.id);
    await auditLog(ctx.from.id, 'SET_STALE_SUPPORT_THRESHOLD', null, 'System', { minutes: arg });

    await ctx.reply(
      `✅ *Stale Order Threshold Updated*\n\n` +
      `Orders waiting more than *${arg} minute${arg !== 1 ? 's' : ''}* will now prompt customers to contact support.`,
      { parse_mode: 'Markdown' }
    );
  });
};
