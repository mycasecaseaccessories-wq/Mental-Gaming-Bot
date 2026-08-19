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
const Order = require('../models/Order');
const User = require('../models/User');
const Transaction = require('../models/Transaction');

const POLL_INTERVAL_MS = 30_000; // 30 seconds

function normalizeSourceTxId(externalRef) {
  const value = String(externalRef || '');
  return value.endsWith('_approved') ? value.slice(0, -'_approved'.length) : value;
}

// ── Event processor dispatch table ───────────────────────────────────────────

const PROCESSORS = {
  'payment.completed': processPaymentCompleted,
  'payment.failed': processPaymentFailed,
  'payment.refunded': processPaymentRefunded,
  'payment.chargeback': processPaymentRefunded,
  'topup.delivered': processTopupDelivered,
  'topup.failed': processTopupFailed,
};

// ── Main poll loop ────────────────────────────────────────────────────────────

async function processPendingEvents(telegram) {
  const events = await WebhookEvent.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(20);

  if (!events.length) return;

  for (const event of events) {
    await processEvent(event, telegram);
  }
}

async function processEvent(event, telegram) {
  // Atomically claim the event so multiple bot instances cannot process it twice.
  const claimed = await WebhookEvent.findOneAndUpdate(
    { _id: event._id, status: 'pending' },
    { status: 'processing' },
    { new: true },
  );
  if (!claimed) return { skipped: true };
  event = claimed;

  const processor = PROCESSORS[event.eventType];

  if (!processor) {
    await WebhookEvent.findByIdAndUpdate(event._id, {
      status: 'ignored',
      processedAt: new Date(),
      error: `No processor for event type: ${event.eventType}`,
    });
    return;
  }

  try {
    const result = await processor(event, telegram);
    await WebhookEvent.findOneAndUpdate(
      { _id: event._id, status: 'processing' },
      {
        status: 'processed',
        processedAt: new Date(),
        orderId: result?.orderId || event.orderId,
      },
    );
    console.log(`[WebhookProcessor] ✅ ${event.eventType} — ${event._id}`);
  } catch (err) {
    const retryCount = (event.retryCount || 0) + 1;
    const finalStatus = retryCount >= 3 ? 'failed' : 'pending';

    await WebhookEvent.findOneAndUpdate(
      { _id: event._id, status: 'processing' },
      {
        status: finalStatus,
        error: err.message,
        retryCount,
        processedAt: finalStatus === 'failed' ? new Date() : null,
      },
    );
    console.error(`[WebhookProcessor] ❌ ${event.eventType}:`, err.message);
  }
}

// ── Event handlers ────────────────────────────────────────────────────────────

async function processPaymentCompleted(event, telegram) {
  const { externalRef, amount, currency, userId: telegramId } = event.payload;

  // Find pending transaction by external reference
  const transaction = await Transaction.findOne({
    $or: [{ txId: externalRef }, { reference: externalRef }, { providerRef: externalRef }],
    type: 'Topup',
    status: 'Pending',
  });

  if (!transaction) {
    // A retried webhook can arrive after the wallet approval already changed
    // the pending txId to <txId>_approved. Treat that as already handled.
    const approved = await Transaction.findOne({
      $or: [
        { txId: `${externalRef}_approved` },
        { reference: externalRef },
        { providerRef: externalRef },
      ],
      type: 'Topup',
      status: 'Completed',
    });
    if (approved) return { orderId: null, alreadyProcessed: true };
    throw new Error(`No pending transaction found for ref: ${externalRef}`);
  }

  // Approve the top-up (add KS to wallet)
  const WalletService = require('./WalletService');
  const approved = await WalletService.approveTopup(transaction.txId, 0);

  // Keep webhook approvals consistent with manual approvals: commission is
  // keyed by the approved source txId so retries cannot pay twice.
  try {
    const { processTopupCommission } = require('./ReferralService');
    await processTopupCommission(approved.user._id, approved.amountKS, telegram, approved.txId || transaction.txId);
  } catch (err) {
    console.error('[WebhookProcessor] referral commission error:', err.message);
  }

  if (telegram) {
    try {
      await telegram.sendMessage(
        approved.user?.telegramId || transaction.userId?.telegramId || telegramId,
        `✅ *Payment Confirmed!*\n\n` +
          `💰 *${approved.amountKS?.toLocaleString() || '?'} KS* added to your wallet.\n` +
          `🔖 Ref: \`${externalRef}\`\n\n` +
          `_Approved automatically via payment gateway._`,
        { parse_mode: 'Markdown' },
      );
    } catch {}

    // Keep the public activity feed outside the business operation. A failed
    // post must never turn a successful wallet credit into a webhook retry.
    require('./LiveFeedService')
      .postTopup(telegram, {
        user: approved.user,
        amount: approved.amountKS,
        eventKey: `topup:${approved.txId}_approved`,
      })
      .catch((error) => console.error('[WebhookProcessor] live feed:', error.message));
  }

  return { orderId: null };
}

async function processPaymentRefunded(event, telegram) {
  const payload = event.payload || {};
  const externalRef = payload.externalRef || payload.transaction_id || payload.reference || payload.order_id || event.externalRef;
  if (!externalRef) throw new Error('Refund/chargeback event has no external reference');

  const transaction = await Transaction.findOne({
    $or: [
      { txId: externalRef },
      { txId: `${externalRef}_approved` },
      { reference: externalRef },
      { providerRef: externalRef },
    ],
    type: 'Topup',
    status: 'Completed',
  });
  if (!transaction) {
    // Provider retries after the bot already marked the source as reversed are safe.
    const alreadyReversed = await Transaction.findOne({
      $or: [{ txId: externalRef }, { txId: `${externalRef}_approved` }],
      type: 'Topup',
      reversalTxId: { $ne: null },
    });
    if (alreadyReversed) return { alreadyProcessed: true };
    throw new Error(`Completed top-up not found for refund reference: ${externalRef}`);
  }

  const { reverseTopupCommission } = require('./ReferralService');
  const sourceTxId = normalizeSourceTxId(externalRef);
  const reason = payload.reason || payload.note || (event.eventType === 'payment.chargeback' ? 'Payment chargeback' : 'Payment refunded');
  // approveTopup keeps the pending record as <source>_approved but the KS
  // ledger and referral commission use the original source txId.
  const reversal = await reverseTopupCommission(sourceTxId, 'System', reason);
  if (reversal) {
    await Transaction.updateMany(
      { $or: [{ txId: sourceTxId }, { txId: `${sourceTxId}_approved` }], type: 'Topup' },
      { $set: { reversalTxId: reversal.reversalTxId, reversedAt: new Date(), reversalReason: reason } },
    );
  }

  if (telegram && transaction.userId) {
    try {
      const user = await User.findById(transaction.userId).select('telegramId');
      if (user?.telegramId) {
        await telegram.sendMessage(user.telegramId, `↩️ Payment refund/chargeback recorded.\n\nReference: ${externalRef}\nReferral rewards linked to this top-up were reversed where applicable.`, { parse_mode: 'Markdown' });
      }
    } catch {}
  }
  return { alreadyProcessed: !reversal, reversalTxId: reversal?.reversalTxId || null };
}

async function processPaymentFailed(event, telegram) {
  const { externalRef } = event.payload;

  const transaction = await Transaction.findOneAndUpdate(
    {
      $or: [{ txId: externalRef }, { reference: externalRef }, { providerRef: externalRef }],
      type: 'Topup',
      status: 'Pending',
    },
    { status: 'Rejected', note: 'Rejected by payment gateway webhook' },
    { new: true },
  );

  if (transaction?.telegramId && telegram) {
    try {
      await telegram.sendMessage(
        transaction.telegramId,
        `❌ *Payment Not Confirmed*\n\n` +
          `Your top-up of ${transaction.amountKS?.toLocaleString() || '?'} KS could not be verified.\n` +
          `Reference: \`${externalRef}\`\n\n` +
          `_If you believe this is an error, contact /support with your receipt._`,
        { parse_mode: 'Markdown' },
      );
    } catch {}
  }

  return {};
}

async function processTopupDelivered(event, telegram) {
  const { externalRef, orderId: extOrderId, deliveryData } = event.payload;

  const order = await Order.findOne({
    $or: [{ _id: event.orderId }, { transactionId: externalRef }],
  })
    .populate('userId')
    .populate('productId');

  if (!order) throw new Error(`Order not found for ref: ${externalRef}`);
  if (order.status !== 'Pending') {
    if (order.status === 'Success' && order.transactionId === externalRef) {
      return { orderId: order._id, alreadyProcessed: true };
    }
    throw new Error(`Order ${order._id} is already ${order.status}`);
  }

  await Order.findByIdAndUpdate(order._id, {
    status: 'Success',
    deliveredData: deliveryData || 'Auto-delivered via API',
    transactionId: externalRef,
    processedBy: 0, // 0 = system/auto
    notes: 'Delivered automatically via provider API',
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
          (deliveryData
            ? `📬 *Delivery:*\n\`${deliveryData}\`\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n`
            : '') +
          `✅ *Status: Delivered*\n` +
          `_Auto-delivered via API — Thank you! 🎮_`,
        { parse_mode: 'Markdown' },
      );
    } catch {}
  }

  return { orderId: order._id };
}

async function processTopupFailed(event, telegram) {
  const { externalRef, reason } = event.payload;

  const order = await Order.findOne({
    $or: [{ _id: event.orderId }, { transactionId: externalRef }],
  })
    .populate('userId')
    .populate('productId');

  if (!order) throw new Error(`Order not found for ref: ${externalRef}`);
  if (order.status !== 'Pending') {
    if (order.status === 'Cancelled') {
      return { orderId: order._id, alreadyProcessed: true };
    }
    throw new Error(`Order ${order._id} is already ${order.status}`);
  }

  // Refund the user
  const OrderService = require('./OrderService');
  await OrderService.cancelAndRefund(
    order._id,
    0,
    `Auto-cancelled: provider reported failure — ${reason || 'delivery failed'}`,
  );

  if (order.userId?.telegramId && telegram) {
    try {
      await telegram.sendMessage(
        order.userId.telegramId,
        `❌ *Order Failed — Refunded*\n\n` +
          `📦 *${order.productId?.name || 'Your order'}* could not be delivered.\n` +
          `💰 *${order.amount.toLocaleString()} KS* has been returned to your wallet.\n\n` +
          `_Reason: ${reason || 'Provider delivery failed'}_\n\n` +
          `Contact /support if you need help.`,
        { parse_mode: 'Markdown' },
      );
    } catch {}
  }

  return { orderId: order._id };
}

// ── Watcher starter ───────────────────────────────────────────────────────────

function startWebhookProcessor(telegram) {
  // Initial run
  processPendingEvents(telegram).catch((e) =>
    console.error('[WebhookProcessor] Init error:', e.message),
  );
  setInterval(
    () =>
      processPendingEvents(telegram).catch((e) =>
        console.error('[WebhookProcessor] Poll error:', e.message),
      ),
    POLL_INTERVAL_MS,
  );
  console.log('[WebhookProcessor] ✅ Webhook event processor started');
}

module.exports = { startWebhookProcessor, processPendingEvents, normalizeSourceTxId };
