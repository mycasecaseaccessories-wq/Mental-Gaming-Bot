/**
 * Account Giveaway — give one premium-account product away FREE to bot users,
 * with individually toggleable restrictions:
 *   📦 max claims quota · ⏰ deadline · 📅 min account age ·
 *   🛒 must have purchased before · 📣 must join a channel
 * One giveaway active at a time; one claim per user (claim-record-first).
 */
const { Markup } = require('telegraf');
const { adminOnly } = require('../middlewares/adminCheck');
const { auditLog } = require('../services/logger');
const { broadcastToUsers } = require('../services/BroadcastService');
const { getKnownChannels } = require('../services/ChannelRegistryService');
const { estimateAccountAgeDays } = require('../utils/accountAge');
const AccountGiveaway = require('../models/AccountGiveaway');
const AccountGiveawayClaim = require('../models/AccountGiveawayClaim');
const AccountProduct = require('../models/AccountProduct');
const AccountCredential = require('../models/AccountCredential');
const Order = require('../models/Order');
const User = require('../models/User');
const SystemStatus = require('../models/SystemStatus');
const { config } = require('../../config/settings');

const DAY_MS = 24 * 60 * 60 * 1000;

function esc(s) {
  return String(s == null ? '' : s).replace(/([_*`\[])/g, '\\$1');
}
function cleanCred(s) {
  return String(s || '').replace(/`/g, '').trim();
}
function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-GB', { timeZone: 'Asia/Rangoon' });
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

  if (ga.requireChannelId) {
    let joined = false;
    try {
      const m = await ctx.telegram.getChatMember(ga.requireChannelId, ctx.from.id);
      joined = ['member', 'administrator', 'creator'].includes(m?.status);
    } catch {}
    checks.push({
      ok: joined,
      label: `📣 "${esc(ga.requireChannelTitle || 'channel')}" ကို join ထားရမယ်`,
      channelId: ga.requireChannelId,
    });
  }

  return checks;
}

async function channelJoinUrl(ctx, chatId) {
  try {
    const chat = await ctx.telegram.getChat(chatId);
    if (chat?.username) return `https://t.me/${chat.username}`;
    if (chat?.invite_link) return chat.invite_link;
  } catch {}
  return null;
}

// ── User: giveaway detail view ───────────────────────────────────────────────

async function buildUserView(ctx) {
  const ga = await AccountGiveaway.getActive();
  if (!ga || !ga.productId) return null;
  const p = ga.productId;

  const stock = await AccountCredential.countAvailable(p._id);
  const already = await AccountGiveawayClaim.exists({ giveawayId: ga._id, telegramId: ctx.from.id });
  const quotaLeft = ga.maxClaims > 0 ? Math.max(0, ga.maxClaims - ga.claimedCount) : null;
  const checks = await checkRequirements(ga, ctx);
  const allOk = checks.every((c) => c.ok);

  let text =
    `🎁 *အခမဲ့ Premium Account!*\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
    `${p.emoji} *${esc(p.serviceName)}* — ${esc(p.planLabel)}\n` +
    `⏳ သက်တမ်း: *${p.durationDays} ရက်* (ရယူချိန်မှ စတွက်)\n` +
    `💵 တန်ဖိုး: ~${Number(p.price).toLocaleString()} KS~ → *အခမဲ့!*\n\n`;

  if (quotaLeft !== null) text += `📦 ကျန်တဲ့ အခွင့်အရေး: *${Math.min(quotaLeft, stock)} ခု*\n`;
  else text += `📦 လက်ကျန်: *${stock} ခု*\n`;
  if (ga.endAt) text += `⏰ နောက်ဆုံးရက်: *${fmtDate(ga.endAt)}*\n`;

  if (checks.length) {
    text += `\n*လိုအပ်ချက်များ:*\n`;
    text += checks.map((c) => `${c.ok ? '✅' : '❌'} ${c.label}`).join('\n') + '\n';
  }

  const rows = [];
  if (already) {
    text += `\n✅ _သင် ရယူပြီးသားပါ — 🎟 ကျွန်ုပ်၏ Accounts မှာ ကြည့်နိုင်ပါတယ်။_`;
    rows.push([Markup.button.callback('🎟 ကျွန်ုပ်၏ Accounts', 'acc_mine')]);
  } else if (stock === 0 || (quotaLeft !== null && quotaLeft === 0)) {
    text += `\n😢 _ကုန်သွားပါပြီ…_`;
  } else if (allOk) {
    text += `\n_👇 ခလုတ်နှိပ်ပြီး ချက်ချင်း ရယူလိုက်ပါ!_`;
    rows.push([Markup.button.callback('🎁 အခမဲ့ ရယူမယ်', 'accga_claim')]);
  } else {
    text += `\n_❌ ပြထားတဲ့ လိုအပ်ချက်တွေ ပြည့်မီရင် ရယူနိုင်ပါမယ်။_`;
    const chanCheck = checks.find((c) => !c.ok && c.channelId);
    if (chanCheck) {
      const url = await channelJoinUrl(ctx, chanCheck.channelId);
      if (url) rows.push([Markup.button.url('📣 Channel Join မယ်', url)]);
    }
    rows.push([Markup.button.callback('🔄 ပြန်စစ်မယ်', 'accga_free')]);
  }
  rows.push([Markup.button.callback('🔙 Premium Accounts', 'acc_hub')]);

  return { text, keyboard: Markup.inlineKeyboard(rows) };
}

// ── Admin: giveaway panel ────────────────────────────────────────────────────

/** Single authoritative selector — prefer the active giveaway, else newest. */
async function getAdminGa({ populate = false } = {}) {
  let q = AccountGiveaway.findOne({ isActive: true });
  if (populate) q = q.populate('productId');
  let ga = await q;
  if (!ga) {
    let q2 = AccountGiveaway.findOne().sort({ updatedAt: -1 });
    if (populate) q2 = q2.populate('productId');
    ga = await q2;
  }
  return ga;
}

async function buildAdminGaPanel() {
  const ga = await getAdminGa({ populate: true });

  if (!ga || !ga.productId) {
    const products = await AccountProduct.find().sort({ displayOrder: 1, serviceName: 1 });
    const rows = products.map((p) => [
      Markup.button.callback(`${p.emoji} ${p.serviceName} — ${p.planLabel}`, `accga_pick:${p._id}`),
    ]);
    rows.push([Markup.button.callback('🔙 Accounts Panel', 'accad_panel')]);
    return {
      text:
        `🎁 *Free Giveaway — Admin*\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
        (products.length
          ? `Giveaway မရှိသေးပါ။ အခမဲ့ပေးမယ့် *account product* ကို ရွေးပါ:`
          : `_Account product မရှိသေးပါ။ 🔐 Accounts panel မှာ အရင်ထည့်ပါ။_`),
      keyboard: Markup.inlineKeyboard(rows),
    };
  }

  const p = ga.productId;
  const stock = await AccountCredential.countAvailable(p._id);

  const text =
    `🎁 *Free Giveaway — Admin*\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
    `${ga.isActive ? '🟢 *ဖွင့်ထားသည်* (user တွေ ရယူနိုင်)' : '🔴 *ပိတ်ထားသည်*'}\n\n` +
    `${p.emoji} *${esc(p.serviceName)}* — ${esc(p.planLabel)}  (📦 stock ${stock})\n` +
    `🎯 ရယူပြီး: *${ga.claimedCount}*${ga.maxClaims > 0 ? ` / ${ga.maxClaims}` : ''}\n\n` +
    `*ကန့်သတ်ချက်များ:*\n` +
    `📦 အရေအတွက်: ${ga.maxClaims > 0 ? `*${ga.maxClaims} ယောက်ပဲ*` : '_မကန့်သတ် (stock ကုန်သည်အထိ)_'}\n` +
    `⏰ နောက်ဆုံးရက်: ${ga.endAt ? `*${fmtDate(ga.endAt)}*` : '_မကန့်သတ်_'}\n` +
    `📅 Account သက်တမ်း: ${ga.minAccountAgeDays > 0 ? `*${ga.minAccountAgeDays} ရက်ကျော်*` : '_မစစ်_'}\n` +
    `🛒 ဝယ်ဖူးမှ: ${ga.requirePurchase ? '*လိုအပ်*' : '_မလို_'}\n` +
    `📣 Channel join: ${ga.requireChannelId ? `*${esc(ga.requireChannelTitle || String(ga.requireChannelId))}*` : '_မလို_'}\n`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(ga.isActive ? '🔴 ရပ်မယ်' : '🟢 စတင်မယ်', 'accga_toggle')],
    [
      Markup.button.callback('📦 အရေအတွက်', 'accga_max'),
      Markup.button.callback('⏰ ရက်သတ်မှတ်', 'accga_days'),
    ],
    [
      Markup.button.callback('📅 Acc သက်တမ်း', 'accga_age'),
      Markup.button.callback(`🛒 ဝယ်ဖူးမှ: ${ga.requirePurchase ? 'ON' : 'OFF'}`, 'accga_purch'),
    ],
    [Markup.button.callback('📣 Channel join သတ်မှတ်', 'accga_chan')],
    [
      Markup.button.callback('♻️ Product ပြောင်း', 'accga_repick'),
      Markup.button.callback('🗑 ဖျက်', 'accga_del'),
    ],
    ...(ga.isActive ? [[Markup.button.callback('📢 User တွေဆီ ကြေညာမယ်', 'accga_announce')]] : []),
    [Markup.button.callback('🔙 Accounts Panel', 'accad_panel')],
  ]);

  return { text, keyboard };
}

// ── Module ───────────────────────────────────────────────────────────────────

module.exports = function registerAccountGiveaway(bot) {
  // ══ USER SIDE ═══════════════════════════════════════════════════════════════

  bot.action('accga_free', async (ctx) => {
    await ctx.answerCbQuery();
    const view = await buildUserView(ctx);
    if (!view) return editOrReply(ctx, '😢 _လက်ရှိ giveaway မရှိတော့ပါ။_');
    await editOrReply(ctx, view.text, view.keyboard);
  });

  bot.command('freebie', async (ctx) => {
    const view = await buildUserView(ctx);
    if (!view) return ctx.reply('😢 လက်ရှိ အခမဲ့ giveaway မရှိသေးပါ။');
    await ctx.reply(view.text, { parse_mode: 'Markdown', ...view.keyboard });
  });

  bot.action('accga_claim', async (ctx) => {
    const ga = await AccountGiveaway.getActive();
    if (!ga || !ga.productId) return ctx.answerCbQuery('😢 Giveaway ပြီးသွားပါပြီ', { show_alert: true });
    const p = ga.productId;

    const user = await User.findByTelegramId(ctx.from.id);
    if (!user) return ctx.answerCbQuery('❌ /start အရင်နှိပ်ပါ', { show_alert: true });

    // 1. Re-verify all restrictions at claim time
    const checks = await checkRequirements(ga, ctx);
    if (!checks.every((c) => c.ok)) {
      await ctx.answerCbQuery('❌ လိုအပ်ချက် မပြည့်မီသေးပါ', { show_alert: true });
      const view = await buildUserView(ctx);
      if (view) await editOrReply(ctx, view.text, view.keyboard);
      return;
    }

    // 2. Claim record FIRST — unique index blocks double claims
    let claim;
    try {
      claim = await AccountGiveawayClaim.create({ giveawayId: ga._id, telegramId: ctx.from.id });
    } catch (err) {
      if (err?.code === 11000) {
        return ctx.answerCbQuery('✅ သင် ရယူပြီးသားပါ — /myaccounts မှာကြည့်ပါ', { show_alert: true });
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

    // 4. Claim a credential atomically
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
      await AccountGiveaway.updateOne({ _id: ga._id }, { $inc: { claimedCount: -1 } }).catch(() => {});
      return ctx.answerCbQuery('😢 Stock ကုန်သွားပါပြီ', { show_alert: true });
    }

    await AccountGiveawayClaim.updateOne({ _id: claim._id }, { $set: { credentialId: cred._id } }).catch(() => {});
    await ctx.answerCbQuery('🎉 ရပါပြီ!');
    await auditLog(ctx.from.id, 'CLAIM_GIVEAWAY_ACCOUNT', cred._id.toString(), 'System', {
      product: `${p.serviceName} ${p.planLabel}`, giveawayId: ga._id.toString(),
    });

    // 5. Deliver (plain-text fallback — never roll back after credential assigned)
    try {
      await ctx.reply(
        `🎉 *အခမဲ့ ရယူမှု အောင်မြင်ပါသည်!*\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
          `${p.emoji} *${esc(p.serviceName)}* — ${esc(p.planLabel)}\n\n` +
          `📧 Login: \`${cleanCred(cred.loginId)}\`\n` +
          `🔑 Password: \`${cleanCred(cred.password)}\`\n` +
          (cred.note ? `📝 ${esc(cred.note)}\n` : '') +
          `\n⏳ သက်တမ်းကုန်: *${fmtDate(cred.expiresAt)}* (${p.durationDays} ရက်)\n` +
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

    // 6. Auto-end when quota reached or stock exhausted + notify admin
    const stockLeft = await AccountCredential.countAvailable(p._id);
    const quotaFull = updated.maxClaims > 0 && updated.claimedCount >= updated.maxClaims;
    if (quotaFull || stockLeft === 0) {
      await AccountGiveaway.updateOne({ _id: ga._id }, { $set: { isActive: false } }).catch(() => {});
    }
    try {
      const uname = ctx.from.username ? `@${ctx.from.username}` : `ID:${ctx.from.id}`;
      await ctx.telegram.sendMessage(
        config.bot.adminId,
        `🎁 *Giveaway ရယူသွားပြီ*\n\n${p.emoji} ${esc(p.serviceName)} — ${esc(p.planLabel)}\n👤 ${esc(uname)}\n` +
          `🎯 ${updated.claimedCount}${updated.maxClaims > 0 ? `/${updated.maxClaims}` : ''} ယောက်မြောက်  •  📦 stock ${stockLeft} ကျန်` +
          (quotaFull || stockLeft === 0 ? `\n\n🔴 *Giveaway အလိုအလျောက် ရပ်လိုက်ပါပြီ* (${quotaFull ? 'quota ပြည့်' : 'stock ကုန်'})` : ''),
        { parse_mode: 'Markdown' }
      );
    } catch {}
  });

  // ══ ADMIN SIDE (Owner) ══════════════════════════════════════════════════════

  bot.action('accga_admin', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const { text, keyboard } = await buildAdminGaPanel();
    await editOrReply(ctx, text, keyboard);
  });

  bot.action(/^accga_pick:(.+)$/, adminOnly(), async (ctx) => {
    const p = await AccountProduct.findById(ctx.match[1]);
    if (!p) return ctx.answerCbQuery('❌ Product မတွေ့ပါ', { show_alert: true });
    let ga = await getAdminGa();
    if (ga) {
      ga.productId = p._id;
      await ga.save();
    } else {
      ga = await AccountGiveaway.create({ productId: p._id, createdBy: ctx.from.id });
    }
    await auditLog(ctx.from.id, 'SET_GIVEAWAY_PRODUCT', ga._id.toString(), 'System', {
      product: `${p.serviceName} ${p.planLabel}`,
    });
    await ctx.answerCbQuery('✅ Product သတ်မှတ်ပြီး');
    const { text, keyboard } = await buildAdminGaPanel();
    await editOrReply(ctx, text, keyboard);
  });

  bot.action('accga_repick', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const products = await AccountProduct.find().sort({ displayOrder: 1, serviceName: 1 });
    if (!products.length) return ctx.reply('❌ Account product မရှိသေးပါ။');
    const rows = products.map((p) => [
      Markup.button.callback(`${p.emoji} ${p.serviceName} — ${p.planLabel}`, `accga_pick:${p._id}`),
    ]);
    rows.push([Markup.button.callback('🔙 Giveaway Panel', 'accga_admin')]);
    await editOrReply(ctx, `♻️ *Product ပြောင်းရန်* — အခမဲ့ပေးမယ့် product ရွေးပါ:`, Markup.inlineKeyboard(rows));
  });

  bot.action('accga_toggle', adminOnly(), async (ctx) => {
    const ga = await getAdminGa({ populate: true });
    if (!ga || !ga.productId) return ctx.answerCbQuery('❌ Giveaway မရှိသေးပါ', { show_alert: true });

    if (!ga.isActive) {
      const stock = await AccountCredential.countAvailable(ga.productId._id);
      if (stock === 0) return ctx.answerCbQuery('❌ Stock မရှိလို့ မစနိုင်ပါ — 📥 Stock အရင်ထည့်ပါ', { show_alert: true });
      if (ga.endAt && ga.endAt.getTime() <= Date.now()) {
        return ctx.answerCbQuery('❌ နောက်ဆုံးရက် ကျော်နေပါပြီ — ⏰ ရက် ပြန်သတ်မှတ်ပါ', { show_alert: true });
      }
      // deactivate any other active giveaway to satisfy the unique index
      await AccountGiveaway.updateMany({ isActive: true }, { $set: { isActive: false } });
      ga.isActive = true;
    } else {
      ga.isActive = false;
    }
    await ga.save();
    await auditLog(ctx.from.id, 'TOGGLE_GIVEAWAY', ga._id.toString(), 'System', { isActive: ga.isActive });
    await ctx.answerCbQuery(ga.isActive ? '🟢 စတင်ပြီး!' : '🔴 ရပ်လိုက်ပြီ');
    const { text, keyboard } = await buildAdminGaPanel();
    await editOrReply(ctx, text, keyboard);
  });

  bot.action('accga_purch', adminOnly(), async (ctx) => {
    const ga = await getAdminGa();
    if (!ga) return ctx.answerCbQuery('❌ Giveaway မရှိသေးပါ', { show_alert: true });
    ga.requirePurchase = !ga.requirePurchase;
    await ga.save();
    await ctx.answerCbQuery(ga.requirePurchase ? '🛒 ဝယ်ဖူးမှ ရမယ် — ON' : '🛒 OFF');
    const { text, keyboard } = await buildAdminGaPanel();
    await editOrReply(ctx, text, keyboard);
  });

  // ── Text-input settings (reply-targeted wizard) ────────────────────────────

  async function promptGaValue(ctx, field, promptText) {
    ctx.session.accAdmin = null; // isolate from the accounts.js admin wizard
    const prompt = await ctx.reply(promptText, { parse_mode: 'Markdown', ...Markup.forceReply() });
    ctx.session.accGaWiz = { field, promptId: prompt.message_id };
  }

  bot.action('accga_max', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await promptGaValue(ctx, 'max',
      `📦 *ဘယ်နှစ်ယောက် ရနိုင်မလဲ?*\n\nကိန်းဂဏန်း ရိုက်ပါ (ဥပမာ \`50\`)\n\`0\` = မကန့်သတ် (stock ကုန်သည်အထိ)`);
  });

  bot.action('accga_days', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await promptGaValue(ctx, 'days',
      `⏰ *ဘယ်နှစ်ရက်ကြာ ဖွင့်ထားမလဲ?*\n\nဒီနေ့ကစပြီး ရက်အရေအတွက် ရိုက်ပါ (ဥပမာ \`7\`)\n\`0\` = အချိန် မကန့်သတ်`);
  });

  bot.action('accga_age', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await promptGaValue(ctx, 'age',
      `📅 *Telegram account သက်တမ်း အနည်းဆုံး ဘယ်နှစ်ရက်လဲ?*\n\n(account အသစ်စက်စက်တွေ မရအောင် — ဥပမာ \`30\`)\n\`0\` = မစစ်`);
  });

  bot.on('text', async (ctx, next) => {
    const wiz = ctx.session?.accGaWiz;
    if (!wiz) return next();
    if (ctx.from.id !== config.bot.adminId) return next();
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
    const ga = await getAdminGa();
    if (!ga) return ctx.reply('❌ Giveaway မရှိတော့ပါ။');

    if (wiz.field === 'max') {
      ga.maxClaims = n;
    } else if (wiz.field === 'days') {
      ga.endAt = n > 0 ? new Date(Date.now() + n * DAY_MS) : null;
    } else if (wiz.field === 'age') {
      ga.minAccountAgeDays = n;
    }
    await ga.save();
    await auditLog(ctx.from.id, 'SET_GIVEAWAY_RESTRICTION', ga._id.toString(), 'System', { field: wiz.field, value: n });

    const { text, keyboard } = await buildAdminGaPanel();
    return ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  });

  // ── Channel join requirement ────────────────────────────────────────────────

  bot.action('accga_chan', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const channels = await getKnownChannels();
    const rows = channels.slice(0, 15).map((c) => [
      Markup.button.callback(`📣 ${c.title || c.chatId}`, `accga_chansel:${c.chatId}`),
    ]);
    rows.push([Markup.button.callback('🚫 Channel join မလိုတော့ဘူး', 'accga_chanoff')]);
    rows.push([Markup.button.callback('🔙 Giveaway Panel', 'accga_admin')]);
    await editOrReply(
      ctx,
      `📣 *Channel join လိုအပ်ချက်*\n\nJoin ထားမှရမယ့် channel ကို ရွေးပါ:\n_(Channel အသစ်ထည့်ချင်ရင် /channels မှာ အရင်ထည့်ပါ။ Bot က channel admin ဖြစ်ရပါမယ် — မဟုတ်ရင် member စစ်လို့မရပါ။)_`,
      Markup.inlineKeyboard(rows)
    );
  });

  bot.action(/^accga_chansel:(-?\d+)$/, adminOnly(), async (ctx) => {
    const chatId = Number(ctx.match[1]);
    const ga = await getAdminGa();
    if (!ga) return ctx.answerCbQuery('❌ Giveaway မရှိသေးပါ', { show_alert: true });

    let title = String(chatId);
    try {
      const chat = await ctx.telegram.getChat(chatId);
      title = chat.title || chat.username || title;
    } catch {
      return ctx.answerCbQuery('❌ Channel ကို bot က မမြင်ရပါ — bot ကို channel admin ထားပေးပါ', { show_alert: true });
    }

    ga.requireChannelId = chatId;
    ga.requireChannelTitle = title;
    await ga.save();
    await auditLog(ctx.from.id, 'SET_GIVEAWAY_CHANNEL', ga._id.toString(), 'System', { chatId, title });
    await ctx.answerCbQuery('📣 သတ်မှတ်ပြီး');
    const { text, keyboard } = await buildAdminGaPanel();
    await editOrReply(ctx, text, keyboard);
  });

  bot.action('accga_chanoff', adminOnly(), async (ctx) => {
    const ga = await getAdminGa();
    if (!ga) return ctx.answerCbQuery('❌ Giveaway မရှိသေးပါ', { show_alert: true });
    ga.requireChannelId = null;
    ga.requireChannelTitle = '';
    await ga.save();
    await ctx.answerCbQuery('🚫 Channel လိုအပ်ချက် ဖြုတ်ပြီး');
    const { text, keyboard } = await buildAdminGaPanel();
    await editOrReply(ctx, text, keyboard);
  });

  // ── Delete ──────────────────────────────────────────────────────────────────

  bot.action('accga_del', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      `🗑 *Giveaway ကို ဖျက်မှာ သေချာလား?*\n\n_ရယူပြီးသား user တွေရဲ့ account တွေကတော့ သူတို့ဆီမှာ ဆက်ရှိနေပါမယ်။_`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ ဖျက်မယ်', 'accga_delyes')],
          [Markup.button.callback('❌ မဖျက်တော့ဘူး', 'accga_admin')],
        ]),
      }
    );
  });

  bot.action('accga_delyes', adminOnly(), async (ctx) => {
    const ga = await getAdminGa();
    if (!ga) return ctx.answerCbQuery('❌ မရှိတော့ပါ', { show_alert: true });
    await AccountGiveaway.deleteOne({ _id: ga._id });
    await auditLog(ctx.from.id, 'DELETE_GIVEAWAY', ga._id.toString(), 'System', {});
    await ctx.answerCbQuery('🗑 ဖျက်ပြီးပါပြီ');
    const { text, keyboard } = await buildAdminGaPanel();
    await editOrReply(ctx, text, keyboard);
  });

  // ── Announce to all users + announcement channel ────────────────────────────

  bot.action('accga_announce', adminOnly(), async (ctx) => {
    const ga = await AccountGiveaway.getActive();
    if (!ga || !ga.productId) return ctx.answerCbQuery('❌ ဖွင့်ထားတဲ့ giveaway မရှိပါ', { show_alert: true });
    const p = ga.productId;
    await ctx.answerCbQuery();

    const progress = await ctx.reply('📤 ကြေညာနေပါတယ်…');

    const body =
      `🎁 *အခမဲ့ Premium Account ရယူလိုက်ပါ!*\n\`━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
      `${p.emoji} *${esc(p.serviceName)}* — ${esc(p.planLabel)}\n` +
      `💵 တန်ဖိုး ~${Number(p.price).toLocaleString()} KS~ → *လုံးဝ အခမဲ့!*\n` +
      (ga.maxClaims > 0 ? `📦 *${ga.maxClaims} ယောက်ပဲ* ရမှာမို့ မြန်မြန်လာယူပါ!\n` : '') +
      (ga.endAt ? `⏰ ${fmtDate(ga.endAt)} နောက်ဆုံး!\n` : '');

    // 1. All bot users — with claim button
    const { sent, failed } = await broadcastToUsers(ctx.telegram, body, {
      ...Markup.inlineKeyboard([[Markup.button.callback('🎁 အခမဲ့ ရယူမယ်', 'accga_free')]]),
    });

    // 2. Announcement channel — with bot deep link
    let channelOk = false;
    try {
      const ss = await SystemStatus.get();
      if (ss.announcementChannelId) {
        const me = ctx.botInfo?.username || (await ctx.telegram.getMe()).username;
        await ctx.telegram.sendMessage(ss.announcementChannelId, body + `\n👇 Bot ထဲဝင်ပြီး ရယူလိုက်ပါ:`, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.url('🤖 Bot ဖွင့်မယ်', `https://t.me/${me}?start=freebie`)]]),
        });
        channelOk = true;
      }
    } catch (e) {
      console.error('[Giveaway] channel announce failed:', e.message);
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
