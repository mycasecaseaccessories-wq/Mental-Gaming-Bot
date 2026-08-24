/**
 * Account Giveaway — give premium-account products away FREE to bot users.
 * MULTIPLE products can be given away at once (one giveaway per product), each
 * with individually toggleable restrictions:
 *   📦 max claims quota · ⏰ deadline · 📅 min account age ·
 *   🛒 must have purchased before · 📣 must join a channel
 * One claim per user PER giveaway (claim-record-first). 👤 Single accounts only.
 */
const { Markup } = require('telegraf');
const { adminOnly, isAnyAdmin } = require('../middlewares/adminCheck');
const { auditLog } = require('../services/logger');
const { broadcastToUsers } = require('../services/BroadcastService');
const { getKnownChannels } = require('../services/ChannelRegistryService');
const { generateCoupon } = require('../services/PromoService');
const { estimateAccountAgeDays } = require('../utils/accountAge');
const AccountGiveaway = require('../models/AccountGiveaway');
const AccountGiveawayClaim = require('../models/AccountGiveawayClaim');
const AccountProduct = require('../models/AccountProduct');
const AccountCredential = require('../models/AccountCredential');
const AccountSlot = require('../models/AccountSlot');
const Product = require('../models/Product');
const Order = require('../models/Order');
const User = require('../models/User');
const SystemStatus = require('../models/SystemStatus');
const { config } = require('../../config/settings');

const DAY_MS = 24 * 60 * 60 * 1000;
const TELEGRAM_REQUEST_TIMEOUT = 15000;

function telegramWithTimeout(promise, ms = TELEGRAM_REQUEST_TIMEOUT) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Telegram request timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function esc(s) {
  return String(s == null ? '' : s).replace(/([_*`\[])/g, '\\$1');
}
function cleanCred(s) {
  return String(s || '').replace(/`/g, '').trim();
}
function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-GB', { timeZone: 'Asia/Rangoon' });
}

function styledButton(button, style) { return { ...button, style }; }

function requiredChannelsOf(ga) {
  const list = Array.isArray(ga?.requireChannels) ? ga.requireChannels : [];
  if (list.length) return list.map((c) => ({ chatId: Number(c.chatId), title: c.title || String(c.chatId) }));
  if (ga?.requireChannelId) return [{ chatId: Number(ga.requireChannelId), title: ga.requireChannelTitle || String(ga.requireChannelId) }];
  return [];
}

async function clearGiveawayClaims(ga) {
  // Return finite shop units that were reserved by claimed coupons but never
  // consumed by an order. Then remove campaign-scoped claim history.
  if (ga?.kind === 'shop' && ga.shopProductId) {
    const reserved = await AccountGiveawayClaim.countDocuments({
      giveawayId: ga._id,
      shopStockReserved: true,
      shopStockConsumed: false,
    });
    if (reserved > 0) {
      await Product.updateOne(
        { _id: ga.shopProductId, stockCount: { $ne: -1 } },
        { $inc: { stockCount: reserved } }
      ).catch(() => {});
    }
  }
  await AccountGiveawayClaim.deleteMany({ giveawayId: ga._id });
}

// ── Kind-agnostic helpers ────────────────────────────────────────────────────
// A giveaway targets either a premium AccountProduct (kind 'account', any type:
// single/shared/invite) or a regular shop Product (kind 'shop', delivered as a
// 100%-off personal coupon). gaMeta() normalises both into one display shape.
function gaMeta(ga) {
  if (!ga) return null;
  if (ga.kind === 'shop') {
    const p = ga.shopProductId;
    if (!p) return null;
    return {
      doc: p, kind: 'shop', id: p._id,
      emoji: '🛍', title: p.name, sub: p.category || '',
      price: p.finalPrice || 0,
    };
  }
  const p = ga.productId;
  if (!p) return null;
  return {
    doc: p, kind: 'account', id: p._id,
    emoji: p.emoji || '🔐', title: p.serviceName, sub: p.planLabel || '',
    price: p.price || 0,
    accountType: p.accountType || 'single',
    isMulti: p.accountType === 'shared' || p.accountType === 'invite',
  };
}

// Live availability for a giveaway's target. Returns { count, unlimited }.
async function gaStock(ga) {
  const meta = gaMeta(ga);
  if (!meta) return { count: 0, unlimited: false };
  if (meta.kind === 'shop') {
    const p = meta.doc;
    if (!p.isActive) return { count: 0, unlimited: false };
    if (p.stockCount === -1) return { count: Infinity, unlimited: true };
    return { count: Math.max(0, p.stockCount), unlimited: false };
  }
  const count = meta.isMulti
    ? await AccountCredential.countAvailableSlots(meta.id)
    : await AccountCredential.countAvailable(meta.id);
  return { count, unlimited: false };
}

function stockText(s) {
  return s.unlimited || s.count === Infinity ? '∞' : String(s.count);
}

async function editOrReply(ctx, text, keyboard) {
  try {
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...(keyboard || {}) });
  } catch (e) {
    if (String(e?.description || e?.message || '').includes('message is not modified')) return;
    await ctx.reply(text, { parse_mode: 'Markdown', ...(keyboard || {}) });
  }
}

// ── Requirement checks (user side) ──────────────────────────────────────────

async function checkRequirements(ga, ctx) {
  const checks = [];

  if (ga.endAt) {
    const ok = ga.endAt.getTime() > Date.now();
    checks.push({ ok, label: `⏰ ${fmtDate(ga.endAt)} မတိုင်ခင် ရယူရမယ်` });
  }

  if (ga.minAccountAgeDays > 0) {
    const age = estimateAccountAgeDays(ctx.from.id);
    checks.push({
      ok: age >= ga.minAccountAgeDays,
      label: `📅 Telegram account သက်တမ်း ${ga.minAccountAgeDays} ရက်ကျော် ရှိရမယ်`,
    });
  }

  if (ga.requirePurchase) {
    const user = await User.findByTelegramId(ctx.from.id);
    const bought = user
      ? await Order.exists({ userId: user._id, status: 'Success' })
      : false;
    checks.push({ ok: !!bought, label: `🛒 Order တစ်ခါ အောင်မြင်စွာ ဝယ်ဖူးရမယ်` });
  }

  for (const channel of requiredChannelsOf(ga)) {
    let joined = false;
    try {
      const m = await ctx.telegram.getChatMember(channel.chatId, ctx.from.id);
      joined = ['member', 'administrator', 'creator'].includes(m?.status);
    } catch {}
    checks.push({
      ok: joined,
      label: `📣 "${esc(channel.title || 'channel')}" ကို join ထားရမယ်`,
      channelId: channel.chatId,
      channelTitle: channel.title || String(channel.chatId),
    });
  }

  return checks;
}

const joinUrlCache = new Map(); // chatId -> { url, exp }

async function channelJoinUrl(ctx, chatId) {
  const key = String(chatId);
  const hit = joinUrlCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.url;

  let url = null;
  try {
    const chat = await ctx.telegram.getChat(chatId);
    if (chat?.username) url = `https://t.me/${chat.username}`;
    else if (chat?.invite_link) url = chat.invite_link;
  } catch {}
  if (!url) {
    // Private channel with no existing link — generate one (bot must be
    // channel admin with "invite users" right)
    try {
      url = await ctx.telegram.exportChatInviteLink(chatId);
    } catch {}
  }
  if (url) joinUrlCache.set(key, { url, exp: Date.now() + 10 * 60 * 1000 });
  return url;
}

// ── User: entry point — list all active giveaways, or jump straight in if one ─

async function buildUserEntry(ctx) {
  // Giveaway Center: active first, then recently closed. Button background
  // carries status; button text stays the original product/account name.
  const gas = (await AccountGiveaway.find({})
    .populate('productId')
    .populate('shopProductId')
    .sort({ isActive: -1, updatedAt: -1 })
    .limit(12))
    .filter((g) => gaMeta(g));

  if (!gas.length) return null;

  let text =
    `🎁 *Giveaway Center*\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
    `_ပစ္စည်း/Account နာမည်ကို နှိပ်ပြီး အသေးစိတ်ကြည့်နိုင်ပါတယ်။_\n`;

  const rows = [];
  for (const g of gas) {
    const meta = gaMeta(g);
    const st = await gaStock(g);
    const already = await AccountGiveawayClaim.exists({ giveawayId: g._id, telegramId: ctx.from.id });
    const expired = !!(g.endAt && new Date(g.endAt).getTime() <= Date.now());
    const quotaFull = g.maxClaims > 0 && g.claimedCount >= g.maxClaims;
    const available = g.isActive && !expired && !quotaFull && st.count !== 0;

    let style = 'danger';
    if (already) style = 'primary';
    else if (available) style = 'success';

    const label = meta.kind === 'account'
      ? `${meta.title}${meta.sub ? ` — ${meta.sub}` : ''}`
      : meta.title;
    rows.push([styledButton(Markup.button.callback(label, `accga_free:${g._id}`), style)]);
  }

  rows.push([Markup.button.callback('🔙 Back', 'nav:go:main')]);
  return { text, keyboard: Markup.inlineKeyboard(rows) };
}

// ── User: single giveaway detail view ────────────────────────────────────────

async function buildUserView(ctx, ga) {
  const meta = gaMeta(ga);
  if (!meta) return null;
  const p = meta.doc;
  const isShop = meta.kind === 'shop';

  const s = await gaStock(ga);
  const stock = s.count;
  const already = await AccountGiveawayClaim.exists({ giveawayId: ga._id, telegramId: ctx.from.id });
  const quotaLeft = ga.maxClaims > 0 ? Math.max(0, ga.maxClaims - ga.claimedCount) : null;
  const checks = await checkRequirements(ga, ctx);
  const allOk = checks.every((c) => c.ok);
  const expired = !!(ga.endAt && new Date(ga.endAt).getTime() <= Date.now());
  const quotaFull = ga.maxClaims > 0 && ga.claimedCount >= ga.maxClaims;
  const closed = !ga.isActive || expired;

  let text =
    `🎁 *${isShop ? 'အခမဲ့ လက်ဆောင်!' : 'အခမဲ့ Premium Account!'}*\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
    `${meta.emoji} *${esc(meta.title)}*${meta.sub ? ` — ${esc(meta.sub)}` : ''}\n\n`;

  const stockDisp = stock === Infinity ? '∞' : stock;
  const remaining = quotaLeft !== null
    ? (stock === Infinity ? quotaLeft : Math.min(quotaLeft, stock))
    : stockDisp;
  text += `📦 *ကျန်အရေအတွက်: ${remaining} ခု*\n`;

  const rows = [];
  if (already) {
    text += `
✅ _သင် ရယူပြီးသားပါ — ${isShop ? '/mycoupons မှာ coupon ကြည့်ပါ' : '🎟 ကျွန်ုပ်၏ Accounts မှာ ကြည့်နိုင်ပါတယ်'}။_`;
    rows.push([Markup.button.callback(isShop ? '🎟 ကျွန်ုပ်၏ Coupons' : '🎟 ကျွန်ုပ်၏ Accounts', isShop ? 'promo_my_coupons' : 'acc_mine')]);
  } else if (closed) {
    text += `
🔴 _ဒီ Giveaway ကို ပိတ်ထားပြီးပါပြီ။_`;
  } else if (stock === 0 || quotaFull || (quotaLeft !== null && quotaLeft === 0)) {
    text += `
😢 _ကုန်သွားပါပြီ…_`;
  } else {
    const channelChecks = checks.filter((c) => c.channelId);
    for (const c of channelChecks) {
      if (c.ok) {
        rows.push([styledButton(Markup.button.callback(`✅ ${c.channelTitle} — Joined`, 'accga_joined_ok'), 'success')]);
      } else {
        const url = await channelJoinUrl(ctx, c.channelId);
        if (url) rows.push([styledButton(Markup.button.url(`📣 ${c.channelTitle} — Join`, url), 'danger')]);
      }
    }
    if (allOk) {
      rows.push([styledButton(Markup.button.callback('🎁 အခမဲ့ ရယူမယ်', `accga_claim:${ga._id}`), 'success')]);
    } else {
      // Keep the user-facing screen limited to stock and channel actions.
      // Requirement checks still run server-side when the claim is submitted.
      if (channelChecks.length) {
        rows.push([styledButton(Markup.button.callback('🔄 Join Status ပြန်စစ်မယ်', `accga_free:${ga._id}`), 'primary')]);
      }
    }
  }
  rows.push([
    Markup.button.callback('🎁 အခြားအခမဲ့', 'accga_free'),
    Markup.button.callback('🔙 Premium Accounts', 'acc_hub'),
  ]);

  return { text, keyboard: Markup.inlineKeyboard(rows) };
}

// ── Admin: choose what KIND of item to give away ─────────────────────────────

function buildKindPicker() {
  return {
    text:
      `➕ *အခမဲ့ အသစ် ထည့်ရန်*\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
      `ဘယ်အမျိုးအစား ဝေမလဲ ရွေးပါ:\n\n` +
      `🔐 *Premium Account* — login/link ကို တိုက်ရိုက် ပေးမယ် (single / multi-device / invite အားလုံး)\n` +
      `🛍 *Shop Product* — 100% coupon ထုတ်ပေးမယ် → user က /shop မှာ အခမဲ့ မှာယူ`,
    keyboard: Markup.inlineKeyboard([
      [Markup.button.callback('🔐 Premium Account', 'accga_newkind:account')],
      [Markup.button.callback('🛍 Shop Product', 'accga_newkind:shop')],
      [Markup.button.callback('🔙 Giveaways', 'accga_admin')],
    ]),
  };
}

// ── Admin: product picker (account OR shop) ──────────────────────────────────

/**
 * kind 'account' | 'shop'.
 * mode 'new' → create a giveaway; 'repick:<gaId>' → change an existing one
 *   (repick keeps the same kind as the giveaway being edited).
 */
async function buildPicker(kind, mode) {
  const isRepick = mode.startsWith('repick:');
  const gaId = isRepick ? mode.split(':')[1] : null;

  let rows = [];
  let hasAny = false;

  if (kind === 'shop') {
    // Exclude shop products that already have a giveaway.
    const taken = (await AccountGiveaway.distinct('shopProductId')).filter(Boolean);
    const filter = { isActive: true };
    if (mode === 'new') filter._id = { $nin: taken };
    const products = await Product.find(filter).sort({ sortOrder: 1, name: 1 }).limit(50);
    hasAny = products.length > 0;
    rows = products.map((p) => [
      Markup.button.callback(
        `🛍 ${p.name}`,
        isRepick ? `accga_setshop:${gaId}:${p._id}` : `accga_pickshop:${p._id}`
      ),
    ]);
  } else {
    // Account products — ALL types (single / shared / invite) are eligible.
    const taken = (await AccountGiveaway.distinct('productId')).filter(Boolean);
    const filter = {};
    if (mode === 'new') filter._id = { $nin: taken };
    const products = await AccountProduct.find(filter).sort({ displayOrder: 1, serviceName: 1 });
    hasAny = products.length > 0;
    rows = products.map((p) => [
      Markup.button.callback(
        `${p.emoji} ${p.serviceName} — ${p.planLabel}`,
        isRepick ? `accga_setprod:${gaId}:${p._id}` : `accga_pick:${p._id}`
      ),
    ]);
  }

  rows.push([Markup.button.callback('🔙 Giveaways', 'accga_admin')]);

  const kindLabel = kind === 'shop' ? '🛍 Shop product' : '🔐 Account product';
  const text = isRepick
    ? `♻️ *Product ပြောင်းရန်* — အခမဲ့ပေးမယ့် ${kindLabel} အသစ် ရွေးပါ:`
    : hasAny
      ? `➕ *${kindLabel} ရွေးပါ* — အခမဲ့ ဝေမယ့် product:\n_(Giveaway ရှိပြီးသား product တွေ မပြပါ။)_`
      : `_ထည့်လို့ရတဲ့ ${kindLabel} မကျန်တော့ပါ (အားလုံး giveaway ရှိပြီးသား သို့ inactive)။_`;

  return { text, keyboard: Markup.inlineKeyboard(rows) };
}

// ── Admin: giveaways list ────────────────────────────────────────────────────

async function buildAdminList() {
  const gas = await AccountGiveaway.find()
    .populate('productId')
    .populate('shopProductId')
    .sort({ isActive: -1, updatedAt: -1 });
  const valid = gas.filter((g) => gaMeta(g));

  if (!valid.length) {
    // Nothing configured yet → go straight to the "add" kind picker.
    const picker = buildKindPicker();
    return {
      text: `🎁 *Free Giveaways — Admin*\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
        `Giveaway မရှိသေးပါ။\n\n${picker.text}`,
      keyboard: picker.keyboard,
    };
  }

  let text =
    `🎁 *Free Giveaways — Admin*\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
    `_Account သို့ Shop product တွေကို အခမဲ့ ဝေလို့ရ။ တစ်ခုချင်း ဝင်စီမံပါ:_\n`;
  const rows = [];
  for (const g of valid) {
    const meta = gaMeta(g);
    const s = await gaStock(g);
    text +=
      `\n${g.isActive ? '🟢' : '🔴'} ${meta.emoji} *${esc(meta.title)}*${meta.sub ? ` — ${esc(meta.sub)}` : ''}` +
      `  •  🎯 ${g.claimedCount}${g.maxClaims > 0 ? `/${g.maxClaims}` : ''}  •  📦 ${stockText(s)}`;
    rows.push([
      Markup.button.callback(
        `${g.isActive ? '🟢' : '🔴'} ${meta.emoji} ${meta.title}${meta.sub ? ` — ${meta.sub}` : ''}`,
        `accga_view:${g._id}`
      ),
    ]);
  }
  rows.push([Markup.button.callback('➕ အခမဲ့ အသစ် ထည့်မယ်', 'accga_new')]);
  rows.push([Markup.button.callback('🔙 Accounts Panel', 'accad_panel')]);
  return { text, keyboard: Markup.inlineKeyboard(rows) };
}

// ── Admin: single giveaway detail panel ──────────────────────────────────────

async function buildGaDetail(gaId) {
  const ga = await AccountGiveaway.findById(gaId).populate('productId').populate('shopProductId');
  const meta = gaMeta(ga);
  if (!meta) return null;

  const s = await gaStock(ga);
  const id = ga._id;
  const kindTag = meta.kind === 'shop' ? '🛍 Shop product (100% coupon)' : `🔐 Account (${meta.accountType})`;

  const text =
    `🎁 *Free Giveaway — Admin*\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
    `${ga.isActive ? '🟢 *ဖွင့်ထားသည်* (user တွေ ရယူနိုင်)' : '🔴 *ပိတ်ထားသည်*'}\n\n` +
    `${meta.emoji} *${esc(meta.title)}*${meta.sub ? ` — ${esc(meta.sub)}` : ''}  (📦 stock ${stockText(s)})\n` +
    `🏷 ${kindTag}\n` +
    `🎯 ရယူပြီး: *${ga.claimedCount}*${ga.maxClaims > 0 ? ` / ${ga.maxClaims}` : ''}\n\n` +
    `*ကန့်သတ်ချက်များ:*\n` +
    `📦 အရေအတွက်: ${ga.maxClaims > 0 ? `*${ga.maxClaims} ယောက်ပဲ*` : '_မကန့်သတ် (stock ကုန်သည်အထိ)_'}\n` +
    `⏰ နောက်ဆုံးရက်: ${ga.endAt ? `*${fmtDate(ga.endAt)}*` : '_မကန့်သတ်_'}\n` +
    `📅 Account သက်တမ်း: ${ga.minAccountAgeDays > 0 ? `*${ga.minAccountAgeDays} ရက်ကျော်*` : '_မစစ်_'}\n` +
    `🛒 ဝယ်ဖူးမှ: ${ga.requirePurchase ? '*လိုအပ်*' : '_မလို_'}\n` +
    `📣 Channel join: ${requiredChannelsOf(ga).length ? `*${requiredChannelsOf(ga).length} ခု* — ${requiredChannelsOf(ga).map((c) => esc(c.title)).join(', ')}` : '_မလို_'}\n`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(ga.isActive ? '🔴 ရပ်မယ်' : '🟢 စတင်မယ်', `accga_toggle:${id}`)],
    [
      Markup.button.callback('📦 အရေအတွက်', `accga_max:${id}`),
      Markup.button.callback('⏰ ရက်သတ်မှတ်', `accga_days:${id}`),
    ],
    [
      Markup.button.callback('📅 Acc သက်တမ်း', `accga_age:${id}`),
      Markup.button.callback(`🛒 ဝယ်ဖူးမှ: ${ga.requirePurchase ? 'ON' : 'OFF'}`, `accga_purch:${id}`),
    ],
    [Markup.button.callback(`📣 Channels (${requiredChannelsOf(ga).length})`, `accga_chan:${id}`)],
    [
      Markup.button.callback('♻️ Product ပြောင်း', `accga_repick:${id}`),
      Markup.button.callback('🗑 ဖျက်', `accga_del:${id}`),
    ],
    ...(ga.isActive ? [[Markup.button.callback('📢 User တွေဆီ ကြေညာမယ်', `accga_announce:${id}`)]] : []),
    [Markup.button.callback('🔙 Giveaways', 'accga_admin')],
  ]);

  return { text, keyboard };
}

// ── Auto-end + owner notify after a successful claim ─────────────────────────

async function autoEndAndNotify(ctx, ga, updated, meta) {
  let stockLeft;
  if (meta.kind === 'shop') {
    const fresh = await Product.findById(meta.id);
    stockLeft = !fresh || !fresh.isActive
      ? 0
      : (fresh.stockCount === -1 ? Infinity : fresh.stockCount);
  } else {
    stockLeft = meta.isMulti
      ? await AccountCredential.countAvailableSlots(meta.id)
      : await AccountCredential.countAvailable(meta.id);
  }
  const quotaFull = updated.maxClaims > 0 && updated.claimedCount >= updated.maxClaims;
  if (quotaFull || stockLeft === 0) {
    await AccountGiveaway.updateOne({ _id: ga._id }, { $set: { isActive: false } }).catch(() => {});
  }
  await refreshAnnouncement(ctx.telegram, ga._id, updated.claimedCount, stockLeft, quotaFull || stockLeft === 0);
  try {
    const uname = ctx.from.username ? `@${ctx.from.username}` : `ID:${ctx.from.id}`;
    await ctx.telegram.sendMessage(
      config.bot.adminId,
      `🎁 *Giveaway ရယူသွားပြီ*\n\n${meta.emoji} ${esc(meta.title)}${meta.sub ? ` — ${esc(meta.sub)}` : ''}\n👤 ${esc(uname)}\n` +
        `🎯 ${updated.claimedCount}${updated.maxClaims > 0 ? `/${updated.maxClaims}` : ''} ယောက်မြောက်  •  📦 stock ${stockLeft === Infinity ? '∞' : stockLeft} ကျန်` +
        (quotaFull || stockLeft === 0 ? `\n\n🔴 *Giveaway အလိုအလျောက် ရပ်လိုက်ပါပြီ* (${quotaFull ? 'quota ပြည့်' : 'stock ကုန်'})` : ''),
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('[Giveaway] Admin notify failed:', err.message);
  }
}

async function refreshAnnouncement(telegram, giveawayId, claimedCount, stockLeft, ended = false) {
  try {
    const ga = await AccountGiveaway.findById(giveawayId).lean();
    if (!ga?.announcementChannelId || !ga.announcementMessageId || !ga.announcementBody) return;

    const quotaLeft = ga.maxClaims > 0 ? Math.max(0, ga.maxClaims - claimedCount) : null;
    const remaining = stockLeft === Infinity
      ? quotaLeft
      : (quotaLeft === null ? stockLeft : Math.min(quotaLeft, stockLeft));
    const progress = `\n\n👥 Claimed: *${claimedCount}*` +
      (ga.maxClaims > 0 ? ` / ${ga.maxClaims}` : '') +
      `\n🔥 Remaining: *${remaining === Infinity || remaining === null ? '∞' : remaining}*`;
    const status = ended ? '\n\n🔴 *Giveaway ended — claims are closed.*' : '';
    const extra = { parse_mode: 'Markdown' };
    if (!ended && ga.announcementButtonUrl) {
      extra.reply_markup = {
        inline_keyboard: [[
          { text: '🤖 Bot ဖွင့်မယ်', url: ga.announcementButtonUrl },
        ]],
      };
    }

    await telegram.editMessageText(
      ga.announcementChannelId,
      ga.announcementMessageId,
      undefined,
      `${ga.announcementBody}${progress}${status}`,
      extra
    );
  } catch (error) {
    console.error('[Giveaway] announcement update failed:', error.message);
  }
}

// ── Module ───────────────────────────────────────────────────────────────────

module.exports = function registerAccountGiveaway(bot) {
  // ══ USER SIDE ═══════════════════════════════════════════════════════════════

  // Entry (list or single) — no id
  bot.action('accga_free', async (ctx) => {
    await ctx.answerCbQuery();
    const view = await buildUserEntry(ctx);
    if (!view) return editOrReply(ctx, '😢 _လက်ရှိ giveaway မရှိတော့ပါ။_');
    await editOrReply(ctx, view.text, view.keyboard);
  });

  // A specific giveaway's detail — with id
  bot.action(/^accga_free:([a-f0-9]{24})$/, async (ctx) => {
    await ctx.answerCbQuery();
    const ga = await AccountGiveaway.findById(ctx.match[1]).populate('productId').populate('shopProductId');
    if (!ga || !gaMeta(ga)) {
      const view = await buildUserEntry(ctx);
      if (!view) return editOrReply(ctx, '😢 _လက်ရှိ giveaway မရှိတော့ပါ။_');
      return editOrReply(ctx, view.text, view.keyboard);
    }
    const view = await buildUserView(ctx, ga);
    await editOrReply(ctx, view.text, view.keyboard);
  });

  bot.command('freebie', async (ctx) => {
    const view = await buildUserEntry(ctx);
    if (!view) return ctx.reply('😢 လက်ရှိ အခမဲ့ giveaway မရှိသေးပါ။');
    await ctx.reply(view.text, { parse_mode: 'Markdown', ...view.keyboard });
  });

  bot.action(/^accga_claim:([a-f0-9]{24})$/, async (ctx) => {
    const ga = await AccountGiveaway.findById(ctx.match[1]).populate('productId').populate('shopProductId');
    if (!ga || !ga.isActive) return ctx.answerCbQuery('😢 Giveaway ပြီးသွားပါပြီ', { show_alert: true });
    const meta = gaMeta(ga);
    if (!meta) return ctx.answerCbQuery('😢 Giveaway ပြီးသွားပါပြီ', { show_alert: true });
    const p = meta.doc;

    const user = await User.findByTelegramId(ctx.from.id);
    if (!user) return ctx.answerCbQuery('❌ /start အရင်နှိပ်ပါ', { show_alert: true });

    // 1. Re-verify all restrictions at claim time
    const checks = await checkRequirements(ga, ctx);
    if (!checks.every((c) => c.ok)) {
      await ctx.answerCbQuery('❌ လိုအပ်ချက် မပြည့်မီသေးပါ', { show_alert: true });
      const view = await buildUserView(ctx, ga);
      if (view) await editOrReply(ctx, view.text, view.keyboard);
      return;
    }

    // 2. Claim record FIRST — unique index blocks double claims
    let claim;
    try {
      claim = await AccountGiveawayClaim.create({ giveawayId: ga._id, telegramId: ctx.from.id });
    } catch (err) {
      if (err?.code === 11000) {
        return ctx.answerCbQuery(
          meta.kind === 'shop' ? '✅ သင် ရယူပြီးသားပါ — /mycoupons မှာကြည့်ပါ' : '✅ သင် ရယူပြီးသားပါ — /myaccounts မှာကြည့်ပါ',
          { show_alert: true }
        );
      }
      console.error('[Giveaway] claim record failed:', err.message);
      return ctx.answerCbQuery('❌ တစ်ခုခုမှားနေပါတယ် — ခဏနေ ပြန်စမ်းပါ', { show_alert: true });
    }

    const rollbackClaim = () => AccountGiveawayClaim.deleteOne({ _id: claim._id }).catch(() => {});

    // 3. Atomically take a quota slot (guards active + deadline + max)
    const quotaGuard = {
      _id: ga._id,
      isActive: true,
      ...(ga.endAt ? { endAt: { $gt: new Date() } } : {}),
      ...(ga.maxClaims > 0 ? { claimedCount: { $lt: ga.maxClaims } } : {}),
    };
    const updated = await AccountGiveaway.findOneAndUpdate(
      quotaGuard,
      { $inc: { claimedCount: 1 } },
      { new: true }
    );
    if (!updated) {
      await rollbackClaim();
      return ctx.answerCbQuery('😢 နောက်ကျသွားပါပြီ — quota ကုန် (သို့) ပြီးဆုံးသွားပါပြီ', { show_alert: true });
    }
    const releaseQuota = () => AccountGiveaway.updateOne({ _id: ga._id }, { $inc: { claimedCount: -1 } }).catch(() => {});

    // 4. Dispatch by kind ──────────────────────────────────────────────────────

    // ── (A) Shop product → mint a personal 100%-off coupon ──────────────────────
    if (meta.kind === 'shop') {
      if (!p.isActive || !p.isInStock()) {
        await rollbackClaim();
        await releaseQuota();
        return ctx.answerCbQuery('😢 Stock ကုန်သွားပါပြီ', { show_alert: true });
      }
      let shopStockReserved = false;
      if (p.stockCount !== -1) {
        const reservedProduct = await Product.findOneAndUpdate(
          { _id: p._id, isActive: true, stockCount: { $gte: 1 } },
          { $inc: { stockCount: -1 } },
          { new: true }
        );
        if (!reservedProduct) {
          await rollbackClaim();
          await releaseQuota();
          return ctx.answerCbQuery('😢 Stock ကုန်သွားပါပြီ', { show_alert: true });
        }
        shopStockReserved = true;
      }
      let promo;
      try {
        promo = await generateCoupon(config.bot.adminId, {
          discountType: 'Percentage',
          value: 100,
          maxUses: null,
          perUserLimit: 1,
          scopeType: 'product',
          scopeProducts: [p._id],
          restrictedToUserId: user._id,
          source: 'reward',
          description: `Free giveaway: ${p.name}`,
          prefix: 'GIFT',
        });
      } catch (err) {
        console.error('[Giveaway] coupon mint failed:', err.message);
        if (shopStockReserved) await Product.findByIdAndUpdate(p._id, { $inc: { stockCount: 1 } }).catch(() => {});
        await rollbackClaim();
        await releaseQuota();
        return ctx.answerCbQuery('❌ တစ်ခုခုမှားနေပါတယ် — ခဏနေ ပြန်စမ်းပါ', { show_alert: true });
      }
      await AccountGiveawayClaim.updateOne(
        { _id: claim._id },
        { $set: { couponId: promo._id, shopStockReserved, shopStockConsumed: false } }
      ).catch(() => {});
      await ctx.answerCbQuery('🎉 ရပါပြီ!');
      await auditLog(ctx.from.id, 'CLAIM_GIVEAWAY_SHOP', promo._id.toString(), 'System', {
        product: p.name, code: promo.code, giveawayId: ga._id.toString(),
      });

      try {
        await ctx.reply(
          `🎉 *အခမဲ့ လက်ဆောင် ရရှိပါပြီ!*\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
            `🛍 *${esc(p.name)}*${p.category ? ` — ${esc(p.category)}` : ''}\n` +
            `💵 တန်ဖိုး ~${Number(p.finalPrice).toLocaleString()} KS~ → *အခမဲ့! 🎁*\n\n` +
            `🎟 သင့် Coupon: \`${promo.code}\`\n\n` +
            `👉 /shop ထဲဝင် → *${esc(p.name)}* ကို ရွေး → coupon အလိုအလျောက် ပါလာမယ် → *အခမဲ့* မှာယူပါ။\n` +
            `_(coupon က သင့်အတွက်သီးသန့် — တစ်ကြိမ်သာ သုံးလို့ရ။)_`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('🎟 ကျွန်ုပ်၏ Coupons', 'promo_my_coupons')]]),
          }
        );
      } catch (err) {
        try {
          await ctx.reply(
            `🎉 အခမဲ့ လက်ဆောင် ရရှိပါပြီ!\n\n${p.name}\n\n` +
              `Coupon: ${promo.code}\n\n/shop ထဲဝင် → ${p.name} ရွေး → coupon သုံးပြီး အခမဲ့ မှာယူပါ။\n/mycoupons နဲ့ ပြန်ကြည့်နိုင်ပါတယ်။`
          );
        } catch (err2) {
          console.error('[Giveaway] shop delivery failed completely:', err2.message);
        }
      }

      // Live feed notification (shop giveaway)
      require('../services/LiveFeedService').postGiveaway(ctx.telegram, {
        user: { username: ctx.from.username, firstName: ctx.from.first_name },
        productId: p._id,
        productName: p.name,
        productEmoji: '🛍',
        eventKey: `giveaway:${ga._id}:${ctx.from.id}`,
      }).catch(() => {});

      await autoEndAndNotify(ctx, ga, updated, meta);
      return;
    }

    // ── (B) Multi-slot account (shared / invite) → claim one slot ───────────────
    if (meta.isMulti) {
      let cred;
      try {
        cred = await AccountCredential.claimSlots(p._id, 1);
      } catch (err) {
        console.error('[Giveaway] claimSlots failed:', err.message);
      }
      if (!cred) {
        await rollbackClaim();
        await releaseQuota();
        return ctx.answerCbQuery('😢 Stock ကုန်သွားပါပြီ', { show_alert: true });
      }

      const now = new Date();
      const expiresAt = (p.stockDateExpiry && cred.stockExpiresAt)
        ? new Date(cred.stockExpiresAt)
        : new Date(now.getTime() + p.durationDays * DAY_MS);
      let slot;
      try {
        slot = await AccountSlot.create({
          productId: p._id,
          credentialId: cred._id,
          buyerUserId: user._id,
          buyerTelegramId: ctx.from.id,
          slots: 1,
          soldAt: now,
          expiresAt,
          pricePaid: 0,
          credTypeSnap: cred.credType,
          serviceNameSnap: p.serviceName,
          planLabelSnap: p.planLabel,
          durationDaysSnap: p.durationDays,
          loginIdSnap: cred.loginId,
          passwordSnap: cred.password,
          linkSnap: cred.link,
          noteSnap: cred.note,
        });
      } catch (err) {
        console.error('[Giveaway] ⚠️ AccountSlot record failed — rolling back:', err.message);
        try { await AccountCredential.releaseSlots(cred._id, 1); } catch (e) {
          console.error('[Giveaway] ❌ releaseSlots failed:', e.message);
        }
        await rollbackClaim();
        await releaseQuota();
        return ctx.answerCbQuery('❌ တစ်ခုခုမှားနေပါတယ် — ခဏနေ ပြန်စမ်းပါ', { show_alert: true });
      }

      await AccountGiveawayClaim.updateOne({ _id: claim._id }, { $set: { slotId: slot._id } }).catch(() => {});
      await ctx.answerCbQuery('🎉 ရပါပြီ!');
      await auditLog(ctx.from.id, 'CLAIM_GIVEAWAY_SLOT', cred._id.toString(), 'System', {
        product: `${p.serviceName} ${p.planLabel}`, giveawayId: ga._id.toString(),
      });

      const word = p.accountType === 'shared' ? 'device' : 'member';
      const isLink = cred.credType === 'link';
      const bodyMd = isLink
        ? `🔗 Invite Link:\n${esc(cred.link)}\n` + (cred.note ? `📝 ${esc(cred.note)}\n` : '')
        : `📧 Login: \`${cleanCred(cred.loginId)}\`\n🔑 Password: \`${cleanCred(cred.password)}\`\n` +
          (cred.note ? `📝 ${esc(cred.note)}\n` : '');
      try {
        await ctx.reply(
          `🎉 *အခမဲ့ ရယူမှု အောင်မြင်ပါသည်!*\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
            `${p.emoji} *${esc(p.serviceName)}* — ${esc(p.planLabel)}\n` +
            `🔢 *1 ${word}* အတွက်\n\n` +
            bodyMd +
            `\n⏳ သက်တမ်းကုန်: *${fmtDate(expiresAt)}* (${Math.ceil((new Date(expiresAt).getTime() - Date.now()) / DAY_MS)} ရက်)\n` +
            `💵 ကျသင့်ငွေ: *အခမဲ့! 🎁*\n\n` +
            (isLink ? `_🔗 Link ကို နှိပ်ပြီး ဝင်ပါ။_` : `_👆 Login/Password ကို နှိပ်ရင် copy ဖြစ်ပါမယ်။_`),
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('🎟 ကျွန်ုပ်၏ Accounts', 'acc_mine')]]),
          }
        );
      } catch (err) {
        try {
          await ctx.reply(
            `🎉 အခမဲ့ ရယူမှု အောင်မြင်ပါသည်!\n\n${p.serviceName} — ${p.planLabel} (1 ${word})\n\n` +
              (isLink ? `Invite Link: ${cred.link}\n` : `Login: ${cred.loginId}\nPassword: ${cred.password}\n`) +
              (cred.note ? `Note: ${cred.note}\n` : '') +
              `\nသက်တမ်းကုန်: ${fmtDate(expiresAt)}\n\n/myaccounts နဲ့ အမြဲ ပြန်ကြည့်နိုင်ပါတယ်။`
          );
        } catch (err2) {
          console.error('[Giveaway] slot delivery failed completely:', err2.message);
        }
      }

      // Live feed notification (multi-slot giveaway)
      require('../services/LiveFeedService').postGiveaway(ctx.telegram, {
        user: { username: ctx.from.username, firstName: ctx.from.first_name },
        accountProductId: p._id,
        productName: `${p.serviceName} ${p.planLabel}`,
        productEmoji: p.emoji || '🎁',
        eventKey: `giveaway:${ga._id}:${ctx.from.id}`,
      }).catch(() => {});

      await autoEndAndNotify(ctx, ga, updated, meta);
      return;
    }

    // ── (C) Single account → claim one credential ──────────────────────────────
    let cred;
    try {
      const now = new Date();
      cred = await AccountCredential.claimOne(p._id, {
        buyerUserId: user._id,
        buyerTelegramId: ctx.from.id,
        soldAt: now,
        expiresAt: new Date(now.getTime() + p.durationDays * DAY_MS),
        pricePaid: 0,
        serviceNameSnap: p.serviceName,
        planLabelSnap: p.planLabel,
        durationDaysSnap: p.durationDays,
      });
    } catch (err) {
      console.error('[Giveaway] claimOne failed:', err.message);
    }

    if (!cred) {
      await rollbackClaim();
      await releaseQuota();
      return ctx.answerCbQuery('😢 Stock ကုန်သွားပါပြီ', { show_alert: true });
    }

    // Stock-date products: winner inherits the credential's remaining shelf life
    if (p.stockDateExpiry && cred.stockExpiresAt) {
      cred.expiresAt = cred.stockExpiresAt;
      try { await cred.save(); } catch (e) { console.error('[Giveaway] ⚠️ expiry sync failed:', e.message); }
    }

    await AccountGiveawayClaim.updateOne({ _id: claim._id }, { $set: { credentialId: cred._id } }).catch(() => {});
    await ctx.answerCbQuery('🎉 ရပါပြီ!');
    await auditLog(ctx.from.id, 'CLAIM_GIVEAWAY_ACCOUNT', cred._id.toString(), 'System', {
      product: `${p.serviceName} ${p.planLabel}`, giveawayId: ga._id.toString(),
    });

    // Deliver (plain-text fallback — never roll back after credential assigned)
    try {
      await ctx.reply(
        `🎉 *အခမဲ့ ရယူမှု အောင်မြင်ပါသည်!*\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
          `${p.emoji} *${esc(p.serviceName)}* — ${esc(p.planLabel)}\n\n` +
          `📧 Login: \`${cleanCred(cred.loginId)}\`\n` +
          `🔑 Password: \`${cleanCred(cred.password)}\`\n` +
          (cred.note ? `📝 ${esc(cred.note)}\n` : '') +
          `\n⏳ သက်တမ်းကုန်: *${fmtDate(cred.expiresAt)}* (${Math.ceil((new Date(cred.expiresAt).getTime() - Date.now()) / DAY_MS)} ရက်)\n` +
          `💵 ကျသင့်ငွေ: *အခမဲ့! 🎁*\n\n` +
          `_👆 Login/Password ကို နှိပ်ရင် copy ဖြစ်ပါမယ်။_`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('🎟 ကျွန်ုပ်၏ Accounts', 'acc_mine')]]),
        }
      );
    } catch (err) {
      try {
        await ctx.reply(
          `🎉 အခမဲ့ ရယူမှု အောင်မြင်ပါသည်!\n\n${p.serviceName} — ${p.planLabel}\n\n` +
            `Login: ${cred.loginId}\nPassword: ${cred.password}\n` +
            (cred.note ? `Note: ${cred.note}\n` : '') +
            `\nသက်တမ်းကုန်: ${fmtDate(cred.expiresAt)}\n\n/myaccounts နဲ့ အမြဲ ပြန်ကြည့်နိုင်ပါတယ်။`
        );
      } catch (err2) {
        console.error('[Giveaway] delivery failed completely:', err2.message);
      }
    }

    // Live feed notification (single account giveaway)
    require('../services/LiveFeedService').postGiveaway(ctx.telegram, {
      user: { username: ctx.from.username, firstName: ctx.from.first_name },
      accountProductId: p._id,
      productName: `${p.serviceName} ${p.planLabel}`,
      productEmoji: p.emoji || '🎁',
      eventKey: `giveaway:${ga._id}:${ctx.from.id}`,
    }).catch(() => {});

    await autoEndAndNotify(ctx, ga, updated, meta);
  });

  // Main-menu Giveaway button for regular users. Let the owner fall through
  // to the existing admin Giveaway handler below.
  bot.hears(['🎁 Giveaway', '🎁 Free Accounts', '🎁 အခမဲ့ရယူမယ်'], async (ctx, next) => {
    if (Number(ctx.from?.id) === Number(config.bot.adminId)) return next();
    const view = await buildUserEntry(ctx);
    if (!view) return ctx.reply('😢 လက်ရှိ Giveaway မရှိသေးပါ။');
    await ctx.reply(view.text, { parse_mode: 'Markdown', ...view.keyboard });
  });

  // ══ ADMIN SIDE (Owner) ══════════════════════════════════════════════════════

  bot.action('accga_admin', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const { text, keyboard } = await buildAdminList();
    await editOrReply(ctx, text, keyboard);
  });

  bot.hears('🎁 Giveaway Admin', adminOnly(), async (ctx) => {
    const { text, keyboard } = await buildAdminList();
    await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  });

  bot.command('setgiveawaydelete', adminOnly(), async (ctx) => {
    const [, giveawayId, secondsText] = ctx.message.text.trim().split(/\s+/);
    const seconds = Number(secondsText);
    if (!/^[a-f0-9]{24}$/i.test(giveawayId || '') || !Number.isInteger(seconds) || seconds < 0) {
      return ctx.reply('Usage: /setgiveawaydelete <giveawayId> <seconds>\nUse 0 to keep the final announcement.');
    }
    const ga = await AccountGiveaway.findByIdAndUpdate(
      giveawayId,
      { $set: { deleteAfterSeconds: seconds } },
      { new: true }
    );
    if (!ga) return ctx.reply('❌ Giveaway မတွေ့ပါ။');
    return ctx.reply(
      seconds === 0
        ? '✅ Expired giveaway announcement ကို ဖျက်မည်မဟုတ်ပါ။'
        : `✅ Expired giveaway announcement ကို ${seconds} seconds နောက် ဖျက်ပါမယ်။`
    );
  });
  bot.command('giveaway', adminOnly(), async (ctx) => {
    const { text, keyboard } = await buildAdminList();
    await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  });

  // Open a single giveaway's detail panel
  bot.action(/^accga_view:([a-f0-9]{24})$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const detail = await buildGaDetail(ctx.match[1]);
    if (!detail) {
      const { text, keyboard } = await buildAdminList();
      return editOrReply(ctx, text, keyboard);
    }
    await editOrReply(ctx, detail.text, detail.keyboard);
  });

  // ➕ Add new giveaway — pick kind first (account vs shop product)
  bot.action('accga_new', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const { text, keyboard } = buildKindPicker();
    await editOrReply(ctx, text, keyboard);
  });

  // Kind chosen → show that kind's product picker
  bot.action(/^accga_newkind:(account|shop)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const { text, keyboard } = await buildPicker(ctx.match[1], 'new');
    await editOrReply(ctx, text, keyboard);
  });

  // Create a new ACCOUNT giveaway for the chosen product (any account type)
  bot.action(/^accga_pick:([a-f0-9]{24})$/, adminOnly(), async (ctx) => {
    const p = await AccountProduct.findById(ctx.match[1]);
    if (!p) return ctx.answerCbQuery('❌ Product မတွေ့ပါ', { show_alert: true });
    let ga = await AccountGiveaway.findOne({ productId: p._id });
    if (!ga) {
      ga = await AccountGiveaway.create({ kind: 'account', productId: p._id, createdBy: ctx.from.id });
      await auditLog(ctx.from.id, 'CREATE_GIVEAWAY', ga._id.toString(), 'System', {
        product: `${p.serviceName} ${p.planLabel}`,
      });
      await ctx.answerCbQuery('✅ Giveaway အသစ် ဖန်တီးပြီး');
    } else {
      await ctx.answerCbQuery('ℹ️ ဒီ product အတွက် giveaway ရှိပြီးသားပါ');
    }
    const detail = await buildGaDetail(ga._id);
    await editOrReply(ctx, detail.text, detail.keyboard);
  });

  // Create a new SHOP giveaway for the chosen product
  bot.action(/^accga_pickshop:([a-f0-9]{24})$/, adminOnly(), async (ctx) => {
    const p = await Product.findById(ctx.match[1]);
    if (!p) return ctx.answerCbQuery('❌ Product မတွေ့ပါ', { show_alert: true });
    let ga = await AccountGiveaway.findOne({ shopProductId: p._id });
    if (!ga) {
      ga = await AccountGiveaway.create({ kind: 'shop', shopProductId: p._id, createdBy: ctx.from.id });
      await auditLog(ctx.from.id, 'CREATE_GIVEAWAY', ga._id.toString(), 'System', { product: p.name, kind: 'shop' });
      await ctx.answerCbQuery('✅ Giveaway အသစ် ဖန်တီးပြီး');
    } else {
      await ctx.answerCbQuery('ℹ️ ဒီ product အတွက် giveaway ရှိပြီးသားပါ');
    }
    const detail = await buildGaDetail(ga._id);
    await editOrReply(ctx, detail.text, detail.keyboard);
  });

  // ♻️ Change product of an existing giveaway — picker (same kind)
  bot.action(/^accga_repick:([a-f0-9]{24})$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const ga = await AccountGiveaway.findById(ctx.match[1]);
    if (!ga) return editOrReply(ctx, '❌ Giveaway မတွေ့ပါ');
    const { text, keyboard } = await buildPicker(ga.kind || 'account', `repick:${ctx.match[1]}`);
    await editOrReply(ctx, text, keyboard);
  });

  // Re-point an ACCOUNT giveaway to a different account product
  bot.action(/^accga_setprod:([a-f0-9]{24}):([a-f0-9]{24})$/, adminOnly(), async (ctx) => {
    const [, gaId, prodId] = ctx.match;
    const p = await AccountProduct.findById(prodId);
    if (!p) return ctx.answerCbQuery('❌ Product မတွေ့ပါ', { show_alert: true });
    // one giveaway per product — block if another giveaway already owns it
    const clash = await AccountGiveaway.findOne({ productId: p._id, _id: { $ne: gaId } });
    if (clash) return ctx.answerCbQuery('❌ ဒီ product အတွက် giveaway ရှိပြီးသားပါ', { show_alert: true });
    const ga = await AccountGiveaway.findById(gaId);
    if (!ga) return ctx.answerCbQuery('❌ Giveaway မတွေ့ပါ', { show_alert: true });
    ga.kind = 'account';
    ga.productId = p._id;
    ga.shopProductId = undefined;
    ga.claimedCount = 0;
    ga.isActive = false;
    ga.announcementChannelId = null;
    ga.announcementMessageId = null;
    ga.announcementBody = null;
    ga.announcementButtonUrl = null;
    ga.deleteAt = null;
    await clearGiveawayClaims(ga);
    await ga.save();
    await auditLog(ctx.from.id, 'SET_GIVEAWAY_PRODUCT', ga._id.toString(), 'System', {
      product: `${p.serviceName} ${p.planLabel}`,
    });
    await ctx.answerCbQuery('✅ Product ပြောင်းပြီး');
    const detail = await buildGaDetail(ga._id);
    await editOrReply(ctx, detail.text, detail.keyboard);
  });

  // Re-point a SHOP giveaway to a different shop product
  bot.action(/^accga_setshop:([a-f0-9]{24}):([a-f0-9]{24})$/, adminOnly(), async (ctx) => {
    const [, gaId, prodId] = ctx.match;
    const p = await Product.findById(prodId);
    if (!p) return ctx.answerCbQuery('❌ Product မတွေ့ပါ', { show_alert: true });
    const clash = await AccountGiveaway.findOne({ shopProductId: p._id, _id: { $ne: gaId } });
    if (clash) return ctx.answerCbQuery('❌ ဒီ product အတွက် giveaway ရှိပြီးသားပါ', { show_alert: true });
    const ga = await AccountGiveaway.findById(gaId);
    if (!ga) return ctx.answerCbQuery('❌ Giveaway မတွေ့ပါ', { show_alert: true });
    await clearGiveawayClaims(ga);
    ga.kind = 'shop';
    ga.shopProductId = p._id;
    ga.productId = undefined;
    ga.claimedCount = 0;
    ga.isActive = false;
    ga.announcementChannelId = null;
    ga.announcementMessageId = null;
    ga.announcementBody = null;
    ga.announcementButtonUrl = null;
    ga.deleteAt = null;
    await ga.save();
    await auditLog(ctx.from.id, 'SET_GIVEAWAY_PRODUCT', ga._id.toString(), 'System', { product: p.name, kind: 'shop' });
    await ctx.answerCbQuery('✅ Product ပြောင်းပြီး');
    const detail = await buildGaDetail(ga._id);
    await editOrReply(ctx, detail.text, detail.keyboard);
  });

  bot.action(/^accga_toggle:([a-f0-9]{24})$/, adminOnly(), async (ctx) => {
    const ga = await AccountGiveaway.findById(ctx.match[1]).populate('productId').populate('shopProductId');
    const meta = gaMeta(ga);
    if (!meta) return ctx.answerCbQuery('❌ Giveaway မရှိသေးပါ', { show_alert: true });

    if (!ga.isActive) {
      const s = await gaStock(ga);
      if (s.count === 0) return ctx.answerCbQuery('❌ Stock မရှိလို့ မစနိုင်ပါ — 📥 Stock အရင်ထည့်ပါ', { show_alert: true });
      if (ga.endAt && ga.endAt.getTime() <= Date.now()) {
        return ctx.answerCbQuery('❌ နောက်ဆုံးရက် ကျော်နေပါပြီ — ⏰ ရက် ပြန်သတ်မှတ်ပါ', { show_alert: true });
      }
      if (ga.maxClaims > 0 && ga.claimedCount >= ga.maxClaims) {
        return ctx.answerCbQuery('❌ Claim quota ပြည့်နေပါပြီ — 📦 အရေအတွက်ကို claimed count ထက်ပိုသတ်မှတ်ပါ', { show_alert: true });
      }
      ga.isActive = true;
    } else {
      ga.isActive = false;
    }
    await ga.save();
    await auditLog(ctx.from.id, 'TOGGLE_GIVEAWAY', ga._id.toString(), 'System', { isActive: ga.isActive });
    await ctx.answerCbQuery(ga.isActive ? '🟢 စတင်ပြီး!' : '🔴 ရပ်လိုက်ပြီ');
    const detail = await buildGaDetail(ga._id);
    await editOrReply(ctx, detail.text, detail.keyboard);
  });

  bot.action(/^accga_purch:([a-f0-9]{24})$/, adminOnly(), async (ctx) => {
    const ga = await AccountGiveaway.findById(ctx.match[1]);
    if (!ga) return ctx.answerCbQuery('❌ Giveaway မရှိသေးပါ', { show_alert: true });
    ga.requirePurchase = !ga.requirePurchase;
    await ga.save();
    await ctx.answerCbQuery(ga.requirePurchase ? '🛒 ဝယ်ဖူးမှ ရမယ် — ON' : '🛒 OFF');
    const detail = await buildGaDetail(ga._id);
    await editOrReply(ctx, detail.text, detail.keyboard);
  });

  // ── Text-input settings (reply-targeted wizard) ────────────────────────────

  async function promptGaValue(ctx, gaId, field, promptText) {
    ctx.session.accAdmin = null; // isolate from the accounts.js admin wizard
    const prompt = await ctx.reply(promptText, { parse_mode: 'Markdown', ...Markup.forceReply() });
    ctx.session.accGaWiz = { gaId, field, promptId: prompt.message_id };
  }

  bot.action(/^accga_max:([a-f0-9]{24})$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await promptGaValue(ctx, ctx.match[1], 'max',
      `📦 *ဘယ်နှစ်ယောက် ရနိုင်မလဲ?*\n\nကိန်းဂဏန်း ရိုက်ပါ (ဥပမာ \`50\`)\n\`0\` = မကန့်သတ် (stock ကုန်သည်အထိ)`);
  });

  bot.action(/^accga_days:([a-f0-9]{24})$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await promptGaValue(ctx, ctx.match[1], 'days',
      `⏰ *ဘယ်နှစ်ရက်ကြာ ဖွင့်ထားမလဲ?*\n\nဒီနေ့ကစပြီး ရက်အရေအတွက် ရိုက်ပါ (ဥပမာ \`7\`)\n\`0\` = အချိန် မကန့်သတ်`);
  });

  bot.action(/^accga_age:([a-f0-9]{24})$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await promptGaValue(ctx, ctx.match[1], 'age',
      `📅 *Telegram account သက်တမ်း အနည်းဆုံး ဘယ်နှစ်ရက်လဲ?*\n\n(account အသစ်စက်စက်တွေ မရအောင် — ဥပမာ \`30\`)\n\`0\` = မစစ်`);
  });

  bot.on('text', async (ctx, next) => {
    const wiz = ctx.session?.accGaWiz;
    if (!wiz) return next();
    if (!(await isAnyAdmin(ctx.from?.id))) return next();
    if (ctx.message.reply_to_message?.message_id !== wiz.promptId) {
      ctx.session.accGaWiz = null;
      return next();
    }

    const n = parseInt(ctx.message.text.trim().replace(/[^\d]/g, ''), 10);
    if (isNaN(n) || n < 0) {
      const prompt = await ctx.reply('❌ ကိန်းဂဏန်းပဲ ရိုက်ပါ (0 = ပိတ်):', Markup.forceReply());
      ctx.session.accGaWiz = { ...wiz, promptId: prompt.message_id };
      return;
    }

    ctx.session.accGaWiz = null;
    const ga = await AccountGiveaway.findById(wiz.gaId);
    if (!ga) return ctx.reply('❌ Giveaway မရှိတော့ပါ။');

    if (wiz.field === 'max') {
      if (n > 0 && n <= ga.claimedCount) {
        return ctx.reply(`❌ အခု ${ga.claimedCount} ယောက် ရယူပြီးသားပါ။ Max Claims ကို *${ga.claimedCount + 1}* နဲ့အထက် သတ်မှတ်ပါ၊ ဒါမှမဟုတ် ` + '`0`' + ` နဲ့ unlimited ထားပါ။`, { parse_mode: 'Markdown' });
      }
      ga.maxClaims = n;
    } else if (wiz.field === 'days') {
      ga.endAt = n > 0 ? new Date(Date.now() + n * DAY_MS) : null;
    } else if (wiz.field === 'age') {
      ga.minAccountAgeDays = n;
    }
    await ga.save();
    await auditLog(ctx.from.id, 'SET_GIVEAWAY_RESTRICTION', ga._id.toString(), 'System', { field: wiz.field, value: n });

    const detail = await buildGaDetail(ga._id);
    return ctx.reply(detail.text, { parse_mode: 'Markdown', ...detail.keyboard });
  });

  // ── Multi-channel join requirement ──────────────────────────────────────────

  async function showChannelPicker(ctx, gaId) {
    const ga = await AccountGiveaway.findById(gaId);
    if (!ga) return editOrReply(ctx, '❌ Giveaway မတွေ့ပါ');
    const selected = requiredChannelsOf(ga);
    const selectedIds = new Set(selected.map((c) => String(c.chatId)));
    const channels = await getKnownChannels();
    const rows = channels.slice(0, 30).map((c) => {
      const on = selectedIds.has(String(c.chatId));
      return [styledButton(
        Markup.button.callback(`${on ? '✅' : '➕'} ${c.title || c.chatId}`, `gct:${gaId}:${c.chatId}`),
        on ? 'success' : 'primary'
      )];
    });
    if (selected.length) rows.push([styledButton(Markup.button.callback('🚫 Channel requirements အားလုံးဖြုတ်မယ်', `accga_chanoff:${gaId}`), 'danger')]);
    rows.push([Markup.button.callback('🔙 Giveaway Panel', `accga_view:${gaId}`)]);
    return editOrReply(
      ctx,
      `📣 *Required Channels*

User က အောက်ကရွေးထားတဲ့ channel *အားလုံး* join ထားမှ Giveaway ရယူနိုင်ပါမယ်။

ရွေးထားပြီး: *${selected.length} ခု*${selected.length ? `
${selected.map((c) => `✅ ${esc(c.title)}`).join('\n')}` : ''}

_(Channel အသစ်ထည့်ချင်ရင် /channels မှာ အရင်ထည့်ပါ။ Member status စစ်ဖို့ bot က channel ကို access ရပါမယ်။)_`,
      Markup.inlineKeyboard(rows)
    );
  }

  bot.action(/^accga_chan:([a-f0-9]{24})$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    return showChannelPicker(ctx, ctx.match[1]);
  });

  bot.action(/^gct:([a-f0-9]{24}):(-?\d+)$/, adminOnly(), async (ctx) => {
    const gaId = ctx.match[1];
    const chatId = Number(ctx.match[2]);
    const ga = await AccountGiveaway.findById(gaId);
    if (!ga) return ctx.answerCbQuery('❌ Giveaway မရှိသေးပါ', { show_alert: true });
    let channels = requiredChannelsOf(ga);
    const exists = channels.some((c) => String(c.chatId) === String(chatId));
    if (exists) {
      channels = channels.filter((c) => String(c.chatId) !== String(chatId));
      await ctx.answerCbQuery('➖ Channel ဖြုတ်ပြီး');
    } else {
      let title = String(chatId);
      try {
        const chat = await ctx.telegram.getChat(chatId);
        title = chat.title || chat.username || title;
      } catch {
        return ctx.answerCbQuery('❌ Channel ကို bot က မမြင်ရပါ — bot access/admin permission စစ်ပါ', { show_alert: true });
      }
      channels.push({ chatId, title });
      await ctx.answerCbQuery('✅ Required channel ထည့်ပြီး');
    }
    ga.requireChannels = channels;
    ga.requireChannelId = null;
    ga.requireChannelTitle = '';
    await ga.save();
    await auditLog(ctx.from.id, 'SET_GIVEAWAY_CHANNELS', ga._id.toString(), 'System', { channels });
    return showChannelPicker(ctx, gaId);
  });

  bot.action(/^accga_chanoff:([a-f0-9]{24})$/, adminOnly(), async (ctx) => {
    const ga = await AccountGiveaway.findById(ctx.match[1]);
    if (!ga) return ctx.answerCbQuery('❌ Giveaway မရှိသေးပါ', { show_alert: true });
    ga.requireChannels = [];
    ga.requireChannelId = null;
    ga.requireChannelTitle = '';
    await ga.save();
    await ctx.answerCbQuery('🚫 Channel requirements အားလုံးဖြုတ်ပြီး');
    return showChannelPicker(ctx, ga._id.toString());
  });

  bot.action('accga_joined_ok', async (ctx) => {
    await ctx.answerCbQuery('✅ ဒီ channel ကို join ပြီးသားပါ');
  });

  // ── Delete ──────────────────────────────────────────────────────────────────

  bot.action(/^accga_del:([a-f0-9]{24})$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const gaId = ctx.match[1];
    await ctx.reply(
      `🗑 *Giveaway ကို ဖျက်မှာ သေချာလား?*\n\n_ရယူပြီးသား user တွေရဲ့ account တွေကတော့ သူတို့ဆီမှာ ဆက်ရှိနေပါမယ်။_`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ ဖျက်မယ်', `accga_delyes:${gaId}`)],
          [Markup.button.callback('❌ မဖျက်တော့ဘူး', `accga_view:${gaId}`)],
        ]),
      }
    );
  });

  bot.action(/^accga_delyes:([a-f0-9]{24})$/, adminOnly(), async (ctx) => {
    const ga = await AccountGiveaway.findById(ctx.match[1]);
    if (!ga) return ctx.answerCbQuery('❌ မရှိတော့ပါ', { show_alert: true });
    await clearGiveawayClaims(ga);
    await AccountGiveaway.deleteOne({ _id: ga._id });
    await auditLog(ctx.from.id, 'DELETE_GIVEAWAY', ga._id.toString(), 'System', {});
    await ctx.answerCbQuery('🗑 ဖျက်ပြီးပါပြီ');
    const { text, keyboard } = await buildAdminList();
    await editOrReply(ctx, text, keyboard);
  });

  // ── Announce to all users + announcement channel ────────────────────────────

  bot.action(/^accga_announce:([a-f0-9]{24})$/, adminOnly(), async (ctx) => {
    const ga = await AccountGiveaway.findById(ctx.match[1]).populate('productId').populate('shopProductId');
    const meta = gaMeta(ga);
    if (!ga || !ga.isActive || !meta) return ctx.answerCbQuery('❌ ဖွင့်ထားတဲ့ giveaway မရှိပါ', { show_alert: true });
    await ctx.answerCbQuery();

    const progress = await ctx.reply('📤 ကြေညာနေပါတယ်…');

    const body =
      `🎁 *${meta.kind === 'shop' ? 'အခမဲ့ လက်ဆောင် ရယူလိုက်ပါ!' : 'အခမဲ့ Premium Account ရယူလိုက်ပါ!'}*\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
      `${meta.emoji} *${esc(meta.title)}*${meta.sub ? ` — ${esc(meta.sub)}` : ''}\n` +
      `💵 တန်ဖိုး ~${Number(meta.price).toLocaleString()} KS~ → *လုံးဝ အခမဲ့!*\n` +
      (ga.maxClaims > 0 ? `📦 *${ga.maxClaims} ယောက်ပဲ* ရမှာမို့ မြန်မြန်လာယူပါ!\n` : '') +
      (ga.endAt ? `⏰ ${fmtDate(ga.endAt)} နောက်ဆုံး!\n` : '');

    // Post to the channel first. A slow user broadcast must not make the admin
    // screen appear stuck at “ကြော်ငြာနေပါတယ်…”.
    let channelOk = false;
    try {
      const ss = await SystemStatus.get();
      if (ss.announcementChannelId) {
        const me = ctx.botInfo?.username || (await ctx.telegram.getMe()).username;
        const announcement = await telegramWithTimeout(ctx.telegram.sendMessage(
          ss.announcementChannelId,
          body + `\n👇 Bot ထဲဝင်ပြီး ရယူလိုက်ပါ:`,
          {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.url('🤖 Bot ဖွင့်မယ်', `https://t.me/${me}?start=freebie`)]]),
          }
        ));
        await AccountGiveaway.updateOne(
          { _id: ga._id },
          {
            $set: {
              announcementChannelId: String(ss.announcementChannelId),
              announcementMessageId: announcement.message_id,
              announcementBody: body + `\n👇 Bot ထဲဝင်ပြီး ရယူလိုက်ပါ:`,
              announcementButtonUrl: `https://t.me/${me}?start=freebie`,
              deleteAt: null,
            },
          }
        );
        channelOk = true;
      }
    } catch (e) {
      console.error('[Giveaway] channel announce failed:', e.message);
    }

    // Notify bot users after the channel post. BroadcastService bounds each
    // Telegram request and reports progress, so a stalled chat cannot stall
    // this admin action forever.
    let sent = 0;
    let failed = 0;
    try {
      const result = await broadcastToUsers(ctx.telegram, body, {
        ...Markup.inlineKeyboard([[Markup.button.callback('🎁 အခမဲ့ ရယူမယ်', `accga_free:${ga._id}`)]]),
      }, {
        onProgress: async ({ sent: currentSent, failed: currentFailed, processed }) => {
          sent = currentSent;
          failed = currentFailed;
          if (processed % 25 === 0) {
            try {
              await ctx.telegram.editMessageText(
                progress.chat.id, progress.message_id, undefined,
                `📤 *ကြော်ငြာနေပါတယ်…*\n\n👥 စစ်ပြီး: ${processed} ယောက်\n✅ ရောက်: ${currentSent} ယောက်`,
                { parse_mode: 'Markdown' }
              );
            } catch {}
          }
        },
      });
      sent = result.sent;
      failed = result.failed + result.blocked;
    } catch (e) {
      console.error('[Giveaway] user broadcast failed:', e.message);
      failed += 1;
    }

    await auditLog(ctx.from.id, 'ANNOUNCE_GIVEAWAY', ga._id.toString(), 'System', { sent, failed, channelOk });
    try {
      await ctx.telegram.editMessageText(
        progress.chat.id, progress.message_id, undefined,
        `✅ *ကြေညာပြီးပါပြီ!*\n\n👥 User: ${sent} ယောက် ရောက် / ${failed} မအောင်မြင်\n📢 Channel: ${channelOk ? '✅ တင်ပြီး' : '— (announcement channel မသတ်မှတ်ရသေး)'}`,
        { parse_mode: 'Markdown' }
      );
    } catch {}
  });
};
