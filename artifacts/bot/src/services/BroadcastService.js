/**
 * BroadcastService — Cross-channel synchronization.
 *
 * Formats and forwards store announcements to the configured Telegram channel.
 * All channel IDs are stored live in SystemStatus (hot-configurable by admin).
 *
 * Announcement types:
 *   newProduct()     — new product added to the shop
 *   priceUpdate()    — product price changed
 *   flashSaleAlert() — flash sale starting (also used by FlashSaleService)
 *   stockAlert()     — low stock warning to admin channel
 *   customAnnounce() — free-form admin announcement with optional button
 *
 * Deep-link format: t.me/mentalgamingstorebot?start=product_<productId>
 */

const { Markup }   = require('telegraf');
const SystemStatus = require('../models/SystemStatus');

const BOT_USERNAME = process.env.BOT_USERNAME || 'mentalgamingstorebot';

// ── Deep-link builder ─────────────────────────────────────────────────────────

function productDeepLink(productId) {
  return `https://t.me/${BOT_USERNAME}?start=product_${productId}`;
}

// Escape Markdown-reserved chars in user-supplied text (product names, descriptions…)
function mdEsc(s) {
  return String(s == null ? '' : s).replace(/([_*`\[])/g, '\\$1');
}

// ── Product announcement formatter ───────────────────────────────────────────

function formatNewProductAnnouncement(product) {
  const priceStr    = `${product.finalPrice.toLocaleString()} KS`;
  const categoryLine = `📂 ${mdEsc(product.category)} · ${mdEsc(product.region)}`;
  const typeLine    = product.productType === 'DigitalCode' ? '⚡ Instant delivery' : '⏱ Delivered within 30 mins';

  const stockLine = product.stockCount > 0
    ? `📦 Stock: ${product.stockCount} available`
    : product.stockCount === -1
      ? `📦 Stock: Unlimited`
      : ``;

  return (
    `🆕 *New Product Alert!*\n` +
    `\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
    `🎮 *${mdEsc(product.name)}*\n` +
    `${categoryLine}\n` +
    `💰 Price: *${priceStr}*\n` +
    `${typeLine}\n` +
    (stockLine ? `${stockLine}\n` : ``) +
    (product.description ? `\n📝 _${mdEsc(product.description)}_\n` : ``) +
    `\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n` +
    `🏪 Mental Gaming Store`
  );
}

function formatPriceUpdateAnnouncement(product, oldPrice, newPrice) {
  const diff    = newPrice - oldPrice;
  const pct     = Math.round((Math.abs(diff) / oldPrice) * 100);
  const arrow   = diff < 0 ? '🔽' : '🔼';
  const dirWord = diff < 0 ? 'Price Drop' : 'Price Update';

  return (
    `${arrow} *${dirWord}: ${mdEsc(product.name)}*\n\n` +
    `~~${oldPrice.toLocaleString()} KS~~ → *${newPrice.toLocaleString()} KS*\n` +
    `${diff < 0 ? `🎉 Save *${Math.abs(diff).toLocaleString()} KS* (${pct}% off!)` : `+${pct}% update`}\n\n` +
    `🏪 Mental Gaming Store`
  );
}

function formatFlashSaleAnnouncement(product, salePrice, endsAt) {
  const originalPrice = product.finalPrice;
  const savings       = originalPrice - salePrice;
  const pct           = Math.round((savings / originalPrice) * 100);
  const endsStr       = endsAt
    ? new Date(endsAt).toLocaleString('en-GB', { timeZone: 'Asia/Rangoon', hour: '2-digit', minute: '2-digit' })
    : 'Limited time';

  return (
    `⚡ *FLASH SALE!*\n` +
    `\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
    `🎮 *${mdEsc(product.name)}*\n\n` +
    `~~${originalPrice.toLocaleString()} KS~~ → *${salePrice.toLocaleString()} KS*\n` +
    `🎉 Save *${savings.toLocaleString()} KS* (${pct}% OFF!)\n\n` +
    `⏰ Ends at: *${endsStr} MMT*\n\n` +
    `\`━━━━━━━━━━━━━━━━━━━━━━\`\n` +
    `⚡ _Limited time offer — hurry!_`
  );
}

// ── Send helpers ──────────────────────────────────────────────────────────────

async function getChannelId() {
  const status = await SystemStatus.get();
  return status.announcementChannelId || null;
}

async function sendToChannel(telegram, text, productId = null, extra = {}) {
  const channelId = await getChannelId();
  if (!channelId) return null;

  const keyboard = productId
    ? Markup.inlineKeyboard([[Markup.button.url('🛒 Order Now', productDeepLink(productId))]])
    : null;

  try {
    const msg = await telegram.sendMessage(channelId, text, {
      parse_mode: 'Markdown',
      ...(keyboard || {}),
      ...extra,
    });
    return msg;
  } catch (err) {
    console.error(`[BroadcastService] Channel send failed (${channelId}):`, err.message);
    return null;
  }
}

// ── Broadcast to all bot users ───────────────────────────────────────────────

const USER_BATCH_SIZE  = 25;
const USER_BATCH_DELAY = 1100; // ms — keeps under Telegram's ~30 msg/sec limit

/**
 * Send a message to every non-blocked bot user (batched, rate-limit safe).
 * @returns {Promise<{sent:number, failed:number}>}
 */
async function broadcastToUsers(telegram, text, extra = {}) {
  const User  = require('../models/User');
  const users = await User.find({ isBlocked: { $ne: true } }).select('telegramId').lean();

  let sent = 0, failed = 0;
  for (let i = 0; i < users.length; i += USER_BATCH_SIZE) {
    const batch = users.slice(i, i + USER_BATCH_SIZE);
    await Promise.all(batch.map(async (u) => {
      try {
        await telegram.sendMessage(u.telegramId, text, { parse_mode: 'Markdown', ...extra });
        sent++;
      } catch { failed++; }
    }));
    if (i + USER_BATCH_SIZE < users.length) {
      await new Promise((r) => setTimeout(r, USER_BATCH_DELAY));
    }
  }
  return { sent, failed };
}

// ── Public API ────────────────────────────────────────────────────────────────

async function announceNewProduct(product, telegram) {
  const text = formatNewProductAnnouncement(product);
  return sendToChannel(telegram, text, product._id);
}

async function announcePriceUpdate(product, oldPrice, newPrice, telegram) {
  if (Math.abs(newPrice - oldPrice) < 50) return null; // Skip tiny changes (<50 KS)
  const text = formatPriceUpdateAnnouncement(product, oldPrice, newPrice);
  return sendToChannel(telegram, text, product._id);
}

async function announceFlashSale(product, salePrice, endsAt, telegram) {
  const text = formatFlashSaleAnnouncement(product, salePrice, endsAt);
  return sendToChannel(telegram, text, product._id);
}

/**
 * Custom announcement from admin.
 * @param {{ title, body, buttonText?, productId? }} opts
 */
async function customAnnounce(opts, telegram) {
  const { title, body, buttonText, productId } = opts;
  const text = `*${title}*\n\n${body}`;
  const keyboard = productId
    ? Markup.inlineKeyboard([[Markup.button.url(buttonText || '🛒 Order Now', productDeepLink(productId))]])
    : null;

  return sendToChannel(telegram, text, null, keyboard ? { ...keyboard } : {});
}

/**
 * Low stock warning — sent to admin, not public channel.
 */
async function sendStockAlert(product, telegram) {
  const { config } = require('../../config/settings');
  const adminId = config.bot.adminId;
  if (!adminId) return;

  try {
    await telegram.sendMessage(
      adminId,
      `⚠️ *Low Stock Alert*\n\n` +
      `📦 Product: *${mdEsc(product.name)}*\n` +
      `🔢 Remaining: *${product.stockCount}* units\n\n` +
      `_Restock soon or pause the listing._`,
      { parse_mode: 'Markdown' }
    );
  } catch {}
}

/**
 * Announce a product to BOTH the announcement channel and all bot users.
 * @param {object} product  Mongoose Product doc
 * @param {'new'|'flash'} style
 * @returns {Promise<{channelOk:boolean, sent:number, failed:number}>}
 */
async function announceProductEverywhere(product, style, telegram) {
  const text = style === 'flash'
    ? formatFlashSaleAnnouncement(product, product.flashSalePrice, product.flashSaleEnd)
    : formatNewProductAnnouncement(product);

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.url(`🛒 ${product.name} ဝယ်မယ်`, productDeepLink(product._id))],
  ]);

  const channelMsg = await sendToChannel(telegram, text, null, { ...keyboard });
  const { sent, failed } = await broadcastToUsers(telegram, text, { ...keyboard });

  return { channelOk: !!channelMsg, sent, failed };
}

module.exports = {
  announceNewProduct,
  announcePriceUpdate,
  announceFlashSale,
  announceProductEverywhere,
  broadcastToUsers,
  customAnnounce,
  sendStockAlert,
  productDeepLink,
  mdEsc,
};
