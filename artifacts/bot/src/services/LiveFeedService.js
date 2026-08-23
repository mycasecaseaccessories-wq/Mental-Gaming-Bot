/**
 * LiveFeedService
 *
 * Public activity notifications for configured Telegram channels.
 * The legacy single liveFeedChannelId remains supported; liveFeedChannels
 * adds fan-out to multiple destinations without changing existing callers.
 */

const SystemStatus = require('../models/SystemStatus');
const LiveFeedDelivery = require('../models/LiveFeedDelivery');

function maskUsername(user) {
  const raw = user?.username || user?.firstName || user?.first_name || '';
  if (!raw) return null;
  const value = String(raw).replace(/^@/, '');
  return `@${value.slice(0, Math.min(4, value.length))}****`;
}

function maskUserId(id) {
  const value = String(id ?? '');
  if (!value) return null;
  return `${value.slice(0, Math.min(6, value.length))}****`;
}

function maskedUser(user) {
  return maskUsername(user) || maskUserId(user?.telegramId || user?.id) || '@user****';
}

function escapeMarkdown(value) {
  return String(value ?? '').replace(/([_*`\[\]])/g, '\\$1');
}

async function getDestinations({ includeDisabled = false } = {}) {
  const st = await SystemStatus.get();
  if (!st.liveFeedEnabled && !includeDisabled) return [];

  const destinations = [];
  const add = (chatId, title = '', link = '') => {
    if (!chatId) return;
    const id = String(chatId);
    if (!destinations.some((item) => item.chatId === id)) {
      destinations.push({ chatId: id, title, link });
    }
  };

  add(st.liveFeedChannelId, 'Live Feed Channel');
  (st.liveFeedChannels || []).forEach((channel) => {
    add(channel.chatId, channel.title, channel.link);
  });
  return destinations;
}

/**
 * Send one event independently to every active destination.
 * A failed channel never prevents other channels from receiving the event.
 */
async function post(telegram, text, {
  eventKey,
  eventType = 'ACTIVITY',
  button = null,
  onlyChannelId = null,
  includeDisabled = false,
} = {}) {
  if (!telegram || !eventKey) return { sent: 0, failed: 0 };
  const destinations = (await getDestinations({ includeDisabled })).filter(
    (destination) => !onlyChannelId || destination.chatId === String(onlyChannelId)
  );
  let sent = 0;
  let failed = 0;

  for (const destination of destinations) {
    let marker;
    try {
      marker = await LiveFeedDelivery.create({
        eventKey,
        channelId: destination.chatId,
        eventType,
      });
    } catch (error) {
      if (error?.code === 11000) continue;
      console.error('[LiveFeed] idempotency marker error:', error.message);
      failed++;
      continue;
    }

    try {
      const extra = { parse_mode: 'Markdown' };
      if (button?.label && (button.url || button.action)) {
        const { Markup } = require('telegraf');
        const buttonConfig = button.url
          ? Markup.button.url(button.label, button.url)
          : Markup.button.callback(button.label, button.action);
        Object.assign(extra, Markup.inlineKeyboard([[buttonConfig]]));
      }
      await telegram.sendMessage(destination.chatId, text, extra);
      await LiveFeedDelivery.updateOne({ _id: marker._id }, { $set: { sentAt: new Date() } });
      sent++;
    } catch (error) {
      // Remove only this channel's marker so a later retry can recover.
      await LiveFeedDelivery.deleteOne({ _id: marker._id }).catch(() => {});
      console.error(`[LiveFeed] send error for ${destination.chatId}:`, error.message);
      failed++;
    }
  }

  return { sent, failed };
}

async function postPurchase(telegram, {
  user,
  productId = null,
  productName,
  qty = 1,
  productEmoji = '📦',
  eventKey = null,
} = {}) {
  const key = eventKey || `purchase:${user?._id || user?.telegramId}:${productName}:${qty}`;
  const name = escapeMarkdown(maskedUser(user));
  const button = productId
    ? {
        label: '🛒 Buy Now',
        url: require('./BroadcastService').productDeepLink(productId),
      }
    : null;
  return post(
    telegram,
    `🛒 *New Purchase*\n👤 User: ${name}\n📦 Product: *${escapeMarkdown(productName)}*\n💵 Quantity: *${qty}* ${productEmoji}\n✅ Successful`,
    { eventKey: key, eventType: 'PURCHASE_COMPLETED', button }
  );
}

async function postTopup(telegram, { user, amount, eventKey = null } = {}) {
  const key = eventKey || `topup:${user?._id || user?.telegramId}:${amount}`;
  const name = escapeMarkdown(maskedUser(user));
  return post(
    telegram,
    `💰 *New Top Up*\n👤 User: ${name}\n💵 Amount: *${Number(amount).toLocaleString()} KS*\n✅ Completed`,
    { eventKey: key, eventType: 'TOPUP_COMPLETED', button: { label: '💰 Top Up', action: 'start_topup' } }
  );
}

async function postGiveaway(telegram, {
  user,
  productName,
  productEmoji = '🎁',
  eventKey = null,
  remaining = null,
} = {}) {
  const key = eventKey || `giveaway:${user?._id || user?.telegramId}:${productName}`;
  const remainingLine = remaining === null ? '' : `\n🔥 Remaining: *${remaining}*`;
  const name = escapeMarkdown(maskedUser(user));
  return post(
    telegram,
    `🎁 *Giveaway Claimed*\n👤 User: ${name}\n🎁 Reward: ${productEmoji} *${escapeMarkdown(productName)}*${remainingLine}`,
    { eventKey: key, eventType: 'GIVEAWAY_CLAIMED' }
  );
}

async function sendTest(telegram, onlyChannelId = null) {
  return post(
    telegram,
    '🧪 *Live Feed Test*\nMental Gaming Bot live feed is working correctly.',
    {
      eventKey: `test:${onlyChannelId || 'all'}:${Date.now()}`,
      eventType: 'LIVE_FEED_TEST',
      onlyChannelId,
      // An explicit admin test is allowed to verify a configured channel even
      // when the production feed master switch is currently off.
      includeDisabled: true,
    }
  );
}

module.exports = {
  maskUsername,
  maskUserId,
  maskedUser,
  getDestinations,
  postPurchase,
  postTopup,
  postGiveaway,
  sendTest,
};