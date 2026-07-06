/**
 * WebhookProcessor — Bot-side watcher that processes incoming webhook events.
 *
 * The API server writes WebhookEvent documents to MongoDB.
 * This service polls for 'pending' events every 30 seconds and processes them.
 *
 * Supported event types:
 *   payment.completed   → approve pending top-up
 *   payment.failed      → reject top-up + notify user
 *   topup.delivered     → mark order Success + send receipt
 *   topup.failed        → cancel order + refund + notify user
 */

const WebhookEvent = require('../models/WebhookEvent');
const Order        = require('../models/Order');
const User         = require('../models/User');
const Transaction  = require('../models/Transaction');

const POLL_INTERVAL_MS = 30_000; // 30 seconds

// ── Event processor dispatch table ───────────────────────────────────────────

const PROCESSORS = {
  'payment.completed': processPaymentCompleted,
  'payment.failed':    processPaymentFailed,
  'topup.delivered':   processTopupDelivered,
  'topup.failed':      processTopupFailed,
};

// ── Main poll loop ────────────────────────────────────────────────────────────

async function processPendingEvents(telegram) {
  const events = await WebhookEvent.find({ status: 'pending' })
    .sort({ createdAt: 1 })
    .limit(20);

  if (!events.length) return;

  for (const event of events) {
    await processEvent(event, telegram);
  }
}

async function processEvent(event, telegram) {
  // Mark as processing (prevents double-processing)
  await WebhookEvent.findByIdAndUpdate(event._id, { status: 'processing' });

  const processor = PROCESSORS[event.eventType];

  if (!processor) {
    await WebhookEvent.findByIdAndUpdate(event._id, {
      status:      'ignored',
      processedAt: new Date(),
      error:       `No processor for event type: ${event.eventType}`,
    });
    return;
  }

  try {
    const result = await processor(event, telegram);
    await WebhookEvent.findByIdAndUpdate(event._id, {
      status:      'processed',
      processedAt: new Date(),
      orderId:     result?.orderId || event.orderId,
    });
    console.log(`[WebhookProcessor] ✅ ${event.eventType} — ${event._id}`);
  } catch (err) {
    const retryCount = (event.retryCount || 0) + 1;
    const finalStatus = retryCount >= 3 ? 'failed' : 'pending';

    await WebhookEvent.findByIdAndUpdate(event._id, {
      status:      finalStatus,
      error:       err.message,
      retryCount,
      processedAt: finalStatus === 'failed' ? new Date() : null,
    });
    console.error(`[WebhookProcessor] ❌ ${event.eventType}:`, err.message);
  }
}

// ── Event handlers ────────────────────────────────────────────────────────────

async function processPaymentCompleted(event, telegram) {
  const { externalRef, amount, currency, userId: telegramId } = event.payload;

  // Find pending transaction by external reference
  const transaction = await Transaction.findOne({
    $or: [
      { reference: externalRef },
      { providerRef: externalRef },
    ],
    type: 'topup',
    status: 'pending',
  });

  if (!transaction) {
    throw new Error(`No pending transaction found for ref: ${externalRef}`);
  }

  // Approve the top-up (add KS to wallet)
  const WalletService = require('./WalletService');
  await WalletService.approvePendingTopup(transaction._id, { autoApproved: true, providerRef: externalRef });

  if (telegram) {
    try {
      await telegram.sendMessage(
        transaction.telegramId || telegramId,
        `✅ *Payment Confirmed!*\n\n` +
        `💰 *${transaction.amountKS?.toLocaleString() || '?'} KS* added to your wallet.\n` +
        `🔖 Ref: \`${externalRef}\`\n\n` +
        `_Approved automatically via payment gateway._`,
        { parse_mode: 'Markdown' }
      );
    } catch {}
  }

  return { orderId: null };
}

async function processPaymentFailed(event, telegram) {
  const { externalRef } = event.payload;

  const transaction = await Transaction.findOneAndUpdate(
    { reference: externalRef, type: 'topup', status: 'pending' },
    { status: 'failed', notes: 'Rejected by payment gateway webhook' },
    { new: true }
  );

  if (transaction?.telegramId && telegram) {
    try {
      await telegram.sendMessage(
        transaction.telegramId,
        `❌ *Payment Not Confirmed*\n\n` +
        `Your top-up of ${transaction.amountKS?.toLocaleString() || '?'} KS could not be verified.\n` +
        `Reference: \`${externalRef}\`\n\n` +
        `_If you believe this is an error, contact /support with your receipt._`,
        { parse_mode: 'Markdown' }
      );
    } catch {}
  }

  return {};
}

async function processTopupDelivered(event, telegram) {
  const { externalRef, orderId: extOrderId, deliveryData } = event.payload;

  const order = await Order.findOne({
    $or: [
      { _id: event.orderId },
      { transactionId: externalRef },
    ],
    status: 'Pending',
  }).populate('userId').populate('productId');

  if (!order) throw new Error(`Order not found for ref: ${externalRef}`);

  await Order.findByIdAndUpdate(order._id, {
    status:        'Success',
    deliveredData: deliveryData || 'Auto-delivered via API',
    transactionId: externalRef,
    processedBy:   0, // 0 = system/auto
    notes:         'Delivered automatically via provider API',
  });

  // Notify user with receipt
  if (order.userId?.telegramId && telegram) {
    try {
      const shortId = order._id.toString().slice(-8).toUpperCase();
      await telegram.sendMessage(
        order.userId.telegramId,
        `🧾 *Order Delivered!*\n` +
        `\`━━━━━━━━━━━━━━━━━━━━━━\`\n` +
        `🆔 Order: \`${shortId}\`\n` +
        `📦 *${order.productId?.name || 'Your order'}*\n` +
        `💰 Paid: *${order.amount.toLocaleString()} KS*\n` +
        `\`━━━━━━━━━━━━━━━━━━━━━━\`\n` +
        (deliveryData ? `📬 *Delivery:*\n\`${deliveryData}\`\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n` : '') +
        `✅ *Status: Delivered*\n` +
        `_Auto-delivered via API — Thank you! 🎮_`,
        { parse_mode: 'Markdown' }
      );
    } catch {}
  }

  return { orderId: order._id };
}

async function processTopupFailed(event, telegram) {
  const { externalRef, reason } = event.payload;

  const order = await Order.findOne({
    $or: [
      { _id: event.orderId },
      { transactionId: externalRef },
    ],
    status: 'Pending',
  }).populate('userId').populate('productId');

  if (!order) throw new Error(`Order not found for ref: ${externalRef}`);

  // Refund the user
  const OrderService = require('./OrderService');
  await OrderService.cancelAndRefund(order._id, 0, `Auto-cancelled: provider reported failure — ${reason || 'delivery failed'}`);

  if (order.userId?.telegramId && telegram) {
    try {
      await telegram.sendMessage(
        order.userId.telegramId,
        `❌ *Order Failed — Refunded*\n\n` +
        `📦 *${order.productId?.name || 'Your order'}* could not be delivered.\n` +
        `💰 *${order.amount.toLocaleString()} KS* has been returned to your wallet.\n\n` +
        `_Reason: ${reason || 'Provider delivery failed'}_\n\n` +
        `Contact /support if you need help.`,
        { parse_mode: 'Markdown' }
      );
    } catch {}
  }

  return { orderId: order._id };
}

// ── Watcher starter ───────────────────────────────────────────────────────────

function startWebhookProcessor(telegram) {
  // Initial run
  processPendingEvents(telegram).catch((e) => console.error('[WebhookProcessor] Init error:', e.message));
  setInterval(() => processPendingEvents(telegram).catch((e) => console.error('[WebhookProcessor] Poll error:', e.message)), POLL_INTERVAL_MS);
  console.log('[WebhookProcessor] ✅ Webhook event processor started');
}

module.exports = { startWebhookProcessor, processPendingEvents };
