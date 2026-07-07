/**
 * Promotion Perks (user + owner admin panel)
 *
 * User:
 *   /setbirthday          — save birthday (DD-MM) for the yearly MC gift
 *   /toplist              — current-month top spender leaderboard
 *
 * Owner:
 *   /promoperks           — control panel: birthday gift, happy hour,
 *                           cashback, first-order discount, win-back,
 *                           monthly leaderboard prizes
 *
 * NOTE: uses a bot.on('text') prompt-state handler — this file MUST be loaded
 * before ambient.js in the ORDER array.
 */

const { Markup } = require('telegraf');
const User = require('../models/User');
const SystemStatus = require('../models/SystemStatus');
const { adminOnly } = require('../middlewares/adminCheck');
const { auditLog } = require('../services/logger');
const { config } = require('../../config/settings');
const PromoPerks = require('../services/PromoPerksService');

function esc(s) {
  return String(s == null ? '' : s).replace(/([_*`\[])/g, '\\$1');
}

// per-admin/user pending text prompt state
const pending = new Map(); // telegramId -> { action }

// ── Panel builder ────────────────────────────────────────────────────────────
async function buildPanel() {
  const st = await SystemStatus.get();
  const onOff = (b) => (b ? '🟢 ON' : '🔴 OFF');
  const text =
    `🎁 *Promotion Perks Panel*\n\n` +
    `🎂 *Birthday Gift:* ${st.birthdayGiftMC > 0 ? `${st.birthdayGiftMC.toLocaleString()} MC` : '🔴 OFF'}\n` +
    `⏰ *Happy Hour:* ${onOff(st.happyHourEnabled)} — ${String(st.happyHourStartMMT).padStart(2, '0')}:00–${String(st.happyHourEndMMT).padStart(2, '0')}:00 MMT, +${st.happyHourBonusPct}% MC${PromoPerks.isHappyHourNow(st) ? ' _(အခု active!)_' : ''}\n` +
    `💸 *Cashback:* ${st.cashbackPct > 0 ? `${st.cashbackPct}% MC` : '🔴 OFF'}\n` +
    `🛒 *First Order Discount:* ${st.firstOrderDiscountPct > 0 ? `${st.firstOrderDiscountPct}%` : '🔴 OFF'}\n` +
    `😴 *Win-back:* ${onOff(st.winbackEnabled)} — ${st.winbackDays} ရက် idle, +${(st.winbackBonusMC || 0).toLocaleString()} MC\n` +
    `📊 *Monthly Leaderboard:* ${onOff(st.leaderboardEnabled)} — ဆု: ${(st.leaderboardPrizes || []).map((p) => p.toLocaleString()).join(' / ')} MC\n` +
    `🎟 *Top-up Coupon:* ${onOff(st.topupCouponEnabled)} — ${(st.topupCouponMinKS || 0).toLocaleString()} KS+ ဖြည့်ရင် ${st.topupCouponType === 'Flat' ? `${(st.topupCouponValue || 0).toLocaleString()} KS` : `${st.topupCouponValue || 0}%`} coupon (${st.topupCouponExpiryDays || 7} ရက်သက်တမ်း)\n\n` +
    `_ပြင်ချင်တဲ့အရာကို နှိပ်ပါ:_`;

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('🎂 Birthday MC', 'pp_birthday'), Markup.button.callback('💸 Cashback %', 'pp_cashback')],
    [Markup.button.callback(`⏰ Happy Hour ${st.happyHourEnabled ? 'OFF' : 'ON'}`, 'pp_hh_toggle'), Markup.button.callback('⏰ HH အချိန်/%', 'pp_hh_set')],
    [Markup.button.callback('🛒 First Order %', 'pp_fo'), Markup.button.callback(`😴 Win-back ${st.winbackEnabled ? 'OFF' : 'ON'}`, 'pp_wb_toggle')],
    [Markup.button.callback('😴 WB ရက်/MC', 'pp_wb_set'), Markup.button.callback(`📊 Leaderboard ${st.leaderboardEnabled ? 'OFF' : 'ON'}`, 'pp_lb_toggle')],
    [Markup.button.callback('📊 LB ဆုများ', 'pp_lb_set'), Markup.button.callback('📊 ယခုလ Top 10', 'pp_lb_view')],
    [Markup.button.callback(`🎟 Topup Coupon ${st.topupCouponEnabled ? 'OFF' : 'ON'}`, 'pp_tc_toggle'), Markup.button.callback('🎟 TC ပြင်မယ်', 'pp_tc_set')],
    [Markup.button.callback('❌ Close', 'pp_close')],
  ]);
  return { text, kb };
}

async function showPanel(ctx, edit = false) {
  const { text, kb } = await buildPanel();
  const opts = { parse_mode: 'Markdown', ...kb };
  if (edit) {
    await ctx.editMessageText(text, opts).catch(() => ctx.reply(text, opts));
  } else {
    await ctx.reply(text, opts);
  }
}

// ── Leaderboard text (shared user/admin) ─────────────────────────────────────
async function leaderboardText(forTelegramId = null) {
  const st = await SystemStatus.get();
  const { start, end, year, month } = PromoPerks.currentMonthBounds();
  const top = await PromoPerks.getTopSpenders(start, end, 10);
  const medals = ['🥇', '🥈', '🥉'];
  const prizes = st.leaderboardPrizes || [];

  let lines;
  if (!top.length) {
    lines = ['_ဒီလအတွက် order မရှိသေးပါ။_'];
  } else {
    lines = top.map((r, i) => {
      const tag = medals[i] || `${i + 1}.`;
      const me = forTelegramId && r.user.telegramId === forTelegramId ? ' ⬅️ _သင်_' : '';
      const prize = st.leaderboardEnabled && prizes[i] > 0 ? ` (ဆု ${prizes[i].toLocaleString()} MC)` : '';
      return `${tag} ${esc(PromoPerks.maskName(r.user))} — *${r.total.toLocaleString()} KS*${prize}${me}`;
    });
  }

  return (
    `📊 *${month}/${year} — Top Spenders*\n\n` +
    lines.join('\n') +
    (st.leaderboardEnabled
      ? `\n\n🏆 _လကုန်ရင် ထိပ်ဆုံး ${prizes.filter((p) => p > 0).length} ယောက်ကို MC ဆု အလိုအလျောက် ပေးပါမယ်!_`
      : '')
  );
}

module.exports = function registerPromoPerks(bot) {
  // ── User: /setbirthday ─────────────────────────────────────────────────────
  bot.command('setbirthday', async (ctx) => {
    pending.set(ctx.from.id, { action: 'user_birthday' });
    await ctx.reply(
      `🎂 *မွေးနေ့ သတ်မှတ်မယ်*\n\nမွေးနေ့ကို \`ရက်-လ\` ပုံစံနဲ့ ရိုက်ပါ (ဥပမာ \`25-12\` = ဒီဇင်ဘာ ၂၅)`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── User: /toplist ─────────────────────────────────────────────────────────
  bot.command('toplist', async (ctx) => {
    const text = await leaderboardText(ctx.from.id);
    await ctx.reply(text, { parse_mode: 'Markdown' });
  });

  // ── Owner: /promoperks ─────────────────────────────────────────────────────
  bot.command('promoperks', adminOnly(), async (ctx) => showPanel(ctx));

  // ── Toggles ────────────────────────────────────────────────────────────────
  bot.action('pp_hh_toggle', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const st = await SystemStatus.get();
    await SystemStatus.set({ happyHourEnabled: !st.happyHourEnabled }, ctx.from.id);
    await auditLog(ctx.from.id, 'PROMO_PERKS_UPDATE', 'happyHourEnabled', 'System', { value: !st.happyHourEnabled });
    await showPanel(ctx, true);
  });

  bot.action('pp_wb_toggle', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const st = await SystemStatus.get();
    await SystemStatus.set({ winbackEnabled: !st.winbackEnabled }, ctx.from.id);
    await auditLog(ctx.from.id, 'PROMO_PERKS_UPDATE', 'winbackEnabled', 'System', { value: !st.winbackEnabled });
    await showPanel(ctx, true);
  });

  bot.action('pp_lb_toggle', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const st = await SystemStatus.get();
    await SystemStatus.set({ leaderboardEnabled: !st.leaderboardEnabled }, ctx.from.id);
    await auditLog(ctx.from.id, 'PROMO_PERKS_UPDATE', 'leaderboardEnabled', 'System', { value: !st.leaderboardEnabled });
    await showPanel(ctx, true);
  });

  bot.action('pp_tc_toggle', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const st = await SystemStatus.get();
    if (!st.topupCouponEnabled && !(st.topupCouponValue > 0)) {
      return ctx.answerCbQuery('❌ အရင် "🎟 TC ပြင်မယ်" နဲ့ တန်ဖိုးသတ်မှတ်ပါ', { show_alert: true });
    }
    await SystemStatus.set({ topupCouponEnabled: !st.topupCouponEnabled }, ctx.from.id);
    await auditLog(ctx.from.id, 'PROMO_PERKS_UPDATE', 'topupCouponEnabled', 'System', { value: !st.topupCouponEnabled });
    await showPanel(ctx, true);
  });

  bot.action('pp_lb_view', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(await leaderboardText(), { parse_mode: 'Markdown' });
  });

  bot.action('pp_close', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  });

  // ── Value prompts ──────────────────────────────────────────────────────────
  const prompts = {
    pp_birthday: { action: 'birthday_mc', msg: '🎂 မွေးနေ့လက်ဆောင် MC ပမာဏ ရိုက်ပါ (0 = ပိတ်မယ်)\nဥပမာ: `500`' },
    pp_cashback: { action: 'cashback_pct', msg: '💸 Cashback % ရိုက်ပါ (0 = ပိတ်မယ်, အများဆုံး 100)\nဥပမာ: `2`' },
    pp_hh_set: { action: 'hh_set', msg: '⏰ Happy Hour ကို `စ-ဆုံး-%` ပုံစံနဲ့ ရိုက်ပါ (MMT နာရီ 0–23)\nဥပမာ: `18-20-5` = ညနေ 6–8 နာရီ +5%' },
    pp_fo: { action: 'fo_pct', msg: '🛒 ပထမဆုံး order discount % ရိုက်ပါ (0 = ပိတ်မယ်, အများဆုံး 90)\nဥပမာ: `10`' },
    pp_wb_set: { action: 'wb_set', msg: '😴 Win-back ကို `ရက်-MC` ပုံစံနဲ့ ရိုက်ပါ\nဥပမာ: `30-300` = ရက် 30 idle ရင် 300 MC နဲ့ ပြန်ခေါ်' },
    pp_lb_set: { action: 'lb_set', msg: '📊 လစဉ်ဆုများကို space ခြားပြီး ရိုက်ပါ (No.1 က အရင်)\nဥပမာ: `3000 2000 1000`' },
    pp_tc_set: { action: 'tc_set', msg: '🎟 Top-up coupon ကို `အနည်းဆုံးKS-pct/flat-တန်ဖိုး-ရက်` ပုံစံနဲ့ ရိုက်ပါ\nဥပမာ: `10000-pct-5-7` = 10,000 KS+ ဖြည့်ရင် 5% coupon (7 ရက်သက်တမ်း)\nဥပမာ: `20000-flat-1000-14` = 1,000 KS လျှော့ coupon' },
  };

  for (const [act, def] of Object.entries(prompts)) {
    bot.action(act, adminOnly(), async (ctx) => {
      await ctx.answerCbQuery();
      pending.set(ctx.from.id, { action: def.action });
      await ctx.reply(def.msg, { parse_mode: 'Markdown' });
    });
  }

  // ── Text handler (prompt replies) — must precede ambient ──────────────────
  bot.on('text', async (ctx, next) => {
    const st = pending.get(ctx.from.id);
    if (!st) return next();
    const raw = ctx.message.text.trim();
    if (raw.startsWith('/')) { pending.delete(ctx.from.id); return next(); }

    // user birthday — available to everyone
    if (st.action === 'user_birthday') {
      const m = raw.match(/^(\d{1,2})[-/.](\d{1,2})$/);
      if (!m) return ctx.reply('❌ ပုံစံမှားနေပါတယ် — `ရက်-လ` (ဥပမာ `25-12`) လို့ ရိုက်ပါ။', { parse_mode: 'Markdown' });
      const day = parseInt(m[1], 10);
      const month = parseInt(m[2], 10);
      if (month < 1 || month > 12 || day < 1 || day > 31) {
        return ctx.reply('❌ ရက်/လ မမှန်ပါ — ထပ်ရိုက်ကြည့်ပါ။');
      }
      pending.delete(ctx.from.id);
      await User.updateOne(
        { telegramId: ctx.from.id },
        { $set: { birthdayDay: day, birthdayMonth: month } }
      );
      const status = await SystemStatus.get();
      return ctx.reply(
        `✅ မွေးနေ့ မှတ်ထားပြီးပါပြီ — *${day}/${month}* 🎂` +
          (status.birthdayGiftMC > 0
            ? `\nမွေးနေ့ရောက်ရင် *${status.birthdayGiftMC.toLocaleString()} MC* လက်ဆောင် အလိုအလျောက် ရပါမယ် 🎁`
            : ''),
        { parse_mode: 'Markdown' }
      );
    }

    // owner-only settings below
    if (ctx.from.id !== config.bot.adminId) return next();

    const num = (v, min, max) => {
      const n = parseInt(v, 10);
      return Number.isFinite(n) && n >= min && n <= max ? n : null;
    };
    const done = async (fields, label) => {
      pending.delete(ctx.from.id);
      await SystemStatus.set(fields, ctx.from.id);
      await auditLog(ctx.from.id, 'PROMO_PERKS_UPDATE', label, 'System', fields);
      await ctx.reply('✅ သိမ်းပြီးပါပြီ!');
      return showPanel(ctx);
    };

    switch (st.action) {
      case 'birthday_mc': {
        const n = num(raw, 0, 1_000_000);
        if (n === null) return ctx.reply('❌ 0 နဲ့အထက် ကိန်းဂဏန်းပဲ ရိုက်ပါ။');
        return done({ birthdayGiftMC: n }, 'birthdayGiftMC');
      }
      case 'cashback_pct': {
        const n = num(raw, 0, 100);
        if (n === null) return ctx.reply('❌ 0–100 ကြားပဲ ရိုက်ပါ။');
        return done({ cashbackPct: n }, 'cashbackPct');
      }
      case 'fo_pct': {
        const n = num(raw, 0, 90);
        if (n === null) return ctx.reply('❌ 0–90 ကြားပဲ ရိုက်ပါ။');
        return done({ firstOrderDiscountPct: n }, 'firstOrderDiscountPct');
      }
      case 'hh_set': {
        const m = raw.match(/^(\d{1,2})\s*-\s*(\d{1,2})\s*-\s*(\d{1,3})$/);
        if (!m) return ctx.reply('❌ `စ-ဆုံး-%` ပုံစံ (ဥပမာ `18-20-5`) နဲ့ ရိုက်ပါ။', { parse_mode: 'Markdown' });
        const s = num(m[1], 0, 23), e = num(m[2], 0, 23), p = num(m[3], 0, 100);
        if (s === null || e === null || p === null) return ctx.reply('❌ နာရီ 0–23, % 0–100 ကြားပဲ ရပါတယ်။');
        if (s === e) return ctx.reply('❌ စချိန်နဲ့ ဆုံးချိန် မတူရပါ။');
        return done({ happyHourStartMMT: s, happyHourEndMMT: e, happyHourBonusPct: p, happyHourEnabled: true }, 'happyHour');
      }
      case 'wb_set': {
        const m = raw.match(/^(\d{1,4})\s*-\s*(\d{1,7})$/);
        if (!m) return ctx.reply('❌ `ရက်-MC` ပုံစံ (ဥပမာ `30-300`) နဲ့ ရိုက်ပါ။', { parse_mode: 'Markdown' });
        const d = num(m[1], 7, 3650), b = num(m[2], 0, 1_000_000);
        if (d === null || b === null) return ctx.reply('❌ ရက်က အနည်းဆုံး 7 ဖြစ်ရပါမယ်။');
        return done({ winbackDays: d, winbackBonusMC: b, winbackEnabled: true }, 'winback');
      }
      case 'tc_set': {
        const m = raw.match(/^(\d{1,9})\s*-\s*(pct|flat)\s*-\s*(\d{1,7})\s*-\s*(\d{1,4})$/i);
        if (!m) return ctx.reply('❌ `အနည်းဆုံးKS-pct/flat-တန်ဖိုး-ရက်` ပုံစံ (ဥပမာ `10000-pct-5-7`) နဲ့ ရိုက်ပါ။', { parse_mode: 'Markdown' });
        const minKS = num(m[1], 0, 100_000_000);
        const type = m[2].toLowerCase() === 'flat' ? 'Flat' : 'Percentage';
        const value = num(m[3], 1, type === 'Percentage' ? 90 : 1_000_000);
        const days = num(m[4], 1, 365);
        if (minKS === null || value === null || days === null) {
          return ctx.reply('❌ တန်ဖိုးတွေ မမှန်ပါ — % ဆိုရင် 1–90, ရက်က 1–365 ကြားဖြစ်ရပါမယ်။');
        }
        return done(
          { topupCouponEnabled: true, topupCouponMinKS: minKS, topupCouponType: type, topupCouponValue: value, topupCouponExpiryDays: days },
          'topupCoupon'
        );
      }
      case 'lb_set': {
        const parts = raw.split(/\s+/).map((v) => parseInt(v, 10));
        if (!parts.length || parts.length > 5 || parts.some((v) => !Number.isFinite(v) || v < 0)) {
          return ctx.reply('❌ ဆု 1–5 ခုကို space ခြားပြီး ရိုက်ပါ (ဥပမာ `3000 2000 1000`)။', { parse_mode: 'Markdown' });
        }
        return done({ leaderboardPrizes: parts, leaderboardEnabled: true }, 'leaderboardPrizes');
      }
      default:
        pending.delete(ctx.from.id);
        return next();
    }
  });
};
