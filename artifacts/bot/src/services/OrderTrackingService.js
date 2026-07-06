/**
 * OrderTrackingService — Live order status thread sent to the customer.
 *
 * Each status change sends a new message that REPLIES to the previous
 * tracking message, creating a visual thread per order:
 *
 *   📦 Order Confirmed    ← sent on placement (replyTo: checklist msg)
 *    └─ 🔄 Processing     ← sent when admin marks processing
 *        └─ ✅ Receipt     ← sent on complete (includes full timeline + delivery)
 *
 * If no trackingMsgId exists, the message is sent stand-alone (graceful fallback).
 *
 * All messages use Markdown (not V2) for easy formatting without escaping.
 */

const { Markup } = require('telegraf');

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtMMT(date) {
  return new Date(date).toLocaleString('en-GB', {
    timeZone:  'Asia/Rangoon',
    day:       '2-digit',
    month:     'short',
    hour:      '2-digit',
    minute:    '2-digit',
    hour12:    false,
  });
}

const STATUS_LABELS = {
  Pending:    'Order received',
  Processing: 'Processing started',
  Success:    'Delivered',
  Cancelled:  'Cancelled',
  Refunded:   'Refunded',
};

const STATUS_ICONS = {
  Pending:    '⏳',
  Processing: '🔄',
  Success:    '✅',
  Cancelled:  '❌',
  Refunded:   '💸',
};

/**
 * Renders the status timeline from order.statusHistory.
 * Completed entries show ✅; the last (current) entry shows the live icon.
 */
function buildTimeline(statusHistory) {
  if (!statusHistory || !statusHistory.length) {
    return `  ⏳ — Order received`;
  }

  return statusHistory.map((entry, i) => {
    const isLast = i === statusHistory.length - 1;
    const icon   = isLast ? (STATUS_ICONS[entry.status] || '•') : '✅';
    const label  = STATUS_LABELS[entry.status] || entry.status;
    const time   = fmtMMT(entry.at);
    const note   = entry.note && entry.note !== 'Order placed'
      ? ` _(${entry.note})_`
      : '';
    return `  ${icon} ${time} — *${label}*${note}`;
  }).join('\n');
}

// ── Exported functions ────────────────────────────────────────────────────────

/**
 * Sent immediately when an order is placed.
 * Replies to the checklist confirmation message (replyToMsgId).
 * @returns {Promise<TelegramMessage>} — save .message_id as order.trackingMsgId
 */
async function sendOrderPlaced(telegram, userId, order, sess = {}, replyToMsgId = null) {
  const shortId     = order._id.toString().slice(-8).toUpperCase();
  const productName = order.productId?.name || sess.productName || 'Your Order';
  const now         = fmtMMT(new Date());

  let gameIdLine = '';
  if (order.checkoutData && order.checkoutData.length > 0) {
    gameIdLine = order.checkoutData.map((d) => `📋 ${d.label}: \`${d.value}\``).join('\n') + '\n';
  } else if (order.gameId) {
    gameIdLine = `🎮 Game ID: \`${order.gameId}\`${order.zoneId ? ` / Zone: \`${order.zoneId}\`` : ''}\n`;
  }
  const promoLine = order.promoCode
    ? `🎟 Promo Applied: \`${order.promoCode}\`\n`
    : '';

  const text =
    `📦 *Order Confirmed!*\n` +
    `\`━━━━━━━━━━━━━━━━━━━━━━\`\n` +
    `🆔 Order: \`${shortId}\`\n` +
    `📦 *${productName}*\n` +
    gameIdLine +
    promoLine +
    `💰 Paid: *${order.amount.toLocaleString()} KS*\n` +
    `\`━━━━━━━━━━━━━━━━━━━━━━\`\n` +
    `🕐 *Status Timeline:*\n` +
    `  ⏳ ${now} — *Order received*\n\n` +
    `_We'll send you live updates as your order progresses._ 🔔`;

  const opts = { parse_mode: 'Markdown' };
  if (replyToMsgId) opts.reply_to_message_id = replyToMsgId;

  return telegram.sendMessage(userId, text, opts);
}

/**
 * Sent when admin taps [🔄 Mark Processing].
 * Replies to the order confirmation card (order.trackingMsgId).
 */
async function sendProcessing(telegram, userId, order) {
  const shortId     = order._id.toString().slice(-8).toUpperCase();
  const productName = order.productId?.name || 'Your Order';
  const timeline    = buildTimeline(order.statusHistory);

  const text =
    `🔄 *Order Update* — \`${shortId}\`\n` +
    `\`━━━━━━━━━━━━━━━━━━━━━━\`\n` +
    `📦 *${productName}*\n\n` +
    `🕐 *Status Timeline:*\n` +
    timeline + `\n\n` +
    `_Our team is handling your order. Delivery coming soon!_ ⚡`;

  const opts = { parse_mode: 'Markdown' };
  if (order.trackingMsgId) opts.reply_to_message_id = order.trackingMsgId;

  return telegram.sendMessage(userId, text, opts);
}

/**
 * Sent when admin marks the order complete.
 * Includes full timeline + delivery data.
 * Replies to the latest tracking message.
 */
async function sendDeliveredReceipt(telegram, userId, order, deliveredData) {
  const shortId     = order._id.toString().slice(-8).toUpperCase();
  const productName = order.productId?.name || 'Your Order';
  const timeline    = buildTimeline(order.statusHistory);
  const now         = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Rangoon' });

  let gameIdLine = '';
  if (order.checkoutData && order.checkoutData.length > 0) {
    gameIdLine = order.checkoutData.map((d) => `📋 ${d.label}: \`${d.value}\``).join('\n') + '\n';
  } else if (order.gameId) {
    gameIdLine = `🎮 Game ID: \`${order.gameId}\`${order.zoneId ? ` / Zone: \`${order.zoneId}\`` : ''}\n`;
  }
  const deliveryBlock = deliveredData
    ? `\`━━━━━━━━━━━━━━━━━━━━━━\`\n` +
      `📬 *Your Delivery:*\n\`${deliveredData}\`\n`
    : '';

  const text =
    `✅ *Order Complete!*\n` +
    `\`━━━━━━━━━━━━━━━━━━━━━━\`\n` +
    `🆔 Order: \`${shortId}\`\n` +
    `📦 *${productName}*\n` +
    gameIdLine +
    `💰 Paid: *${order.amount.toLocaleString()} KS*\n` +
    `📅 ${now} MMT\n` +
    `\`━━━━━━━━━━━━━━━━━━━━━━\`\n` +
    `🕐 *Status Timeline:*\n` +
    timeline + `\n` +
    deliveryBlock +
    `\`━━━━━━━━━━━━━━━━━━━━━━\`\n` +
    `⭐ Happy with your order? Leave a review — it helps us grow!\n` +
    `_Thank you for shopping at Mental Gaming Store!_ 🎮`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('⭐ Leave a Review', `rate_start:${order._id}`)],
    [
      Markup.button.callback('🛒 Shop Again', 'nav:go:shop'),
      Markup.button.callback('📦 My Orders', 'nav:go:my_orders'),
    ],
  ]);

  const opts = { parse_mode: 'Markdown', ...keyboard };
  if (order.trackingMsgId) opts.reply_to_message_id = order.trackingMsgId;

  return telegram.sendMessage(userId, text, opts);
}

/**
 * Sent when admin cancels and refunds the order.
 * Replies to the latest tracking message.
 */
async function sendCancelled(telegram, userId, order, reason) {
  const shortId     = order._id.toString().slice(-8).toUpperCase();
  const productName = order.productId?.name || 'Your Order';
  const timeline    = buildTimeline(order.statusHistory);

  const text =
    `❌ *Order Cancelled* — \`${shortId}\`\n` +
    `\`━━━━━━━━━━━━━━━━━━━━━━\`\n` +
    `📦 *${productName}*\n\n` +
    `🕐 *Status Timeline:*\n` +
    timeline + `\n\n` +
    `💰 *Refund: ${order.amount.toLocaleString()} KS* returned to your wallet\n` +
    `📝 Reason: ${reason || 'No reason provided'}\n\n` +
    `_Contact /support if you have any questions._`;

  const opts = { parse_mode: 'Markdown' };
  if (order.trackingMsgId) opts.reply_to_message_id = order.trackingMsgId;

  return telegram.sendMessage(userId, text, opts);
}

module.exports = {
  sendOrderPlaced,
  sendProcessing,
  sendDeliveredReceipt,
  sendCancelled,
  buildTimeline,
};
