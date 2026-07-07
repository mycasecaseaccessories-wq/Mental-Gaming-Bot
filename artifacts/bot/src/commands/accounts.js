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
const User = require('../models/User');
const { config } = require('../../config/settings');

const DAY_MS = 24 * 60 * 60 * 1000;

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

// ── User: hub ────────────────────────────────────────────────────────────────

async function buildHub() {
  const products = await AccountProduct.getActive();
  const counts = await Promise.all(products.map((p) => AccountCredential.countAvailable(p._id)));

  let text = `🔐 *Premium Accounts*\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n`;
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

  const rows = products.map((p, i) => [
    Markup.button.callback(
      `${p.emoji} ${p.serviceName} — ${p.planLabel}${counts[i] === 0 ? ' (ကုန်)' : ''}`,
      `acc_view:${p._id}`
    ),
  ]);
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
  rows.push([Markup.button.callback('🔄 Refresh', 'accad_panel'), Markup.button.callback('🔙 Back', 'nav:go:admin_main')]);

  return { text, keyboard: Markup.inlineKeyboard(rows) };
}

async function buildAdminProductView(p) {
  const [avail, sold] = await Promise.all([
    AccountCredential.countAvailable(p._id),
    AccountCredential.countDocuments({ productId: p._id, status: 'sold' }),
  ]);
  const text =
    `${p.emoji} *${esc(p.serviceName)}* — ${esc(p.planLabel)}\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
    `${p.isActive ? '🟢 ရောင်းနေသည် (ဝယ်သူမြင်ရ)' : '🔴 ပိတ်ထား (ဝယ်သူမမြင်ရ)'}\n` +
    `💵 စျေး: *${ks(p.price)}*${p.discountPercent > 0 ? `  →  🏷 *${ks(p.finalPrice())}* (-${p.discountPercent}%)` : ''}\n` +
    `⏳ သက်တမ်း: *${p.durationDays} ရက်* (ဝယ်ချိန်မှ စတွက်)\n` +
    `📦 Stock: *${avail} ကျန်* / ${sold} ရောင်းပြီး\n` +
    (p.description ? `📝 ${esc(p.description)}\n` : '');
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(p.isActive ? '🔴 ပိတ်မယ်' : '🟢 ဖွင့်မယ်', `accad_toggle:${p._id}`)],
    [
      Markup.button.callback('📥 Stock ထည့်', `accad_stock:${p._id}`),
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
    const stock = await AccountCredential.countAvailable(p._id);
    const fp = p.finalPrice();
    const priceStr = p.discountPercent > 0
      ? `~${p.price.toLocaleString()} KS~  →  *${ks(fp)}*  🏷 _-${p.discountPercent}% လျှော့စျေး!_`
      : `*${ks(fp)}*`;
    const text =
      `${p.emoji} *${esc(p.serviceName)}*\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
      `📦 Plan: *${esc(p.planLabel)}*\n` +
      `💵 စျေးနှုန်း: ${priceStr}\n` +
      `⏳ သက်တမ်း: *${p.durationDays} ရက်* (ဝယ်ချိန်မှ စတွက်)\n` +
      `📦 လက်ကျန်: *${stock}*\n` +
      (p.description ? `\n📝 ${esc(p.description)}\n` : '') +
      `\n_ဝယ်ပြီးတာနဲ့ login + password ချက်ချင်း ရပါမယ်။_`;
    const keyboard = Markup.inlineKeyboard([
      [
        stock > 0
          ? Markup.button.callback(`🛒 ဝယ်မယ် — ${ks(fp)}`, `acc_buy:${p._id}`)
          : Markup.button.callback('❌ Stock ကုန်နေပါသည်', 'acc_hub'),
      ],
      [Markup.button.callback('🔙 Back', 'acc_hub')],
    ]);
    await editOrReply(ctx, text, keyboard);
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

  bot.action('acc_mine', async (ctx) => {
    await ctx.answerCbQuery();
    const creds = await AccountCredential.find({ buyerTelegramId: ctx.from.id, status: 'sold' })
      .sort({ soldAt: -1 })
      .limit(20);
    if (!creds.length) {
      return editOrReply(
        ctx,
        `🎟 *ကျွန်ုပ်၏ Accounts*\n\n_ဝယ်ထားတဲ့ account မရှိသေးပါ။_`,
        Markup.inlineKeyboard([[Markup.button.callback('🔐 Account ဝယ်မယ်', 'acc_hub')]])
      );
    }
    const lines = creds.map((c) => {
      const days = remainingDays(c.expiresAt);
      const state = days > 0 ? `🟢 *${days} ရက်* ကျန်` : `🔴 သက်တမ်းကုန်ပြီ`;
      return (
        `${state} — *${esc(c.serviceNameSnap || 'Account')}* (${esc(c.planLabelSnap || '')})\n` +
        `   📧 \`${cleanCred(c.loginId)}\`  🔑 \`${cleanCred(c.password)}\`\n` +
        `   📅 ${fmtDate(c.soldAt)} → ${fmtDate(c.expiresAt)}`
      );
    });
    await editOrReply(
      ctx,
      `🎟 *ကျွန်ုပ်၏ Accounts (${creds.length})*\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n${lines.join('\n\n')}`,
      Markup.inlineKeyboard([[Markup.button.callback('🔐 နောက်ထပ်ဝယ်မယ်', 'acc_hub')]])
    );
  });

  bot.command('myaccounts', async (ctx) => {
    const creds = await AccountCredential.find({ buyerTelegramId: ctx.from.id, status: 'sold' })
      .sort({ soldAt: -1 })
      .limit(20);
    if (!creds.length) return ctx.reply('🎟 ဝယ်ထားတဲ့ account မရှိသေးပါ။ /accounts နဲ့ ကြည့်နိုင်ပါတယ်။');
    const lines = creds.map((c) => {
      const days = remainingDays(c.expiresAt);
      const state = days > 0 ? `🟢 *${days} ရက်* ကျန်` : `🔴 သက်တမ်းကုန်ပြီ`;
      return (
        `${state} — *${esc(c.serviceNameSnap || 'Account')}* (${esc(c.planLabelSnap || '')})\n` +
        `   📧 \`${cleanCred(c.loginId)}\`  🔑 \`${cleanCred(c.password)}\`\n` +
        `   📅 ${fmtDate(c.soldAt)} → ${fmtDate(c.expiresAt)}`
      );
    });
    await ctx.reply(
      `🎟 *ကျွန်ုပ်၏ Accounts (${creds.length})*\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n${lines.join('\n\n')}`,
      { parse_mode: 'Markdown' }
    );
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
    ctx.session.accAdmin = { step: 'service' };
    await ctx.reply(
      `➕ *Account Product အသစ်*\n\nStep 1/5: *Service နာမည်* ရိုက်ပါ:\n_(ဥပမာ ExpressVPN, Netflix, Spotify)_`,
      { parse_mode: 'Markdown', ...Markup.forceReply() }
    );
  });

  bot.action(/^accad_stock:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.accAdmin = { step: 'stock', productId: ctx.match[1] };
    await ctx.reply(
      `📥 *Stock ထည့်ရန်*\n\nAccount တွေကို တစ်ကြောင်းချင်း ဒီပုံစံနဲ့ ပို့ပါ:\n\n\`email:password\`\n\`email2:password2\`\n\n_(တစ်ကြိမ်တည်း အများကြီး ထည့်လို့ရပါတယ်)_`,
      { parse_mode: 'Markdown', ...Markup.forceReply() }
    );
  });

  bot.action(/^accad_disc:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.accAdmin = { step: 'discount', productId: ctx.match[1] };
    await ctx.reply(
      `🏷 *Discount သတ်မှတ်ရန်*\n\nလျှော့စျေး % ရိုက်ပါ (0–90):\n_(0 = discount မရှိ။ ဥပမာ "20" = 20% လျှော့)_`,
      { parse_mode: 'Markdown', ...Markup.forceReply() }
    );
  });

  bot.action(/^accad_price:(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
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
      state.step = 'emoji';
      return ctx.reply(`Step 5/5: *Emoji* ရိုက်ပါ (ဥပမာ 🛡 📺 🎵) — မထည့်ချင်ရင် \`skip\`:`, { parse_mode: 'Markdown', ...Markup.forceReply() });
    }
    if (state.step === 'emoji') {
      const emoji = input.toLowerCase() === 'skip' ? '🔐' : input;
      ctx.session.accAdmin = null;
      const p = await AccountProduct.create({
        serviceName: state.serviceName,
        planLabel: state.planLabel,
        price: state.price,
        durationDays: state.durationDays,
        emoji,
      });
      await auditLog(ctx.from.id, 'ADD_ACCOUNT_PRODUCT', p._id.toString(), 'System', { name: `${p.serviceName} ${p.planLabel}` });
      return ctx.reply(
        `✅ *ထည့်ပြီးပါပြီ!*\n\n${emoji} *${esc(p.serviceName)}* — ${esc(p.planLabel)}\n💵 ${ks(p.price)}  •  ⏳ ${p.durationDays} ရက်\n\n_📥 Stock (account credentials) ထည့်ဖို့ မမေ့ပါနဲ့ — stock မရှိရင် ဝယ်သူ ဝယ်လို့မရပါ။_`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('📥 Stock ထည့်မယ်', `accad_stock:${p._id}`)],
            [Markup.button.callback('🔙 Accounts Panel', 'accad_panel')],
          ]),
        }
      );
    }

    // 📥 Add stock
    if (state.step === 'stock') {
      ctx.session.accAdmin = null;
      const p = await AccountProduct.findById(state.productId);
      if (!p) return ctx.reply('❌ Product မတွေ့ပါ။');
      const lines = input.split('\n').map((l) => l.trim()).filter(Boolean);
      const docs = [];
      const badLines = [];
      for (const line of lines) {
        const idx = line.indexOf(':');
        if (idx < 1 || idx === line.length - 1) { badLines.push(line); continue; }
        docs.push({
          productId: p._id,
          loginId: cleanCred(line.slice(0, idx)),
          password: cleanCred(line.slice(idx + 1)),
          addedBy: ctx.from.id,
        });
      }
      if (docs.length) await AccountCredential.insertMany(docs);
      await auditLog(ctx.from.id, 'ADD_ACCOUNT_STOCK', p._id.toString(), 'System', { added: docs.length });
      const avail = await AccountCredential.countAvailable(p._id);
      return ctx.reply(
        `✅ Stock *${docs.length} ခု* ထည့်ပြီးပါပြီ။` +
          (badLines.length ? `\n⚠️ ပုံစံမမှန်လို့ ကျော်သွားတာ ${badLines.length} ကြောင်း (email:password ပုံစံ လိုပါတယ်)` : '') +
          `\n📦 ${esc(p.serviceName)} လက်ကျန် စုစုပေါင်း: *${avail}*`,
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
