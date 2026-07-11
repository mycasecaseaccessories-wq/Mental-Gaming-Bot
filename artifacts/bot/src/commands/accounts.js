/**
 * Premium Accounts system — sell account credentials (e.g. ExpressVPN) with
 * instant delivery, per-account expiry, and admin stock/discount management.
 * Fully separate from the game top-up Product system.
 */
const { Markup } = require('telegraf');
const { adminOnly } = require('../middlewares/adminCheck');
const { debitKS, creditKS } = require('../services/WalletService');
const { auditLog } = require('../services/logger');
const AccountProduct = require('../models/AccountProduct');
const AccountCredential = require('../models/AccountCredential');
const AccountSlot = require('../models/AccountSlot');
const AccountGiveaway = require('../models/AccountGiveaway');
const User = require('../models/User');
const { config } = require('../../config/settings');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_QTY_BUTTONS = 8; // cap the per-purchase quantity picker

function isMulti(p) {
  return p.accountType === 'shared' || p.accountType === 'invite';
}
// Word for one sellable slot, by account type
function unitWord(p) {
  if (p.accountType === 'shared') return 'device';
  if (p.accountType === 'invite') return 'member';
  return 'account';
}
// Free sellable units: accounts for single, slots for shared/invite
async function freeUnits(p) {
  return isMulti(p)
    ? AccountCredential.countAvailableSlots(p._id)
    : AccountCredential.countAvailable(p._id);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/([_*`\[])/g, '\\$1');
}
function cleanCred(s) {
  return String(s || '').replace(/`/g, '').trim();
}
function ks(n) {
  return `${Number(n || 0).toLocaleString()} KS`;
}
function remainingDays(expiresAt) {
  return Math.ceil((new Date(expiresAt).getTime() - Date.now()) / DAY_MS);
}
function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-GB', { timeZone: 'Asia/Rangoon' });
}

// ── User: "my accounts" (merges single credentials + multi slots) ────────────
async function buildMyAccounts(telegramId) {
  const [creds, slots] = await Promise.all([
    AccountCredential.find({ buyerTelegramId: telegramId, status: 'sold' })
      .sort({ soldAt: -1 })
      .limit(20),
    AccountSlot.find({ buyerTelegramId: telegramId }).sort({ soldAt: -1 }).limit(20),
  ]);

  const items = [
    ...creds.map((c) => ({
      soldAt: c.soldAt,
      expiresAt: c.expiresAt,
      service: c.serviceNameSnap || 'Account',
      plan: c.planLabelSnap || '',
      credType: 'login',
      loginId: c.loginId,
      password: c.password,
      link: c.link,
      qty: 0,
      word: '',
    })),
    ...slots.map((s) => ({
      soldAt: s.soldAt,
      expiresAt: s.expiresAt,
      service: s.serviceNameSnap || 'Account',
      plan: s.planLabelSnap || '',
      credType: s.credTypeSnap,
      loginId: s.loginIdSnap,
      password: s.passwordSnap,
      link: s.linkSnap,
      qty: s.slots,
      word: s.credTypeSnap === 'link' ? 'member' : 'device',
    })),
  ].sort((a, b) => new Date(b.soldAt) - new Date(a.soldAt));

  if (!items.length) {
    return {
      text: `🎟 *ကျွန်ုပ်၏ Accounts*\n\n_ဝယ်ထားတဲ့ account မရှိသေးပါ။_`,
      keyboard: Markup.inlineKeyboard([[Markup.button.callback('🔐 Account ဝယ်မယ်', 'acc_hub')]]),
    };
  }

  const lines = items.map((it) => {
    const days = remainingDays(it.expiresAt);
    const state = days > 0 ? `🟢 *${days} ရက်* ကျန်` : `🔴 သက်တမ်းကုန်ပြီ`;
    const qtyTag = it.qty > 0 ? ` ×${it.qty} ${it.word}` : '';
    const credLine = it.credType === 'link'
      ? `   🔗 \`${cleanCred(it.link)}\``
      : `   📧 \`${cleanCred(it.loginId)}\`  🔑 \`${cleanCred(it.password)}\``;
    return (
      `${state} — *${esc(it.service)}* (${esc(it.plan)})${qtyTag}\n` +
      `${credLine}\n` +
      `   📅 ${fmtDate(it.soldAt)} → ${fmtDate(it.expiresAt)}`
    );
  });

  return {
    text: `🎟 *ကျွန်ုပ်၏ Accounts (${items.length})*\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n${lines.join('\n\n')}`,
    keyboard: Markup.inlineKeyboard([[Markup.button.callback('🔐 နောက်ထပ်ဝယ်မယ်', 'acc_hub')]]),
  };
}

// ── User: hub ────────────────────────────────────────────────────────────────

async function buildHub() {
  const products = await AccountProduct.getActive();
  const counts = await Promise.all(products.map((p) => freeUnits(p)));
  const giveaway = await AccountGiveaway.getActive().catch(() => null);

  let text = `🔐 *Premium Accounts*\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n`;
  if (giveaway?.productId) {
    text += `🎁 *အခမဲ့ Giveaway ဖွင့်ထားပါတယ်!* — ${giveaway.productId.emoji} ${esc(giveaway.productId.serviceName)} ကို အခမဲ့ ရယူနိုင်ပါပြီ 👇\n\n`;
  }
  if (!products.length) {
    text += `_လက်ရှိ ရောင်းချနေတဲ့ account မရှိသေးပါ။ နောက်မှ ပြန်ကြည့်ပေးပါ။_`;
  } else {
    text += `ဝယ်ပြီးတာနဲ့ account (login + password) *ချက်ချင်း* ရပါမယ်။\n\n`;
    text += products
      .map((p, i) => {
        const stock = counts[i];
        const fp = p.finalPrice();
        const priceStr = p.discountPercent > 0
          ? `~${p.price.toLocaleString()}~ *${ks(fp)}* (-${p.discountPercent}%)`
          : `*${ks(fp)}*`;
        return (
          `${p.emoji} *${esc(p.serviceName)}* — ${esc(p.planLabel)}\n` +
          `   💵 ${priceStr}  •  ⏳ ${p.durationDays} ရက်  •  📦 လက်ကျန် ${stock}`
        );
      })
      .join('\n\n');
  }

  const rows = [];
  if (giveaway?.productId) {
    rows.push([Markup.button.callback('🎁 အခမဲ့ ရယူမယ် — FREE!', 'accga_free')]);
  }
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    rows.push([
      Markup.button.callback(
        `${p.emoji} ${p.serviceName} — ${p.planLabel}${counts[i] === 0 ? ' (ကုန်)' : ''}`,
        `acc_view:${p._id}`
      ),
    ]);
  }
  rows.push([Markup.button.callback('🎟 ကျွန်ုပ်၏ Accounts', 'acc_mine')]);

  return { text, keyboard: Markup.inlineKeyboard(rows) };
}

async function showHub(ctx) {
  const { text, keyboard } = await buildHub();
  await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
}

// ── Admin: panel ─────────────────────────────────────────────────────────────

async function buildAdminPanel() {
  const products = await AccountProduct.find().sort({ displayOrder: 1, serviceName: 1 });
  const stats = await Promise.all(
    products.map(async (p) => ({
      avail: await AccountCredential.countAvailable(p._id),
      sold: await AccountCredential.countDocuments({ productId: p._id, status: 'sold' }),
    }))
  );

  let text =
    `🔐 *Premium Accounts — Admin*\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
    (products.length
      ? products
          .map((p, i) => {
            const s = stats[i];
            const disc = p.discountPercent > 0 ? `  🏷 -${p.discountPercent}%` : '';
            return (
              `${p.isActive ? '🟢' : '🔴'} ${p.emoji} *${esc(p.serviceName)}* — ${esc(p.planLabel)}\n` +
              `   💵 ${ks(p.finalPrice())}${disc}  •  ⏳ ${p.durationDays} ရက်  •  📦 ${s.avail} ကျန် / ${s.sold} ရောင်းပြီး`
            );
          })
          .join('\n\n')
      : `_Account product မရှိသေးပါ။ ➕ Add Product နှိပ်ပြီး စတင်ပါ။_`);

  const rows = products.map((p) => [
    Markup.button.callback(`${p.isActive ? '🟢' : '🔴'} ${p.serviceName} — ${p.planLabel}`, `accad_view:${p._id}`),
  ]);
  rows.push([Markup.button.callback('➕ Add Product', 'accad_add')]);
  rows.push([Markup.button.callback('🎁 Free Giveaway', 'accga_admin')]);
  rows.push([Markup.button.callback('🔄 Refresh', 'accad_panel'), Markup.button.callback('🔙 Back', 'nav:go:admin_main')]);

  return { text, keyboard: Markup.inlineKeyboard(rows) };
}

async function buildAdminProductView(p) {
  const [avail, sold] = await Promise.all([
    freeUnits(p),
    isMulti(p)
      ? AccountSlot.countDocuments({ productId: p._id })
      : AccountCredential.countDocuments({ productId: p._id, status: 'sold' }),
  ]);
  const unit = p.accountType === 'shared' ? 'device' : p.accountType === 'invite' ? 'member' : '';
  const priceLine = isMulti(p)
    ? `💵 စျေး: *${ks(p.price)}* / ${unit}${p.discountPercent > 0 ? `  →  🏷 *${ks(p.finalPrice())}* (-${p.discountPercent}%)` : ''}`
    : `💵 စျေး: *${ks(p.price)}*${p.discountPercent > 0 ? `  →  🏷 *${ks(p.finalPrice())}* (-${p.discountPercent}%)` : ''}`;
  const credCount = isMulti(p) ? await AccountCredential.countDocuments({ productId: p._id }) : 0;
  const text =
    `${p.emoji} *${esc(p.serviceName)}* — ${esc(p.planLabel)}\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
    `📂 အမျိုးအစား: *${TYPE_BADGE[p.accountType]}*` +
    (isMulti(p) ? ` — ${p.accountType === 'shared' ? 'account' : 'link'} တစ်ခုကို ${p.slotsPerUnit} ${unit}\n` : `\n`) +
    `${p.isActive ? '🟢 ရောင်းနေသည် (ဝယ်သူမြင်ရ)' : '🔴 ပိတ်ထား (ဝယ်သူမမြင်ရ)'}\n` +
    `${priceLine}\n` +
    `⏳ သက်တမ်း: *${p.durationDays} ရက်* (ဝယ်ချိန်မှ စတွက်)\n` +
    (isMulti(p)
      ? `📦 လက်ကျန်: *${avail} ${unit}* ကျန် / ${sold} ${unit} ရောင်းပြီး` +
        `  (${p.accountType === 'shared' ? 'account' : 'link'} ${credCount} ခု)\n`
      : `📦 Stock: *${avail} ကျန်* / ${sold} ရောင်းပြီး\n`) +
    (p.description ? `📝 ${esc(p.description)}\n` : '');
  const stockLabel = p.accountType === 'shared' ? '📥 Account ထည့်'
    : p.accountType === 'invite' ? '📥 Link ထည့်' : '📥 Stock ထည့်';
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(p.isActive ? '🔴 ပိတ်မယ်' : '🟢 ဖွင့်မယ်', `accad_toggle:${p._id}`)],
    [
      Markup.button.callback(stockLabel, `accad_stock:${p._id}`),
      Markup.button.callback('🏷 Discount', `accad_disc:${p._id}`),
    ],
    [
      Markup.button.callback('💵 စျေးပြင်', `accad_price:${p._id}`),
      Markup.button.callback('🗑 ဖျက်', `accad_del:${p._id}`),
    ],
    [Markup.button.callback('🔙 Accounts Panel', 'accad_panel')],
  ]);
  return { text, keyboard };
}

async function editOrReply(ctx, text, keyboard) {
  try {
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
  } catch (e) {
    if (String(e?.description || e?.message || '').includes('message is not modified')) return;
    await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  }
}

// ── Module ───────────────────────────────────────────────────────────────────

module.exports = function registerAccounts(bot) {
  // ══ USER SIDE ══════════════════════════════════════════════════════════════

  bot.hears(['🔐 Premium Accounts', '🔐 အကောင့်များ'], showHub);
  bot.command('accounts', showHub);

  bot.action('acc_hub', async (ctx) => {
    await ctx.answerCbQuery();
    const { text, keyboard } = await buildHub();
    await editOrReply(ctx, text, keyboard);
  });

  bot.action(/^acc_view:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const p = await AccountProduct.findById(ctx.match[1]);
    if (!p || !p.isActive) return ctx.reply('❌ ဒီ account ကို လက်ရှိ မရောင်းတော့ပါ။');
    const stock = await freeUnits(p);
    const fp = p.finalPrice();
    const priceStr = p.discountPercent > 0
      ? `~${p.price.toLocaleString()} KS~  →  *${ks(fp)}*  🏷 _-${p.discountPercent}% လျှော့စျေး!_`
      : `*${ks(fp)}*`;
    const perUnit = p.accountType === 'shared' ? ' / device'
      : p.accountType === 'invite' ? ' / member' : '';
    const stockLine = p.accountType === 'shared'
      ? `📦 လက်ကျန်: *device ${stock} ခုစာ*`
      : p.accountType === 'invite'
        ? `📦 လက်ကျန်: *member ${stock} ယောက်စာ*`
        : `📦 လက်ကျန်: *${stock}*`;
    const deliverNote = p.accountType === 'invite'
      ? `\n_ဝယ်ပြီးတာနဲ့ invite link ချက်ချင်း ရပါမယ်။_`
      : `\n_ဝယ်ပြီးတာနဲ့ login + password ချက်ချင်း ရပါမယ်။_`;
    const typeNote = p.accountType === 'shared'
      ? `\n_📱 Account တစ်ခုကို device ${p.slotsPerUnit} ခုအထိ သုံးလို့ရ — ဝယ်လိုတဲ့ device အရေအတွက် ရွေးပါ။_`
      : p.accountType === 'invite'
        ? `\n_🔗 Link တစ်ခုကို member ${p.slotsPerUnit} ယောက်အထိ ဝင်လို့ရ — ဝယ်လိုတဲ့ အရေအတွက် ရွေးပါ။_`
        : '';
    const text =
      `${p.emoji} *${esc(p.serviceName)}*\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
      `📦 Plan: *${esc(p.planLabel)}*\n` +
      `💵 စျေးနှုန်း: ${priceStr}${perUnit}\n` +
      `⏳ သက်တမ်း: *${p.durationDays} ရက်* (ဝယ်ချိန်မှ စတွက်)\n` +
      `${stockLine}\n` +
      (p.description ? `\n📝 ${esc(p.description)}\n` : '') +
      typeNote + deliverNote;
    const buyAction = isMulti(p) ? `acc_qty:${p._id}` : `acc_buy:${p._id}`;
    const buyLabel = isMulti(p) ? '🛒 ဝယ်မယ်' : `🛒 ဝယ်မယ် — ${ks(fp)}`;
    const keyboard = Markup.inlineKeyboard([
      [
        stock > 0
          ? Markup.button.callback(buyLabel, buyAction)
          : Markup.button.callback('❌ Stock ကုန်နေပါသည်', 'acc_hub'),
      ],
      [Markup.button.callback('🔙 Back', 'acc_hub')],
    ]);
    await editOrReply(ctx, text, keyboard);
  });

  // ── Multi-slot: quantity picker (shared/invite) ─────────────────────────────
  bot.action(/^acc_qty:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const p = await AccountProduct.findById(ctx.match[1]);
    if (!p || !p.isActive || !isMulti(p)) return ctx.reply('❌ ဒီ account ကို လက်ရှိ မရောင်းတော့ပါ။');
    // Max a single buyer can take = biggest free block inside ONE credential
    // (a buyer always gets ONE account/link), capped for the UI.
    const maxOne = await AccountCredential.maxFreeInOne(p._id);
    const maxN = Math.min(maxOne, MAX_QTY_BUTTONS, p.slotsPerUnit);
    if (maxN <= 0) {
      return editOrReply(ctx, '❌ Stock ကုန်နေပါသည်။',
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', `acc_view:${p._id}`)]]));
    }
    const fp = p.finalPrice();
    const word = p.accountType === 'shared' ? 'device' : 'member';
    const rows = [];
    let row = [];
    for (let n = 1; n <= maxN; n++) {
      row.push(Markup.button.callback(`${n} ${word} — ${ks(fp * n)}`, `acc_buyq:${p._id}:${n}`));
      if (row.length === 2) { rows.push(row); row = []; }
    }
    if (row.length) rows.push(row);
    rows.push([Markup.button.callback('🔙 Back', `acc_view:${p._id}`)]);
    await editOrReply(
      ctx,
      `${p.emoji} *${esc(p.serviceName)}* — ${esc(p.planLabel)}\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
      `ဘယ်နှစ် ${word} ဝယ်မလဲ ရွေးပါ 👇\n` +
      `_(${word} တစ်ခုစီ ${ks(fp)})_`,
      Markup.inlineKeyboard(rows)
    );
  });

  // ── Multi-slot: confirm with total (shared/invite) ──────────────────────────
  bot.action(/^acc_buyq:([^:]+):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const p = await AccountProduct.findById(ctx.match[1]);
    if (!p || !p.isActive || !isMulti(p)) return ctx.reply('❌ ဒီ account ကို လက်ရှိ မရောင်းတော့ပါ။');
    const qty = Math.max(1, parseInt(ctx.match[2], 10) || 1);
    const user = await User.findByTelegramId(ctx.from.id);
    if (!user) return ctx.reply('❌ /start နှိပ်ပြီး အရင် စာရင်းသွင်းပေးပါ။');
    const fp = p.finalPrice();
    const total = fp * qty;
    const bal = user.balanceKS || 0;
    const word = p.accountType === 'shared' ? 'device' : 'member';
    const text =
      `🧾 *အတည်ပြုရန်*\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
      `${p.emoji} ${esc(p.serviceName)} — ${esc(p.planLabel)}\n` +
      `🔢 အရေအတွက်: *${qty} ${word}*  (${ks(fp)} × ${qty})\n` +
      `💵 ကျသင့်ငွေ: *${ks(total)}*\n` +
      `💰 လက်ကျန်: *${ks(bal)}*\n` +
      `⏳ သက်တမ်း: ${p.durationDays} ရက်\n\n` +
      (bal >= total
        ? `_အတည်ပြုရင် wallet ကနေ ဖြတ်ပြီး ${p.accountType === 'invite' ? 'invite link' : 'account'} ချက်ချင်း ရပါမယ်။_`
        : `❌ _လက်ကျန်ငွေ မလုံလောက်ပါ။ /topup နဲ့ အရင်ဖြည့်ပေးပါ။_`);
    const rows = [];
    if (bal >= total) rows.push([Markup.button.callback('✅ အတည်ပြု ဝယ်မယ်', `acc_confirmq:${p._id}:${qty}`)]);
    rows.push([Markup.button.callback('🔙 Back', `acc_qty:${p._id}`)]);
    await editOrReply(ctx, text, Markup.inlineKeyboard(rows));
  });

  bot.action(/^acc_buy:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const p = await AccountProduct.findById(ctx.match[1]);
    if (!p || !p.isActive) return ctx.reply('❌ ဒီ account ကို လက်ရှိ မရောင်းတော့ပါ။');
    const user = await User.findByTelegramId(ctx.from.id);
    if (!user) return ctx.reply('❌ /start နှိပ်ပြီး အရင် စာရင်းသွင်းပေးပါ။');
    const fp = p.finalPrice();
    const bal = user.balanceKS || 0;
    const text =
      `🧾 *အတည်ပြုရန်*\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
      `${p.emoji} ${esc(p.serviceName)} — ${esc(p.planLabel)}\n` +
      `💵 ကျသင့်ငွေ: *${ks(fp)}*\n` +
      `💰 လက်ကျန်: *${ks(bal)}*\n` +
      `⏳ သက်တမ်း: ${p.durationDays} ရက်\n\n` +
      (bal >= fp
        ? `_အတည်ပြုရင် wallet ကနေ ဖြတ်ပြီး account ချက်ချင်း ရပါမယ်။_`
        : `❌ _လက်ကျန်ငွေ မလုံလောက်ပါ။ /topup နဲ့ အရင်ဖြည့်ပေးပါ။_`);
    const rows = [];
    if (bal >= fp) rows.push([Markup.button.callback('✅ အတည်ပြု ဝယ်မယ်', `acc_confirm:${p._id}`)]);
    rows.push([Markup.button.callback('❌ မဝယ်တော့ပါ', 'acc_hub')]);
    await editOrReply(ctx, text, Markup.inlineKeyboard(rows));
  });

  bot.action(/^acc_confirm:(.+)$/, async (ctx) => {
    const p = await AccountProduct.findById(ctx.match[1]);
    if (!p || !p.isActive) return ctx.answerCbQuery('❌ မရောင်းတော့ပါ', { show_alert: true });
    if (isMulti(p)) return ctx.answerCbQuery(); // multi handled by acc_confirmq
    const user = await User.findByTelegramId(ctx.from.id);
    if (!user) return ctx.answerCbQuery('❌ /start အရင်နှိပ်ပါ', { show_alert: true });

    const fp = p.finalPrice();

    // 1. Debit wallet first (throws if insufficient)
    let tx;
    try {
      tx = await debitKS(user._id, fp, {
        type: 'Purchase',
        note: `Premium Account: ${p.serviceName} — ${p.planLabel}`,
      });
    } catch (e) {
      return ctx.answerCbQuery('❌ လက်ကျန်ငွေ မလုံလောက်ပါ', { show_alert: true });
    }

    // Helper: compensating refund if anything fails after the debit
    const refund = async (reason) => {
      try {
        await creditKS(user._id, fp, { type: 'Refund', note: `Refund — ${p.serviceName}: ${reason}` });
        return true;
      } catch (err) {
        console.error('[Accounts] ❌ REFUND FAILED:', err.message);
        try {
          await ctx.telegram.sendMessage(
            config.bot.adminId,
            `🚨 Premium Account REFUND FAILED!\nUser: ${ctx.from.id}\nAmount: ${fp} KS\nReason: ${reason}\nError: ${err.message}\n→ လက်ဖြင့် ပြန်အမ်းပေးပါ။`
          );
        } catch {}
        return false;
      }
    };

    // 2. Claim a credential atomically (refund on any failure)
    let cred;
    try {
      const now = new Date();
      cred = await AccountCredential.claimOne(p._id, {
        buyerUserId: user._id,
        buyerTelegramId: ctx.from.id,
        soldAt: now,
        expiresAt: new Date(now.getTime() + p.durationDays * DAY_MS),
        pricePaid: fp,
        serviceNameSnap: p.serviceName,
        planLabelSnap: p.planLabel,
        durationDaysSnap: p.durationDays,
      });
    } catch (err) {
      console.error('[Accounts] ❌ claimOne failed:', err.message);
      await refund(`claim error: ${err.message}`);
      await ctx.answerCbQuery();
      return ctx.reply('❌ တစ်ခုခု မှားသွားလို့ ငွေ ပြန်အမ်းပြီးပါပြီ။ ခဏနေ ပြန်ကြိုးစားပေးပါ။');
    }

    // 3. Out of stock → refund
    if (!cred) {
      await refund('out of stock');
      await ctx.answerCbQuery();
      return ctx.reply('❌ Stock ကုန်သွားလို့ ငွေ အပြည့် ပြန်အမ်းပြီးပါပြီ။');
    }

    await ctx.answerCbQuery('✅ ဝယ်ယူမှု အောင်မြင်ပါသည်!');
    await auditLog(ctx.from.id, 'BUY_ACCOUNT', cred._id.toString(), 'System', {
      product: `${p.serviceName} ${p.planLabel}`, price: fp,
    });

    // 4. Deliver credentials (plain-text fallback if Markdown send fails —
    //    credential is already assigned, so never refund here)
    try {
    await ctx.reply(
      `✅ *ဝယ်ယူမှု အောင်မြင်ပါသည်!*\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
        `${p.emoji} *${esc(p.serviceName)}* — ${esc(p.planLabel)}\n\n` +
        `📧 Login: \`${cleanCred(cred.loginId)}\`\n` +
        `🔑 Password: \`${cleanCred(cred.password)}\`\n` +
        (cred.note ? `📝 ${esc(cred.note)}\n` : '') +
        `\n📅 ဝယ်သည့်နေ့: ${fmtDate(cred.soldAt)}\n` +
        `⏳ သက်တမ်းကုန်: *${fmtDate(cred.expiresAt)}* (${p.durationDays} ရက်)\n` +
        `💵 ကျသင့်ငွေ: ${ks(fp)}\n\n` +
        `_👆 Login/Password ကို နှိပ်ရင် copy ဖြစ်ပါမယ်။_\n` +
        `_🎟 ကျွန်ုပ်၏ Accounts မှာ သက်တမ်း အမြဲ ပြန်စစ်နိုင်ပါတယ်။_`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('🎟 ကျွန်ုပ်၏ Accounts', 'acc_mine')]]),
      }
    );
    } catch (err) {
      console.error('[Accounts] ⚠️ Markdown delivery failed, plain fallback:', err.message);
      try {
        await ctx.reply(
          `✅ ဝယ်ယူမှု အောင်မြင်ပါသည်!\n\n${p.serviceName} — ${p.planLabel}\n\n` +
            `Login: ${cred.loginId}\nPassword: ${cred.password}\n` +
            (cred.note ? `Note: ${cred.note}\n` : '') +
            `\nသက်တမ်းကုန်: ${fmtDate(cred.expiresAt)} (${p.durationDays} ရက်)\n` +
            `ကျသင့်ငွေ: ${ks(fp)}\n\n/myaccounts နဲ့ အမြဲ ပြန်ကြည့်နိုင်ပါတယ်။`
        );
      } catch (err2) {
        console.error('[Accounts] ❌ Delivery failed completely:', err2.message);
        try {
          await ctx.telegram.sendMessage(
            config.bot.adminId,
            `🚨 Account delivery message FAILED!\nUser: ${ctx.from.id}\nCred: ${cred._id}\n→ ဝယ်သူက /myaccounts နဲ့ ကြည့်လို့ရပါသေးတယ်။`
          );
        } catch {}
      }
    }

    // 5. Notify admin
    try {
      const uname = ctx.from.username ? `@${ctx.from.username}` : `ID:${ctx.from.id}`;
      await ctx.telegram.sendMessage(
        config.bot.adminId,
        `🔐 *Account ရောင်းရပြီ!*\n\n${p.emoji} ${esc(p.serviceName)} — ${esc(p.planLabel)}\n👤 ${esc(uname)}\n💵 ${ks(fp)}\n📧 \`${cleanCred(cred.loginId)}\``,
        { parse_mode: 'Markdown' }
      );
    } catch {}
  });

  // ── Multi-slot execute (shared/invite) ──────────────────────────────────────
  bot.action(/^acc_confirmq:([^:]+):(\d+)$/, async (ctx) => {
    const p = await AccountProduct.findById(ctx.match[1]);
    if (!p || !p.isActive || !isMulti(p)) return ctx.answerCbQuery('❌ မရောင်းတော့ပါ', { show_alert: true });
    const qty = Math.max(1, parseInt(ctx.match[2], 10) || 1);
    const user = await User.findByTelegramId(ctx.from.id);
    if (!user) return ctx.answerCbQuery('❌ /start အရင်နှိပ်ပါ', { show_alert: true });

    const fp = p.finalPrice();
    const total = fp * qty;
    const word = p.accountType === 'shared' ? 'device' : 'member';

    // 1. Debit wallet first (throws if insufficient)
    try {
      await debitKS(user._id, total, {
        type: 'Purchase',
        note: `Premium Account: ${p.serviceName} — ${p.planLabel} (${qty} ${word})`,
      });
    } catch (e) {
      return ctx.answerCbQuery('❌ လက်ကျန်ငွေ မလုံလောက်ပါ', { show_alert: true });
    }

    const refund = async (reason) => {
      try {
        await creditKS(user._id, total, { type: 'Refund', note: `Refund — ${p.serviceName}: ${reason}` });
      } catch (err) {
        console.error('[Accounts] ❌ REFUND FAILED:', err.message);
        try {
          await ctx.telegram.sendMessage(
            config.bot.adminId,
            `🚨 Premium Account REFUND FAILED!\nUser: ${ctx.from.id}\nAmount: ${total} KS\nReason: ${reason}\nError: ${err.message}\n→ လက်ဖြင့် ပြန်အမ်းပေးပါ။`
          );
        } catch {}
      }
    };

    // 2. Claim `qty` slots atomically from a single credential
    let cred;
    try {
      cred = await AccountCredential.claimSlots(p._id, qty);
    } catch (err) {
      console.error('[Accounts] ❌ claimSlots failed:', err.message);
      await refund(`claim error: ${err.message}`);
      await ctx.answerCbQuery();
      return ctx.reply('❌ တစ်ခုခု မှားသွားလို့ ငွေ ပြန်အမ်းပြီးပါပြီ။ ခဏနေ ပြန်ကြိုးစားပေးပါ။');
    }

    // 3. No single credential has enough free slots → refund
    if (!cred) {
      await refund('out of stock');
      await ctx.answerCbQuery();
      return ctx.reply(
        `❌ ${word} ${qty} ခုစာ တစ်ခုတည်းသော account/link မှာ မကျန်တော့လို့ ငွေ အပြည့် ပြန်အမ်းပြီးပါပြီ။\n_(အရေအတွက် လျှော့ပြီး ပြန်ကြိုးစားကြည့်ပါ)_`,
        { parse_mode: 'Markdown' }
      );
    }

    // 4. Record the per-buyer sale
    const now = new Date();
    const expiresAt = new Date(now.getTime() + p.durationDays * DAY_MS);
    let slot;
    try {
      slot = await AccountSlot.create({
        productId: p._id,
        credentialId: cred._id,
        buyerUserId: user._id,
        buyerTelegramId: ctx.from.id,
        slots: qty,
        soldAt: now,
        expiresAt,
        pricePaid: total,
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
      // Post-claim failure: release the slots we took and refund, then abort
      // (buyer keeps no untracked credential — nothing was delivered yet).
      console.error('[Accounts] ⚠️ AccountSlot record failed — rolling back:', err.message);
      try { await AccountCredential.releaseSlots(cred._id, qty); } catch (e) {
        console.error('[Accounts] ❌ releaseSlots failed:', e.message);
      }
      await refund(`slot record error: ${err.message}`);
      await ctx.answerCbQuery();
      return ctx.reply('❌ တစ်ခုခု မှားသွားလို့ ငွေ ပြန်အမ်းပြီးပါပြီ။ ခဏနေ ပြန်ကြိုးစားပေးပါ။');
    }

    await ctx.answerCbQuery('✅ ဝယ်ယူမှု အောင်မြင်ပါသည်!');
    await auditLog(ctx.from.id, 'BUY_ACCOUNT_SLOT', cred._id.toString(), 'System', {
      product: `${p.serviceName} ${p.planLabel}`, qty, price: total,
    });

    // 5. Deliver (login/password or invite link)
    const isLink = cred.credType === 'link';
    const bodyMd = isLink
      ? `🔗 Invite Link:\n${esc(cred.link)}\n` + (cred.note ? `📝 ${esc(cred.note)}\n` : '')
      : `📧 Login: \`${cleanCred(cred.loginId)}\`\n🔑 Password: \`${cleanCred(cred.password)}\`\n` +
        (cred.note ? `📝 ${esc(cred.note)}\n` : '');
    try {
      await ctx.reply(
        `✅ *ဝယ်ယူမှု အောင်မြင်ပါသည်!*\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
          `${p.emoji} *${esc(p.serviceName)}* — ${esc(p.planLabel)}\n` +
          `🔢 *${qty} ${word}* အတွက်\n\n` +
          bodyMd +
          `\n📅 ဝယ်သည့်နေ့: ${fmtDate(now)}\n` +
          `⏳ သက်တမ်းကုန်: *${fmtDate(expiresAt)}* (${p.durationDays} ရက်)\n` +
          `💵 ကျသင့်ငွေ: ${ks(total)}\n\n` +
          (isLink
            ? `_🔗 Link ကို နှိပ်ပြီး ဝင်ပါ။_\n`
            : `_👆 Login/Password ကို နှိပ်ရင် copy ဖြစ်ပါမယ်။_\n`) +
          `_🎟 ကျွန်ုပ်၏ Accounts မှာ သက်တမ်း အမြဲ ပြန်စစ်နိုင်ပါတယ်။_`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('🎟 ကျွန်ုပ်၏ Accounts', 'acc_mine')]]),
        }
      );
    } catch (err) {
      console.error('[Accounts] ⚠️ Markdown delivery failed, plain fallback:', err.message);
      try {
        await ctx.reply(
          `✅ ဝယ်ယူမှု အောင်မြင်ပါသည်!\n\n${p.serviceName} — ${p.planLabel} (${qty} ${word})\n\n` +
            (isLink
              ? `Invite Link: ${cred.link}\n`
              : `Login: ${cred.loginId}\nPassword: ${cred.password}\n`) +
            (cred.note ? `Note: ${cred.note}\n` : '') +
            `\nသက်တမ်းကုန်: ${fmtDate(expiresAt)} (${p.durationDays} ရက်)\n` +
            `ကျသင့်ငွေ: ${ks(total)}\n\n/myaccounts နဲ့ အမြဲ ပြန်ကြည့်နိုင်ပါတယ်။`
        );
      } catch (err2) {
        console.error('[Accounts] ❌ Delivery failed completely:', err2.message);
        try {
          await ctx.telegram.sendMessage(
            config.bot.adminId,
            `🚨 Account delivery message FAILED!\nUser: ${ctx.from.id}\nSlot: ${slot?._id}\n→ ဝယ်သူက /myaccounts နဲ့ ကြည့်လို့ရပါသေးတယ်။`
          );
        } catch {}
      }
    }

    // 6. Notify admin
    try {
      const uname = ctx.from.username ? `@${ctx.from.username}` : `ID:${ctx.from.id}`;
      const credLabel = isLink ? `🔗 \`${esc(cred.link)}\`` : `📧 \`${cleanCred(cred.loginId)}\``;
      await ctx.telegram.sendMessage(
        config.bot.adminId,
        `🔐 *Account ရောင်းရပြီ!*\n\n${p.emoji} ${esc(p.serviceName)} — ${esc(p.planLabel)}\n👤 ${esc(uname)}\n🔢 ${qty} ${word}\n💵 ${ks(total)}\n${credLabel}\n📊 slot ${cred.usedSlots}/${cred.capacity}`,
        { parse_mode: 'Markdown' }
      );
    } catch {}
  });

  bot.action('acc_mine', async (ctx) => {
    await ctx.answerCbQuery();
    const { text, keyboard } = await buildMyAccounts(ctx.from.id);
    return editOrReply(ctx, text, keyboard);
  });

  bot.command('myaccounts', async (ctx) => {
    const { text, keyboard } = await buildMyAccounts(ctx.from.id);
    await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  });

  // ══ ADMIN SIDE (Owner) ═════════════════════════════════════════════════════

  bot.hears('🔐 Accounts', adminOnly(), async (ctx) => {
    const { text, keyboard } = await buildAdminPanel();
    await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  });
  bot.command('accadmin', adminOnly(), async (ctx) => {
    const { text, keyboard } = await buildAdminPanel();
    await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  });

  bot.action('accad_panel', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const { text, keyboard } = await buildAdminPanel();
    await editOrReply(ctx, text, keyboard);
  });

  bot.action(/^accad_view:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const p = await AccountProduct.findById(ctx.match[1]);
    if (!p) return ctx.reply('❌ Not found');
    const { text, keyboard } = await buildAdminProductView(p);
    await editOrReply(ctx, text, keyboard);
  });

  bot.action(/^accad_toggle:(.+)$/, adminOnly(), async (ctx) => {
    const p = await AccountProduct.findById(ctx.match[1]);
    if (!p) return ctx.answerCbQuery('Not found', { show_alert: true });
    p.isActive = !p.isActive;
    await p.save();
    await auditLog(ctx.from.id, 'TOGGLE_ACCOUNT_PRODUCT', p._id.toString(), 'System', { isActive: p.isActive });
    await ctx.answerCbQuery(p.isActive ? '🟢 ဖွင့်ပြီး' : '🔴 ပိတ်ပြီး');
    const { text, keyboard } = await buildAdminProductView(p);
    await editOrReply(ctx, text, keyboard);
  });

  bot.action('accad_add', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.accGaWiz = null; // isolate from the giveaway wizard
    ctx.session.accAdmin = null;
    await ctx.reply(
      `➕ *Account Product အသစ်*\n\nအရင်ဆုံး *အမျိုးအစား* ရွေးပါ 👇\n\n` +
        `👤 *Single* — login/password တစ်ခုကို လူတစ်ယောက်တည်း သုံး (ပုံမှန်)\n` +
        `📱 *Multi-device* — login/password တစ်ခုကို device အများ မျှသုံး (ဥပမာ ExpressVPN 8-device)\n` +
        `🔗 *Invite link* — link တစ်ခုကို member အများ ဝင် (ဥပမာ Duolingo family 5-member)`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('👤 Single', 'accad_addtype:single')],
          [Markup.button.callback('📱 Multi-device', 'accad_addtype:shared')],
          [Markup.button.callback('🔗 Invite link', 'accad_addtype:invite')],
          [Markup.button.callback('🔙 Accounts Panel', 'accad_panel')],
        ]),
      }
    );
  });

  bot.action(/^accad_addtype:(single|shared|invite)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.accGaWiz = null;
    const accountType = ctx.match[1];
    ctx.session.accAdmin = { step: 'service', accountType };
    const badge = TYPE_BADGE[accountType];
    await ctx.reply(
      `➕ *Account Product အသစ်* (${badge})\n\nStep 1: *Service နာမည်* ရိုက်ပါ:\n_(ဥပမာ ExpressVPN, Netflix, Duolingo)_`,
      { parse_mode: 'Markdown', ...Markup.forceReply() }
    );
  });

  bot.action(/^accad_stock:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const p = await AccountProduct.findById(ctx.match[1]);
    if (!p) return ctx.reply('❌ Product မတွေ့ပါ။');
    ctx.session.accGaWiz = null; // isolate from the giveaway wizard
    ctx.session.accAdmin = { step: 'stock', productId: ctx.match[1] };
    let prompt;
    if (p.accountType === 'invite') {
      prompt =
        `📥 *Invite Link ထည့်ရန်* (🔗 Invite link)\n\n` +
        `Link တွေကို တစ်ကြောင်းချင်း ပို့ပါ:\n\n` +
        `\`https://example.com/invite/abc\`\n\`https://example.com/invite/xyz\`\n\n` +
        `_🔗 Link တစ်ခုစီကို member ${p.slotsPerUnit} ယောက်အထိ ရောင်းပေးမှာပါ။_`;
    } else if (p.accountType === 'shared') {
      prompt =
        `📥 *Account ထည့်ရန်* (📱 Multi-device)\n\n` +
        `Account တွေကို တစ်ကြောင်းချင်း ဒီပုံစံနဲ့ ပို့ပါ:\n\n` +
        `\`email:password\`\n\`email2:password2\`\n\n` +
        `_📱 Account တစ်ခုစီကို device ${p.slotsPerUnit} ခုအထိ ရောင်းပေးမှာပါ။_`;
    } else {
      prompt =
        `📥 *Stock ထည့်ရန်*\n\nAccount တွေကို တစ်ကြောင်းချင်း ဒီပုံစံနဲ့ ပို့ပါ:\n\n` +
        `\`email:password\`\n\`email2:password2\`\n\n_(တစ်ကြိမ်တည်း အများကြီး ထည့်လို့ရပါတယ်)_`;
    }
    await ctx.reply(prompt, { parse_mode: 'Markdown', ...Markup.forceReply() });
  });

  bot.action(/^accad_disc:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.accGaWiz = null; // isolate from the giveaway wizard
    ctx.session.accAdmin = { step: 'discount', productId: ctx.match[1] };
    await ctx.reply(
      `🏷 *Discount သတ်မှတ်ရန်*\n\nလျှော့စျေး % ရိုက်ပါ (0–90):\n_(0 = discount မရှိ။ ဥပမာ "20" = 20% လျှော့)_`,
      { parse_mode: 'Markdown', ...Markup.forceReply() }
    );
  });

  bot.action(/^accad_price:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.accGaWiz = null; // isolate from the giveaway wizard
    ctx.session.accAdmin = { step: 'price_edit', productId: ctx.match[1] };
    await ctx.reply(`💵 *စျေးနှုန်းအသစ်* (KS) ရိုက်ပါ:`, { parse_mode: 'Markdown', ...Markup.forceReply() });
  });

  bot.action(/^accad_del:(.+)$/, adminOnly(), async (ctx) => {
    const p = await AccountProduct.findById(ctx.match[1]);
    if (!p) return ctx.answerCbQuery('Not found', { show_alert: true });
    await ctx.answerCbQuery();
    await ctx.reply(
      `🗑 *${esc(p.serviceName)} — ${esc(p.planLabel)}* ကို ဖျက်မှာ သေချာလား?\n\n_မရောင်းရသေးတဲ့ stock တွေပါ ဖျက်မယ်။ ရောင်းပြီးသား account တွေကတော့ ဝယ်သူဆီမှာ ဆက်ရှိနေပါမယ်။_`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ ဖျက်မယ်', `accad_delyes:${p._id}`)],
          [Markup.button.callback('❌ မဖျက်တော့ဘူး', 'accad_panel')],
        ]),
      }
    );
  });

  bot.action(/^accad_delyes:(.+)$/, adminOnly(), async (ctx) => {
    const p = await AccountProduct.findById(ctx.match[1]);
    if (!p) return ctx.answerCbQuery('Not found', { show_alert: true });
    const name = `${p.serviceName} — ${p.planLabel}`;
    await AccountCredential.deleteMany({ productId: p._id, status: 'available' });
    await AccountProduct.deleteOne({ _id: p._id });
    await auditLog(ctx.from.id, 'DELETE_ACCOUNT_PRODUCT', ctx.match[1], 'System', { name });
    await ctx.answerCbQuery('🗑 ဖျက်ပြီးပါပြီ');
    const { text, keyboard } = await buildAdminPanel();
    await editOrReply(ctx, text, keyboard);
  });

  // ── Admin text-input steps (wizard) ─────────────────────────────────────────
  bot.on('text', async (ctx, next) => {
    const state = ctx.session?.accAdmin;
    if (!state || ctx.from.id !== config.bot.adminId) return next();
    const input = ctx.message.text.trim();

    // ➕ Add product wizard
    if (state.step === 'service') {
      state.serviceName = input;
      state.step = 'plan';
      return ctx.reply(`Step 2/5: *Plan နာမည်* ရိုက်ပါ:\n_(ဥပမာ 1 Month Premium)_`, { parse_mode: 'Markdown', ...Markup.forceReply() });
    }
    if (state.step === 'plan') {
      state.planLabel = input;
      state.step = 'price';
      return ctx.reply(`Step 3/5: *စျေးနှုန်း* (KS) ရိုက်ပါ:\n_(ဥပမာ 15000)_`, { parse_mode: 'Markdown', ...Markup.forceReply() });
    }
    if (state.step === 'price') {
      const price = parseInt(input.replace(/[^\d]/g, ''), 10);
      if (!price || price <= 0) return ctx.reply('❌ ကိန်းဂဏန်းပဲ ရိုက်ပါ (ဥပမာ 15000):', Markup.forceReply());
      state.price = price;
      state.step = 'duration';
      return ctx.reply(`Step 4/5: *သက်တမ်း (ရက်)* ရိုက်ပါ:\n_(ဥပမာ 30 = ဝယ်ပြီး ရက် 30 သုံးလို့ရ)_`, { parse_mode: 'Markdown', ...Markup.forceReply() });
    }
    if (state.step === 'duration') {
      const days = parseInt(input.replace(/[^\d]/g, ''), 10);
      if (!days || days <= 0) return ctx.reply('❌ ရက်အရေအတွက် ကိန်းဂဏန်းပဲ ရိုက်ပါ (ဥပမာ 30):', Markup.forceReply());
      state.durationDays = days;
      if (state.accountType === 'shared' || state.accountType === 'invite') {
        state.step = 'capacity';
        const q = state.accountType === 'shared'
          ? `Step 5: *Account တစ်ခုကို device ဘယ်နှစ်ခု* သုံးလို့ရလဲ ရိုက်ပါ:\n_(ဥပမာ ExpressVPN ဆို 8)_`
          : `Step 5: *Link တစ်ခုကို member ဘယ်နှစ်ယောက်* ဝင်လို့ရလဲ ရိုက်ပါ:\n_(ဥပမာ Duolingo family ဆို 5)_`;
        return ctx.reply(q, { parse_mode: 'Markdown', ...Markup.forceReply() });
      }
      state.step = 'emoji';
      return ctx.reply(`Step 5/5: *Emoji* ရိုက်ပါ (ဥပမာ 🛡 📺 🎵) — မထည့်ချင်ရင် \`skip\`:`, { parse_mode: 'Markdown', ...Markup.forceReply() });
    }
    if (state.step === 'capacity') {
      const cap = parseInt(input.replace(/[^\d]/g, ''), 10);
      if (!cap || cap < 1) return ctx.reply('❌ ၁ ထက်ကြီးတဲ့ ကိန်းဂဏန်းပဲ ရိုက်ပါ (ဥပမာ 8):', Markup.forceReply());
      state.slotsPerUnit = cap;
      state.step = 'emoji';
      return ctx.reply(`Step 6/6: *Emoji* ရိုက်ပါ (ဥပမာ 🛡 📺 🦉) — မထည့်ချင်ရင် \`skip\`:`, { parse_mode: 'Markdown', ...Markup.forceReply() });
    }
    if (state.step === 'emoji') {
      const emoji = input.toLowerCase() === 'skip' ? '🔐' : input;
      const accountType = state.accountType || 'single';
      const slotsPerUnit = accountType === 'single' ? 1 : (state.slotsPerUnit || 1);
      ctx.session.accAdmin = null;
      const p = await AccountProduct.create({
        serviceName: state.serviceName,
        planLabel: state.planLabel,
        price: state.price,
        durationDays: state.durationDays,
        emoji,
        accountType,
        slotsPerUnit,
      });
      await auditLog(ctx.from.id, 'ADD_ACCOUNT_PRODUCT', p._id.toString(), 'System', { name: `${p.serviceName} ${p.planLabel}`, accountType });
      const typeLine = accountType === 'shared'
        ? `\n📱 Multi-device — account တစ်ခုကို device ${slotsPerUnit} ခု`
        : accountType === 'invite'
          ? `\n🔗 Invite link — link တစ်ခုကို member ${slotsPerUnit} ယောက်`
          : '';
      const stockWord = accountType === 'invite' ? 'Link' : 'Stock';
      return ctx.reply(
        `✅ *ထည့်ပြီးပါပြီ!*\n\n${emoji} *${esc(p.serviceName)}* — ${esc(p.planLabel)}${typeLine}\n💵 ${ks(p.price)}${accountType !== 'single' ? ` / ${accountType === 'shared' ? 'device' : 'member'}` : ''}  •  ⏳ ${p.durationDays} ရက်\n\n_📥 ${stockWord} ထည့်ဖို့ မမေ့ပါနဲ့ — မရှိရင် ဝယ်သူ ဝယ်လို့မရပါ။_`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback(`📥 ${stockWord} ထည့်မယ်`, `accad_stock:${p._id}`)],
            [Markup.button.callback('🔙 Accounts Panel', 'accad_panel')],
          ]),
        }
      );
    }

    // 📥 Add stock (type-aware)
    if (state.step === 'stock') {
      ctx.session.accAdmin = null;
      const p = await AccountProduct.findById(state.productId);
      if (!p) return ctx.reply('❌ Product မတွေ့ပါ။');
      const lines = input.split('\n').map((l) => l.trim()).filter(Boolean);
      const docs = [];
      const badLines = [];

      if (p.accountType === 'invite') {
        for (const line of lines) {
          if (!/^https?:\/\/\S+$/i.test(line)) { badLines.push(line); continue; }
          docs.push({
            productId: p._id,
            credType: 'link',
            link: line,
            capacity: p.slotsPerUnit,
            usedSlots: 0,
            addedBy: ctx.from.id,
          });
        }
      } else {
        const capacity = p.accountType === 'shared' ? p.slotsPerUnit : 1;
        for (const line of lines) {
          const idx = line.indexOf(':');
          if (idx < 1 || idx === line.length - 1) { badLines.push(line); continue; }
          docs.push({
            productId: p._id,
            credType: 'login',
            loginId: cleanCred(line.slice(0, idx)),
            password: cleanCred(line.slice(idx + 1)),
            capacity,
            usedSlots: 0,
            addedBy: ctx.from.id,
          });
        }
      }

      if (docs.length) await AccountCredential.insertMany(docs);
      await auditLog(ctx.from.id, 'ADD_ACCOUNT_STOCK', p._id.toString(), 'System', { added: docs.length, accountType: p.accountType });
      const avail = await freeUnits(p);
      const itemWord = p.accountType === 'invite' ? 'Link' : 'Account';
      const badHint = p.accountType === 'invite'
        ? 'https:// နဲ့ စတဲ့ link ပုံစံ လိုပါတယ်'
        : 'email:password ပုံစံ လိုပါတယ်';
      const unitWord = p.accountType === 'shared' ? 'device' : p.accountType === 'invite' ? 'member' : '';
      return ctx.reply(
        `✅ ${itemWord} *${docs.length} ခု* ထည့်ပြီးပါပြီ။` +
          (badLines.length ? `\n⚠️ ပုံစံမမှန်လို့ ကျော်သွားတာ ${badLines.length} ကြောင်း (${badHint})` : '') +
          (isMulti(p)
            ? `\n📦 ${esc(p.serviceName)} လက်ကျန် စုစုပေါင်း: *${avail} ${unitWord}*`
            : `\n📦 ${esc(p.serviceName)} လက်ကျန် စုစုပေါင်း: *${avail}*`),
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Accounts Panel', 'accad_panel')]]),
        }
      );
    }

    // 🏷 Discount
    if (state.step === 'discount') {
      ctx.session.accAdmin = null;
      const pct = parseInt(input.replace(/[^\d]/g, ''), 10);
      if (isNaN(pct) || pct < 0 || pct > 90) return ctx.reply('❌ 0 နဲ့ 90 ကြားပဲ ရိုက်ပါ။');
      const p = await AccountProduct.findByIdAndUpdate(state.productId, { discountPercent: pct }, { new: true });
      if (!p) return ctx.reply('❌ Product မတွေ့ပါ။');
      await auditLog(ctx.from.id, 'SET_ACCOUNT_DISCOUNT', p._id.toString(), 'System', { discountPercent: pct });
      return ctx.reply(
        pct > 0
          ? `✅ *${esc(p.serviceName)}* ကို *-${pct}%* လျှော့စျေး သတ်မှတ်ပြီးပါပြီ။\n💵 ${ks(p.price)} → *${ks(p.finalPrice())}*`
          : `✅ *${esc(p.serviceName)}* discount ဖြုတ်ပြီးပါပြီ။`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Accounts Panel', 'accad_panel')]]) }
      );
    }

    // 💵 Price edit
    if (state.step === 'price_edit') {
      ctx.session.accAdmin = null;
      const price = parseInt(input.replace(/[^\d]/g, ''), 10);
      if (!price || price <= 0) return ctx.reply('❌ ကိန်းဂဏန်းပဲ ရိုက်ပါ။');
      const p = await AccountProduct.findByIdAndUpdate(state.productId, { price }, { new: true });
      if (!p) return ctx.reply('❌ Product မတွေ့ပါ။');
      await auditLog(ctx.from.id, 'SET_ACCOUNT_PRICE', p._id.toString(), 'System', { price });
      return ctx.reply(
        `✅ *${esc(p.serviceName)}* စျေးနှုန်း *${ks(price)}* ပြောင်းပြီးပါပြီ။${p.discountPercent > 0 ? ` (discount နဲ့ဆို ${ks(p.finalPrice())})` : ''}`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Accounts Panel', 'accad_panel')]]) }
      );
    }

    return next();
  });
};
