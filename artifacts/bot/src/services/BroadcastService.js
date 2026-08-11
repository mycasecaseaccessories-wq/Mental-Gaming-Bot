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

/**
 * Validate the configured announcement channel before an admin tries to post.
 * Telegram returns different errors for a missing channel, a bot that is not
 * an administrator, and an administrator without post permission. Keeping the
 * check here makes /channels, /setannouncechannel, and /announce consistent.
 */
async function validateAnnouncementChannel(telegram, channelId = null) {
  const id = channelId || await getChannelId();
  if (!id) {
    return { ok: false, code: 'not_configured', message: 'Announcement channel မသတ်မှတ်ရသေးပါ။ /channels မှာ 📢 ကြေညာချက် channel အဖြစ် သတ်မှတ်ပါ။' };
  }

  try {
    const chat = await telegram.getChat(id);
    if (chat.type !== 'channel') {
      return { ok: false, code: 'not_channel', message: `သတ်မှတ်ထားတာက channel မဟုတ်ပါ (${chat.type})။` };
    }

    const me = await telegram.getMe();
    const member = await telegram.getChatMember(id, me.id);
    const status = member.status;
    if (!['administrator', 'creator'].includes(status)) {
      return { ok: false, code: 'not_admin', message: `Bot ကို channel မှာ admin မထည့်ထားပါ (status: ${status})။` };
    }
    if (status === 'administrator' && member.can_post_messages === false) {
      return { ok: false, code: 'no_post_permission', message: 'Bot က channel မှာ post တင်ခွင့် မရှိပါ။ Channel admin permissions ထဲမှာ “Post Messages” ကို ဖွင့်ပါ။' };
    }

    return {
      ok: true,
      channelId: String(id),
      title: chat.title || String(id),
      username: chat.username || null,
    };
  } catch (err) {
    const code = err.response?.error_code ?? err.code;
    const description = err.response?.description || err.message || 'Unknown Telegram error';
    return {
      ok: false,
      code: code === 400 ? 'invalid_channel' : 'telegram_error',
      message: `Channel စစ်မရပါ: ${description}`,
    };
  }
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
    const description = String(err.response?.description || err.message || '');
    console.error(`[BroadcastService] Channel send failed (${channelId}):`, description);

    // Product names/descriptions can contain Telegram Markdown characters that
    // are valid user text but invalid legacy Markdown. Retry as plain text so a
    // formatting issue never prevents the actual announcement from posting.
    if (err.response?.error_code === 400 && /parse entities|can't parse|entity/i.test(description)) {
      try {
        return await telegram.sendMessage(channelId, text, {
          ...(keyboard || {}),
          ...extra,
        });
      } catch (retryErr) {
        console.error(`[BroadcastService] Plain-text channel retry failed (${channelId}):`, retryErr.message);
      }
    }
    return null;
  }
}

// ── Broadcast to all bot users ───────────────────────────────────────────────

const USER_BATCH_SIZE  = 25;
const USER_BATCH_DELAY = 1100; // ms — keeps under Telegram's ~30 msg/sec global limit
const PAGE_SIZE        = 500;  // MongoDB cursor page size — avoids loading all users at once
const SEND_TIMEOUT      = 15000; // A stalled Telegram request must not stall the whole broadcast.

function withTimeout(promise, ms = SEND_TIMEOUT) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Telegram request timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function sendMessageWithTimeout(telegram, telegramId, text, extra) {
  return withTimeout(telegram.sendMessage(telegramId, text, { parse_mode: 'Markdown', ...extra }));
}

/**
 * Send one message, honouring Telegram's retry_after on 429.
 * Marks the user isBlocked=true in DB on 403 (bot was blocked by user).
 * @returns {'sent'|'blocked'|'failed'}
 */
async function _sendOne(telegram, User, telegramId, text, extra) {
  try {
    await sendMessageWithTimeout(telegram, telegramId, text, extra);
    return 'sent';
  } catch (err) {
    const code    = err.response?.error_code ?? err.code;
    const retryIn = err.response?.parameters?.retry_after;

    // 429 Too Many Requests — wait retry_after seconds then retry once
    if (code === 429 && retryIn) {
      // Do not let one Telegram rate-limit response hold an admin action
      // forever. Retry once, but cap the wait to a reasonable amount.
      const waitMs = Math.min((Number(retryIn) + 1) * 1000, 15000);
      await new Promise((r) => setTimeout(r, waitMs));
      try {
        await sendMessageWithTimeout(telegram, telegramId, text, extra);
        return 'sent';
      } catch {
        return 'failed';
      }
    }

    // 403 Forbidden — user blocked the bot; mark so future broadcasts skip them
    if (code === 403) {
      User.updateOne({ telegramId }, { $set: { isBlocked: true } }).catch(() => {});
      return 'blocked';
    }

    // 400 Bad Request with "chat not found" — stale record; mark blocked too
    if (code === 400) {
      const desc = String(err.response?.description || '').toLowerCase();
      if (desc.includes('chat not found') || desc.includes('user not found')) {
        User.updateOne({ telegramId }, { $set: { isBlocked: true } }).catch(() => {});
        return 'blocked';
      }
    }

    return 'failed';
  }
}

/**
 * Send a message to every non-blocked bot user (cursor-paginated, rate-limit safe).
 * @returns {Promise<{sent:number, blocked:number, failed:number}>}
 */
async function broadcastToUsers(telegram, text, extra = {}, options = {}) {
  const User = require('../models/User');
  let sent = 0, blocked = 0, failed = 0;
  let lastId = null;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

  // Cursor-based pagination: never loads the full user list into RAM
  while (true) {
    const query = { isBlocked: { $ne: true } };
    if (lastId) query._id = { $gt: lastId };

    const page = await User.find(query)
      .sort({ _id: 1 })
      .limit(PAGE_SIZE)
      .select('_id telegramId')
      .lean();

    if (!page.length) break;
    lastId = page[page.length - 1]._id;

    // Process PAGE in USER_BATCH_SIZE chunks with inter-batch delay
    for (let i = 0; i < page.length; i += USER_BATCH_SIZE) {
      const batch = page.slice(i, i + USER_BATCH_SIZE);
      const results = await Promise.all(
        batch.map((u) => _sendOne(telegram, User, u.telegramId, text, extra))
      );
      for (const r of results) {
        if (r === 'sent')    sent++;
        else if (r === 'blocked') blocked++;
        else                 failed++;
      }
      if (onProgress) {
        await onProgress({ sent, blocked, failed, processed: sent + blocked + failed });
      }
      if (i + USER_BATCH_SIZE < page.length) {
        await new Promise((r) => setTimeout(r, USER_BATCH_DELAY));
      }
    }
  }

  return { sent, blocked, failed };
}

// ── Account product announcement formatter ────────────────────────────────────

function formatAccountAnnouncement(p, stock) {
  const fp = Math.max(0, Math.round(p.price * (1 - (p.discountPercent || 0) / 100)));
  const perUnit = p.accountType === 'shared' ? ' / device'
    : p.accountType === 'invite' ? ' / member' : '';
  const priceStr = p.discountPercent > 0
    ? `~~${p.price.toLocaleString()} KS~~ → *${fp.toLocaleString()} KS*  🏷 _-${p.discountPercent}% လျှော့စျေး!_`
    : `*${fp.toLocaleString()} KS*`;
  const stockLine = p.accountType === 'shared'
    ? `📦 Stock: *device ${stock} ခုစာ* ကျန်ပါသည်`
    : p.accountType === 'invite'
      ? `📦 Stock: *member ${stock} ယောက်စာ* ကျန်ပါသည်`
      : `📦 Stock: *${stock}* ကျန်ပါသည်`;
  const typeNote = p.accountType === 'shared'
    ? `\n_📱 Account တစ်ခုကို device ${p.slotsPerUnit} ခုအထိ သုံးလို့ရပါသည်_`
    : p.accountType === 'invite'
      ? `\n_🔗 Link တစ်ခုကို member ${p.slotsPerUnit} ယောက်အထိ ဝင်လို့ရပါသည်_`
      : '';

  return (
    `${p.emoji || '🔐'} *${mdEsc(p.serviceName)} — ${mdEsc(p.planLabel)}*\n` +
    `\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
    `💵 စျေးနှုန်း: ${priceStr}${perUnit}\n` +
    `⏳ သက်တမ်း: *${p.durationDays} ရက်*\n` +
    `${stockLine}\n` +
    (p.description ? `\n📝 _${mdEsc(p.description)}_\n` : '') +
    typeNote +
    `\n\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n` +
    `🛒 Bot မှာ *🔐 Premium Accounts* ကိုနှိပ်ပြီး ဝယ်ယူနိုင်ပါသည်!\n` +
    `🏪 Mental Gaming Store`
  );
}

/**
 * Announce an AccountProduct to the announcement channel + all bot users.
 */
async function announceAccountProductEverywhere(accountProduct, telegram) {
  const AccountCredential = require('../models/AccountCredential');
  const isMulti = accountProduct.accountType === 'shared' || accountProduct.accountType === 'invite';
  const stock = isMulti
    ? await AccountCredential.countAvailableSlots(accountProduct._id)
    : await AccountCredential.countAvailable(accountProduct._id);

  const text = formatAccountAnnouncement(accountProduct, stock);
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.url(`🔐 ${mdEsc(accountProduct.serviceName)} ဝယ်မယ်`, `https://t.me/${BOT_USERNAME}`)],
  ]);

  const channelMsg = await sendToChannel(telegram, text, null, { ...keyboard });
  const { sent, failed } = await broadcastToUsers(telegram, text, { ...keyboard });

  return {
    channelOk: !!channelMsg,
    channelError: channelMsg ? null : (await validateAnnouncementChannel(telegram)).message,
    sent,
    failed,
  };
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

  return {
    channelOk: !!channelMsg,
    channelError: channelMsg ? null : (await validateAnnouncementChannel(telegram)).message,
    sent,
    failed,
  };
}

module.exports = {
  announceNewProduct,
  announcePriceUpdate,
  announceFlashSale,
  announceProductEverywhere,
  announceAccountProductEverywhere,
  broadcastToUsers,
  customAnnounce,
  sendStockAlert,
  productDeepLink,
  mdEsc,
  validateAnnouncementChannel,
};
