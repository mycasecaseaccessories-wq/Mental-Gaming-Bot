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
const Catalog = require('../models/Catalog');

const BOT_USERNAME = process.env.BOT_USERNAME || 'mentalgamingstorebot';

// ── Deep-link builder ─────────────────────────────────────────────────────────

function productDeepLink(productId) {
  return `https://t.me/${BOT_USERNAME}?start=product_${productId}`;
}

function accountProductDeepLink(accountProductId) {
  return `https://t.me/${BOT_USERNAME}?start=account_${accountProductId}`;
}

// Escape Markdown-reserved chars in user-supplied text (product names, descriptions…)
function mdEsc(s) {
  return String(s == null ? '' : s).replace(/([_*`\[])/g, '\\$1');
}

function captionSafe(text) {
  const value = String(text || '');
  return value.length <= 1024 ? value : `${value.slice(0, 1000)}\n\n…`;
}

// ── Product announcement formatter ───────────────────────────────────────────

/** Resolve a product's top-level catalog name, hiding nested sub-categories. */
async function withMainCategory(product) {
  if (!product?.catalogId) return product;
  try {
    let catalog = await Catalog.findById(product.catalogId).select('name parentCategory').lean();
    let guard = 0;
    while (catalog?.parentCategory && guard++ < 8) {
      const parent = await Catalog.findById(catalog.parentCategory).select('name parentCategory').lean();
      if (!parent) break;
      catalog = parent;
    }
    if (catalog?.name) return { ...product, mainCategory: catalog.name };
  } catch (err) {
    console.error('[BroadcastService] main category lookup failed:', err.message);
  }
  return product;
}

function categoryName(product) {
  return product?.mainCategory || product?.category || 'Product';
}

function formatNewProductAnnouncement(product) {
  const priceStr    = `${Number(product.finalPrice || 0).toLocaleString()} KS`;
  const categoryLine = `📂 Category: *${mdEsc(categoryName(product))}*\n🌍 Region: ${mdEsc(product.region || 'Global')}`;
  const typeLine    = product.deliveryMode === 'auto'
    ? '⚡ Instant delivery'
    : product.productType === 'DigitalCode' ? '⚡ Digital delivery' : '🧑‍💻 Manual delivery';
  const refundLine   = product.refundPolicy === 'none'
    ? '↩️ Refund: Not available'
    : product.refundPolicy === 'manual' ? '↩️ Refund: Admin review' : '↩️ Refund: Available';

  const stockLine = product.stockCount > 0
    ? `📦 Stock: ${product.stockCount} available`
    : product.stockCount === -1
      ? `📦 Stock: Unlimited`
      : ``;

  return (
    `🆕 *NEW PRODUCT*\n` +
    `\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
    `🎮 *${mdEsc(product.name)}*\n` +
    `${categoryLine}\n` +
    `💰 *${priceStr}*\n` +
    `${typeLine}\n` +
    (stockLine ? `${stockLine}\n` : ``) +
    (product.warrantyDays > 0 ? `🛡 Warranty: *${product.warrantyDays} days*\n` : ``) +
    (product.waitingTime ? `⏱ Waiting time: *${mdEsc(product.waitingTime)}*\n` : ``) +
    (Array.isArray(product.checkoutFieldsOverride) && product.checkoutFieldsOverride.length ? `🧾 Account info required\n` : ``) +
    (product.description ? `\n📝 _${mdEsc(product.description)}_\n` : ``) +
    `\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n` +
    `${refundLine}\n` +
    `\n🛒 Tap *Buy Now* below to order\n` +
    `🏪 *Mental Gaming Store*`
  );
}

function formatPriceUpdateAnnouncement(product, oldPrice, newPrice) {
  const diff    = newPrice - oldPrice;
  const base    = Number(oldPrice) || 1;
  const pct     = Math.round((Math.abs(diff) / base) * 100);
  const arrow   = diff < 0 ? '🔽' : '🔼';
  const dirWord = diff < 0 ? 'Price Drop' : 'Price Update';

  return (
    `${arrow} *${dirWord}*\n` +
    `\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
    `📂 Category: *${mdEsc(categoryName(product))}*\n` +
    `🎮 Product: *${mdEsc(product.name)}*\n\n` +
    `~~${Number(oldPrice).toLocaleString()} KS~~  →  *${Number(newPrice).toLocaleString()} KS*\n` +
    `${diff < 0 ? `🎉 Save *${Math.abs(diff).toLocaleString()} KS* (${pct}% OFF)` : `📈 Price increased by *${pct}%*`}\n\n` +
    `\`━━━━━━━━━━━━━━━━━━━━━━\`\n` +
    `🛒 Tap *Buy Now* below to order\n` +
    `🏪 *Mental Gaming Store*`
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
    `⚡ *FLASH SALE*\n` +
    `\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
    `📂 Category: *${mdEsc(categoryName(product))}*\n` +
    `🎮 Product: *${mdEsc(product.name)}*\n\n` +
    `~~${originalPrice.toLocaleString()} KS~~  →  *${salePrice.toLocaleString()} KS*\n` +
    `🎉 You save *${savings.toLocaleString()} KS* (${pct}% OFF)\n` +
    (product.warrantyDays > 0 ? `🛡 Warranty: *${product.warrantyDays} days*\n` : ``) +
    (product.waitingTime ? `⏱ Waiting time: *${mdEsc(product.waitingTime)}*\n` : ``) +
    `\n⏰ Ends: *${endsStr} MMT*\n\n` +
    `\`━━━━━━━━━━━━━━━━━━━━━━\`\n` +
    `🛒 Limited-time offer — tap *Buy Now* below`
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
    const { photo, ...sendOptions } = extra || {};
    const msg = photo
      ? await telegram.sendPhoto(channelId, photo, { caption: captionSafe(text), parse_mode: 'Markdown', ...(keyboard || {}), ...sendOptions })
      : await telegram.sendMessage(channelId, text, { parse_mode: 'Markdown', ...(keyboard || {}), ...sendOptions });
    return msg;
  } catch (err) {
    const description = String(err.response?.description || err.message || '');
    console.error(`[BroadcastService] Channel send failed (${channelId}):`, description);

    // Product names/descriptions can contain Telegram Markdown characters that
    // are valid user text but invalid legacy Markdown. Retry as plain text so a
    // formatting issue never prevents the actual announcement from posting.
    if (err.response?.error_code === 400 && /parse entities|can't parse|entity/i.test(description)) {
      try {
        const { photo, ...sendOptions } = extra || {};
        return photo
          ? await telegram.sendPhoto(channelId, photo, { caption: captionSafe(text), ...(keyboard || {}), ...sendOptions })
          : await telegram.sendMessage(channelId, text, { ...(keyboard || {}), ...sendOptions });
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
  const { photo, ...sendOptions } = extra || {};
  const request = photo
    ? telegram.sendPhoto(telegramId, photo, { caption: captionSafe(text), parse_mode: 'Markdown', ...sendOptions })
    : telegram.sendMessage(telegramId, text, { parse_mode: 'Markdown', ...sendOptions });
  return withTimeout(request);
}

/**
 * Send one message, honouring Telegram's retry_after on 429.
 * Marks the user isBlocked=true in DB on 403 (bot was blocked by user).
 * @returns {{status:'sent'|'blocked'|'failed', message?:object}}
 */
async function _sendOne(telegram, User, telegramId, text, extra) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const message = await sendMessageWithTimeout(telegram, telegramId, text, extra);
      return { status: 'sent', message };
    } catch (err) {
      lastError = err;
      const code = err.response?.error_code ?? err.code;
      const description = String(err.response?.description || err.message || '').toLowerCase();

      // These are permanent recipient failures; do not retry them.
      if (code === 403 || (code === 400 && (description.includes('chat not found') || description.includes('user not found')))) {
        User.updateOne({ telegramId }, { $set: { isBlocked: true } }).catch(() => {});
        return { status: 'blocked' };
      }

      // Rate limits, Telegram 5xx responses, network errors and timeouts are
      // transient. Retry with a bounded backoff so one temporary failure does
      // not make a broadcast permanently miss that user.
      const retryIn = Number(err.response?.parameters?.retry_after || 0);
      const transient = code === 429 || code >= 500 || /timeout|network|socket|econn|fetch failed/i.test(description);
      if (!transient || attempt >= 2) break;
      const waitMs = retryIn > 0
        ? Math.min((retryIn + 1) * 1000, 15000)
        : Math.min((attempt + 1) * 1500, 4500);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  console.warn(`[BroadcastService] delivery failed after retries for ${telegramId}:`, lastError?.message || 'unknown error');
  return { status: 'failed' };
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
  const configuredRetention = options.retentionSeconds != null
    ? Number(options.retentionSeconds)
    : Number((await SystemStatus.get()).broadcastRetentionMinutes || 0) * 60;
  const retentionSeconds = Number.isFinite(configuredRetention) ? Math.max(0, configuredRetention) : 0;
  const trackDeliveries = options.trackDeliveries === true || retentionSeconds > 0;
  const deliveryModel = trackDeliveries ? require('../models/AnnouncementDelivery') : null;
  const deleteAt = trackDeliveries && retentionSeconds > 0
    ? new Date(Date.now() + Math.min(retentionSeconds, 172800) * 1000)
    : null;

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
      for (let index = 0; index < results.length; index += 1) {
        const r = results[index];
        if (r.status === 'sent') {
          sent++;
          if (deliveryModel && r.message?.message_id) {
            await deliveryModel.create({
              scheduleId: options.scheduleId || null,
              runId: options.runId || null,
              chatId: batch[index].telegramId,
              messageId: r.message.message_id,
              destination: 'user',
              deleteAt,
            }).catch((err) => console.error('[BroadcastService] delivery tracking failed:', err.message));
          }
        } else if (r.status === 'blocked') blocked++;
        else failed++;
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

function formatCompactAccountAnnouncement(p) {
  return `${p.emoji || '🔐'} *${mdEsc(p.serviceName)} — ${mdEsc(p.planLabel)}*\n\n🛒 အောက်က button ကိုနှိပ်ပြီး ဝယ်ယူနိုင်ပါသည်။`;
}

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
async function announceAccountProductEverywhere(accountProduct, telegram, options = {}) {
  const AccountCredential = require('../models/AccountCredential');
  const isMulti = accountProduct.accountType === 'shared' || accountProduct.accountType === 'invite';
  const stock = isMulti
    ? await AccountCredential.countAvailableSlots(accountProduct._id)
    : await AccountCredential.countAvailable(accountProduct._id);

  const text = options.compact
    ? formatCompactAccountAnnouncement(accountProduct)
    : formatAccountAnnouncement(accountProduct, stock);
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.url(`🔐 ${mdEsc(accountProduct.serviceName)} ဝယ်မယ်`, accountProductDeepLink(accountProduct._id))],
  ]);

  const channelMsg = options.destination === 'users' ? null : await sendToChannel(telegram, text, null, { ...keyboard });
  const { sent, failed } = options.destination === 'channel'
    ? { sent: 0, failed: 0 }
    : await broadcastToUsers(telegram, text, { ...keyboard }, { ...options, trackDeliveries: Number(options.retentionSeconds) > 0 });

  return {
    channelOk: !!channelMsg,
    channelError: channelMsg ? null : (await validateAnnouncementChannel(telegram)).message,
    sent,
    failed,
  };
}

// ── Grouped announcement formatters ──────────────────────────────────────────
function groupedProductLine(product, style) {
  const name = mdEsc(product.name);
  const price = Number(style === 'flash' ? product.flashSalePrice : product.finalPrice);
  if (style === 'flash' && Number(product.flashSalePrice) > 0) {
    const original = Number(product.finalPrice || 0);
    return `📂 ${mdEsc(categoryName(product))}\n🎮 *${name}*\n   ~~${original.toLocaleString()} KS~~ → *${price.toLocaleString()} KS*`;
  }
  return `📂 ${mdEsc(categoryName(product))}\n🎮 *${name}*\n   💰 *${price.toLocaleString()} KS*`;
}

function formatGroupedProductAnnouncement(products, style = 'new') {
  const active = products.filter(Boolean);
  const title = style === 'flash' ? '⚡ *FLASH SALE — Limited Time!*' : '🆕 *NEW PRODUCTS*';
  const categories = [...new Set(active.map((product) => categoryName(product)))];
  const categoryLine = `📂 Category: *${categories.map(mdEsc).join(' · ')}*\n`;
  const lines = active.map((product) => groupedProductLine(product, style));
  const flashEnds = style === 'flash'
    ? active.map((p) => p.flashSaleEnd).filter(Boolean).map((d) => new Date(d).getTime()).filter(Number.isFinite)
    : [];
  const endLine = flashEnds.length
    ? `\n⏰ Ends at: *${new Date(Math.min(...flashEnds)).toLocaleString('en-GB', { timeZone: 'Asia/Rangoon', hour: '2-digit', minute: '2-digit' })} MMT*\n`
    : '';
  return `${title}\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n${categoryLine}\n${lines.join('\n\n')}${endLine}\n\n_ဝယ်ယူရန် အောက်က product button ကိုနှိပ်ပါ။ ရွေးချယ်ထားသော product ကို Buy Now နှိပ်ပြီး မှာယူနိုင်ပါသည်။_\n\n🏪 *Mental Gaming Store*`;
}

function groupedProductKeyboard(products) {
  return Markup.inlineKeyboard(products.map((product) => [
    Markup.button.url(`🛒 ${String(product.name).slice(0, 45)} ဝယ်မယ်`, productDeepLink(product._id)),
  ]));
}

/** Send a single grouped message for a category or multi-product selection. */
async function announceProductsEverywhere(products, style, telegram, options = {}) {
  const selected = (products || []).filter((p) => p && p.isActive !== false && (style !== 'flash' || Number(p.flashSalePrice) > 0));
  const eligible = await Promise.all(selected.map(withMainCategory));
  if (!eligible.length) return { channelOk: false, channelError: 'ကြော်ငြာရန် product မရှိပါ။', sent: 0, failed: 0, selectedCount: 0 };
  const text = formatGroupedProductAnnouncement(eligible, style);
  const keyboard = groupedProductKeyboard(eligible);
  const channelMsg = options.destination === 'users' ? null : await sendToChannel(telegram, text, null, { ...keyboard });
  const { sent, failed } = options.destination === 'channel'
    ? { sent: 0, failed: 0 }
    : await broadcastToUsers(telegram, text, { ...keyboard }, { ...options, trackDeliveries: Number(options.retentionSeconds) > 0 });
  return {
    channelOk: !!channelMsg,
    channelError: channelMsg ? null : (await validateAnnouncementChannel(telegram)).message,
    sent,
    failed,
    selectedCount: eligible.length,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

async function announceRefCampaignEverywhere(campaign, telegram, options = {}) {
  if (!campaign) return { channelOk: false, channelError: 'Campaign မရှိပါ။', sent: 0, failed: 0 };
  const reward = campaign.rewardType === 'product_price'
    ? `${campaign.rewardLabel || 'Product'} ကို ${Number(campaign.campaignPrice || 0).toLocaleString()} KS နဲ့ ဝယ်ခွင့်`
    : campaign.rewardType === 'product_free'
      ? `${campaign.rewardLabel || 'Product'} အခမဲ့ ဝယ်ခွင့်`
      : campaign.rewardType === 'ks'
        ? `${Number(campaign.rewardAmount || 0).toLocaleString()} KS`
        : campaign.rewardType === 'mc'
          ? `${Number(campaign.rewardAmount || 0).toLocaleString()} MC`
          : campaign.rewardLabel || 'Campaign reward';
  const text = `🎯 *${mdEsc(campaign.title)}*\n\n` +
    `သူငယ်ချင်း ${campaign.requiredRefs} ယောက်ကို valid referral အဖြစ် ဖိတ်ခေါ်ပြီး\n` +
    `🏆 ဆု: *${mdEsc(reward)}* ရယူလိုက်ပါ!\n\n` +
    (campaign.maxDailyInvites > 0 ? `📅 တစ်ရက်လျှင် အများဆုံး ${campaign.maxDailyInvites} ယောက်အထိ တွက်ပေးပါမယ်။\n` : '') +
    `🔗 ပါဝင်ရန် /referral ကိုနှိပ်ပြီး သင့် referral link ကို မျှဝေပါ။`;
  const { Markup } = require('telegraf');
  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🎯 Get My Referral Link', 'rc_user')]]);
  const channelMsg = options.destination === 'users' ? null : await sendToChannel(telegram, text, null, { ...keyboard });
  const userResult = options.destination === 'channel'
    ? { sent: 0, failed: 0 }
    : await broadcastToUsers(telegram, text, { ...keyboard }, { ...options, trackDeliveries: Number(options.retentionSeconds) > 0 });
  return {
    channelOk: !!channelMsg,
    channelError: channelMsg ? null : (await validateAnnouncementChannel(telegram)).message,
    sent: userResult.sent,
    failed: userResult.failed,
  };
}

async function announceNewProduct(product, telegram) {
  product = await withMainCategory(product);
  const text = formatNewProductAnnouncement(product);
  return sendToChannel(telegram, text, product._id, product.imageUrl ? { photo: product.imageUrl } : {});
}

async function announcePriceUpdate(product, oldPrice, newPrice, telegram) {
  if (Math.abs(newPrice - oldPrice) < 50) return null; // Skip tiny changes (<50 KS)
  product = await withMainCategory(product);
  const text = formatPriceUpdateAnnouncement(product, oldPrice, newPrice);
  return sendToChannel(telegram, text, product._id, product.imageUrl ? { photo: product.imageUrl } : {});
}

async function announceFlashSale(product, salePrice, endsAt, telegram) {
  product = await withMainCategory(product);
  const text = formatFlashSaleAnnouncement(product, salePrice, endsAt);
  return sendToChannel(telegram, text, product._id, product.imageUrl ? { photo: product.imageUrl } : {});
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
async function announceProductEverywhere(product, style, telegram, options = {}) {
  product = await withMainCategory(product);
  const text = options.compact
    ? `📂 *${mdEsc(categoryName(product))}*\n🎮 *${mdEsc(product.name)}*\n\n🛒 အောက်က button ကိုနှိပ်ပြီး ဝယ်ယူနိုင်ပါသည်။`
    : style === 'flash'
      ? formatFlashSaleAnnouncement(product, product.flashSalePrice, product.flashSaleEnd)
      : formatNewProductAnnouncement(product);

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.url(`🛒 ${product.name} ဝယ်မယ်`, productDeepLink(product._id))],
  ]);
  const media = product.imageUrl ? { photo: product.imageUrl } : {};

  const channelMsg = options.destination === 'users' ? null : await sendToChannel(telegram, text, null, { ...keyboard, ...media });
  const { sent, failed } = options.destination === 'channel'
    ? { sent: 0, failed: 0 }
    : await broadcastToUsers(telegram, text, { ...keyboard, ...media }, { ...options, trackDeliveries: Number(options.retentionSeconds) > 0 });

  return {
    channelOk: !!channelMsg,
    channelError: channelMsg ? null : (await validateAnnouncementChannel(telegram)).message,
    sent,
    failed,
  };
}

module.exports = {
  announceRefCampaignEverywhere,
  announceNewProduct,
  announcePriceUpdate,
  announceFlashSale,
  announceProductEverywhere,
  announceProductsEverywhere,
  formatGroupedProductAnnouncement,
  groupedProductKeyboard,
  announceAccountProductEverywhere,
  broadcastToUsers,
  customAnnounce,
  sendStockAlert,
  productDeepLink,
  accountProductDeepLink,
  mdEsc,
  validateAnnouncementChannel,
};
