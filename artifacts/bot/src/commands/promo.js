/**
 * Promo Code Commands
 *
 * User: /promo <code> — validate and preview discount
 * Admin: /createpromo — create new promo code (guided)
 *        /listpromos — show all active promos
 *        /deletepromo <code> — deactivate a promo
 */

const { Markup } = require('telegraf');
const { adminOnly } = require('../middlewares/adminCheck');
const {
  validatePromo, createPromo, listPromos, deactivatePromo,
  generateCoupon, listUserCoupons, scopeText, discountText,
} = require('../services/PromoService');
const { price } = require('../utils/ui');

// Escape legacy-Markdown special chars in dynamic text
function escMd(s) {
  return String(s == null ? '' : s).replace(/([_*`\[])/g, '\\$1');
}
const { config } = require('../../config/settings');

module.exports = function registerPromo(bot) {

  bot.hears(['🎟 Promo', '🎟 ပရိုမို'], async (ctx) => {
    const { t } = require('../utils/i18n');
    await ctx.reply(
      `${t(ctx, 'promo.title')}\n\n${t(ctx, 'promo.instructions')}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🎟 Enter Promo Code', 'promo_enter')],
          [Markup.button.callback('💼 My Coupons',       'promo_my_coupons')],
          [Markup.button.callback('🛒 Go to Shop',       'nav:go:shop')],
        ]),
      }
    );
  });

  // Inline entry — ask user to type the code
  bot.action('promo_enter', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.awaitingPromoCode = true;
    await ctx.reply(
      '🎟 Promo code ကို ရိုက်ထည့်ပါ:\n_(မလုပ်တော့ရင် `cancel` လို့ ရိုက်ပါ)_',
      { parse_mode: 'Markdown', ...Markup.forceReply() }
    );
  });

  // Inline — show my coupons
  bot.action('promo_my_coupons', async (ctx) => {
    await ctx.answerCbQuery();
    return sendMyCoupons(ctx);
  });

  // Capture typed promo code from inline entry
  bot.on('text', async (ctx, next) => {
    if (!ctx.session?.awaitingPromoCode) return next();
    if (ctx.message?.text?.startsWith('/')) return next();
    ctx.session.awaitingPromoCode = false;
    const raw = ctx.message.text.trim();
    if (/^(skip|cancel|no|မလုပ်တော့|ထား)$/i.test(raw)) {
      return ctx.reply('👌 ပယ်ဖျက်လိုက်ပါပြီ။');
    }
    const code = raw.toUpperCase();
    const result = await validatePromo(code, ctx.from.id, Infinity);
    if (!result.valid) return ctx.reply(`❌ *${code}*: ${result.error}`, { parse_mode: 'Markdown' });
    const p = result.promo;
    const disc = p.discountType === 'Flat' ? `${price(p.value)} off` : `${p.value}% off`;
    return ctx.reply(
      `✅ *${p.code}* — *${disc}*` +
      (p.minOrderAmount > 0 ? `\nMin order: ${price(p.minOrderAmount)}` : '') +
      `\n\nApply this code at checkout.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('🛒 Go to Shop', 'nav:go:shop')]]),
      }
    );
  });

  // ── User: check a promo code ───────────────────────────────────────────────
  bot.command('promo', async (ctx) => {
    const { t } = require('../utils/i18n');
    const args = ctx.message.text.split(/\s+/).slice(1);
    if (!args.length) {
      return ctx.reply(
        `${t(ctx, 'promo.title')}\n\n${t(ctx, 'promo.usage_short')}`,
        { parse_mode: 'Markdown' }
      );
    }

    const code = args[0].toUpperCase().trim();
    const result = await validatePromo(code, ctx.from.id, Infinity);

    if (!result.valid) {
      return ctx.reply(`❌ *${code}*: ${result.error}`, { parse_mode: 'Markdown' });
    }

    const p = result.promo;
    const off = t(ctx, 'promo.off');
    const discountDesc = p.discountType === 'Flat'
      ? `${price(p.value)} ${off}`
      : `${p.value}% ${off}`;

    await ctx.reply(
      `${t(ctx, 'promo.code_valid')}\n\n` +
      `🎟 ${t(ctx, 'promo.code')}: \`${p.code}\`\n` +
      `🏷 ${t(ctx, 'promo.discount')}: *${discountDesc}*\n` +
      (p.minOrderAmount > 0 ? `📋 ${t(ctx, 'promo.min_order')}: *${price(p.minOrderAmount)}*\n` : '') +
      (p.expiryDate ? `📅 ${t(ctx, 'promo.expires')}: ${new Date(p.expiryDate).toLocaleDateString('en-GB')}\n` : '') +
      `\n${t(ctx, 'promo.apply_hint')}`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Shared: list the user's usable coupons ─────────────────────────────────
  async function sendMyCoupons(ctx) {
    const User = require('../models/User');
    const user = await User.findByTelegramId(ctx.from.id);
    if (!user) return ctx.reply('❌ /start ကို အရင်နှိပ်ပါ။');

    const coupons = await listUserCoupons(user._id);
    if (!coupons.length) {
      return ctx.reply(
        `💼 *My Coupons*\n\nသုံးလို့ရတဲ့ coupon မရှိသေးပါ။\n_ငွေဖြည့်တာ / promotion တွေကနေ coupon ရနိုင်ပါတယ်_ 🎁`,
        { parse_mode: 'Markdown' }
      );
    }

    const lines = coupons.map((c) => {
      const exp = c.expiryDate ? ` — ${new Date(c.expiryDate).toLocaleDateString('en-GB')} အထိ` : '';
      return `🎟 \`${c.code}\` — *${discountText(c)}*\n   📦 ${scopeText(c)}${exp}`;
    });

    await ctx.reply(
      `💼 *My Coupons (${coupons.length})*\n\n${lines.join('\n\n')}\n\n_Order တင်တဲ့အခါ promo code အဆင့်မှာ ဒီ coupon တွေ ခလုတ်အနေနဲ့ ပေါ်ပါမယ်_ 🛒`,
      { parse_mode: 'Markdown' }
    );
  }

  // ── User: /mycoupons — list my usable coupons ──────────────────────────────
  bot.command('mycoupons', (ctx) => sendMyCoupons(ctx));

  // ── Admin: /gencoupon — auto-generate a coupon (guided) ────────────────────
  bot.command('gencoupon', adminOnly(), async (ctx) => {
    ctx.session.adminGenCoupon = { step: 'value' };
    await ctx.reply(
      `🎟 *Auto-Generate Coupon*\n\nStep 1/5: Discount ရိုက်ပါ:\n` +
        `• \`pct 10\` = 10% လျှော့\n• \`flat 500\` = 500 KS လျှော့`,
      { parse_mode: 'Markdown', ...Markup.forceReply() }
    );
  });

  // ── Admin: /createpromo ────────────────────────────────────────────────────
  bot.command('createpromo', adminOnly(), async (ctx) => {
    ctx.session.adminCreatePromo = { step: 'code' };
    await ctx.reply(
      `🎟 *Create Promo Code*\n\nStep 1/5: Enter the promo code:\n_(e.g. SAVE500, NEWUSER, FLASH10)_`,
      { parse_mode: 'Markdown', ...Markup.forceReply() }
    );
  });

  // ── Admin: /listpromos ─────────────────────────────────────────────────────
  bot.command('listpromos', adminOnly(), async (ctx) => {
    const promos = await listPromos({ activeOnly: false });
    if (!promos.length) return ctx.reply('No promo codes created yet. Use /createpromo.');

    const lines = promos.map((p) => {
      const disc = p.discountType === 'Flat' ? `${price(p.value)} off` : `${p.value}% off`;
      const uses  = p.maxUses ? `${p.currentUses}/${p.maxUses}` : `${p.currentUses}/∞`;
      const status = p.isActive ? '🟢' : '🔴';
      return `${status} \`${p.code}\` — ${disc} — Uses: ${uses}`;
    });

    await ctx.reply(`🎟 *All Promo Codes (${promos.length})*\n\n${lines.join('\n')}`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('➕ Create New', 'promo_create_start')]]),
    });
  });

  bot.action('promo_create_start', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.adminCreatePromo = { step: 'code' };
    await ctx.reply(`Step 1/5: Enter the promo code:`, { ...Markup.forceReply() });
  });

  // ── Admin: /deletepromo ────────────────────────────────────────────────────
  bot.command('deletepromo', adminOnly(), async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    if (!args.length) return ctx.reply('Usage: /deletepromo CODENAME');

    try {
      const promo = await deactivatePromo(args[0], ctx.from.id);
      await ctx.reply(`✅ Promo \`${promo.code}\` deactivated.`, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  // ── Multi-step auto-coupon generation interceptor ──────────────────────────
  bot.on('text', async (ctx, next) => {
    const state = ctx.session?.adminGenCoupon;
    if (!state || ctx.from.id !== config.bot.adminId) return next();
    const input = ctx.message.text.trim();
    if (input.startsWith('/')) { ctx.session.adminGenCoupon = null; return next(); }

    if (state.step === 'value') {
      const m = input.match(/^(pct|flat)\s+(\d+(?:\.\d+)?)$/i);
      if (!m) return ctx.reply('❌ `pct 10` (10%) သို့ `flat 500` (500 KS) ပုံစံနဲ့ ရိုက်ပါ:', { parse_mode: 'Markdown' });
      state.discountType = m[1].toLowerCase() === 'flat' ? 'Flat' : 'Percentage';
      state.value = parseFloat(m[2]);
      if (state.discountType === 'Percentage' && (state.value <= 0 || state.value > 90)) {
        return ctx.reply('❌ % က 1–90 ကြားပဲ ရပါတယ်:');
      }
      state.step = 'scope';
      await ctx.reply(
        `Step 2/5: ဘယ်ပစ္စည်းတွေမှာ သုံးလို့ရမလဲ?\n\n` +
          `• \`all\` — ပစ္စည်းအားလုံး\n` +
          `• \`cat MLBB, PUBG\` — category အလိုက်\n` +
          `• \`prod diamond\` — product နာမည်ရှာပြီး ကိုက်တဲ့ဟာတွေ`,
        { parse_mode: 'Markdown', ...Markup.forceReply() }
      );

    } else if (state.step === 'scope') {
      const lower = input.toLowerCase();
      if (lower === 'all') {
        state.scopeType = 'all';
        state.scopeCategories = [];
        state.scopeProducts = [];
        state.scopeLabel = 'All products';
      } else if (lower.startsWith('cat ')) {
        const cats = input.slice(4).split(',').map((s) => s.trim()).filter(Boolean);
        if (!cats.length) return ctx.reply('❌ `cat MLBB, PUBG` လို ရိုက်ပါ:', { parse_mode: 'Markdown' });
        state.scopeType = 'category';
        state.scopeCategories = cats;
        state.scopeProducts = [];
        state.scopeLabel = cats.join(', ');
      } else if (lower.startsWith('prod ')) {
        const q = input.slice(5).trim();
        if (!q) return ctx.reply('❌ `prod <နာမည်>` လို ရိုက်ပါ:', { parse_mode: 'Markdown' });
        const Product = require('../models/Product');
        const prods = await Product.find({
          name: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' },
          isActive: { $ne: false },
        }).limit(20);
        if (!prods.length) return ctx.reply(`❌ "${q}" နဲ့ ကိုက်တဲ့ product မတွေ့ပါ — ထပ်ရှာကြည့်ပါ:`);
        state.scopeType = 'product';
        state.scopeCategories = [];
        state.scopeProducts = prods.map((p) => p._id);
        state.scopeLabel = prods.map((p) => p.name).slice(0, 5).join(', ') + (prods.length > 5 ? ` +${prods.length - 5}` : '');
        await ctx.reply(`✅ Product ${prods.length} ခု ကိုက်ပါတယ်:\n${prods.map((p) => `• ${p.name}`).join('\n')}`);
      } else {
        return ctx.reply('❌ `all`, `cat ...`, သို့ `prod ...` နဲ့ စရပါမယ်:', { parse_mode: 'Markdown' });
      }
      state.step = 'maxUses';
      await ctx.reply(`Step 3/5: လူဘယ်နှစ်ယောက်စာလဲ? (စုစုပေါင်း အသုံးပြုနိုင်မယ့် အကြိမ်; \`unlimited\` လည်း ရ):`, { parse_mode: 'Markdown', ...Markup.forceReply() });

    } else if (state.step === 'maxUses') {
      if (input.toLowerCase() === 'unlimited') {
        state.maxUses = null;
      } else {
        const n = parseInt(input, 10);
        if (!Number.isFinite(n) || n < 1) return ctx.reply('❌ 1 နဲ့အထက် ကိန်း သို့ `unlimited` ရိုက်ပါ:', { parse_mode: 'Markdown' });
        state.maxUses = n;
      }
      state.step = 'perUser';
      await ctx.reply(`Step 4/5: အကောင့်တစ်ခုက ဘယ်နှစ်ခါ သုံးလို့ရမလဲ? (များသောအားဖြင့် \`1\`):`, { parse_mode: 'Markdown', ...Markup.forceReply() });

    } else if (state.step === 'perUser') {
      const n = parseInt(input, 10);
      if (!Number.isFinite(n) || n < 1 || n > 100) return ctx.reply('❌ 1–100 ကြား ရိုက်ပါ:');
      state.perUserLimit = n;
      state.step = 'expiry';
      await ctx.reply(`Step 5/5: သက်တမ်း ဘယ်နှရက်လဲ? (ဥပမာ \`7\`; \`never\` = သက်တမ်းမကုန်):`, { parse_mode: 'Markdown', ...Markup.forceReply() });

    } else if (state.step === 'expiry') {
      let expiryDate = null;
      if (input.toLowerCase() !== 'never') {
        const days = parseInt(input, 10);
        if (!Number.isFinite(days) || days < 1 || days > 3650) return ctx.reply('❌ ရက်အရေအတွက် (1–3650) သို့ `never` ရိုက်ပါ:', { parse_mode: 'Markdown' });
        expiryDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      }
      ctx.session.adminGenCoupon = null;

      try {
        const promo = await generateCoupon(ctx.from.id, {
          discountType: state.discountType,
          value: state.value,
          maxUses: state.maxUses,
          perUserLimit: state.perUserLimit,
          expiryDate,
          scopeType: state.scopeType,
          scopeCategories: state.scopeCategories,
          scopeProducts: state.scopeProducts,
          description: `Scope: ${state.scopeLabel}`,
        });

        await ctx.reply(
          `✅ *Coupon ထုတ်ပြီးပါပြီ!*\n\n` +
            `🎟 Code: \`${promo.code}\`\n` +
            `🏷 Discount: *${discountText(promo)}*\n` +
            `📦 Scope: ${state.scopeLabel}\n` +
            `👥 စုစုပေါင်း: ${promo.maxUses || '∞'} ကြိမ် | တစ်ယောက်: ${promo.perUserLimit} ကြိမ်\n` +
            `📅 Expires: ${expiryDate ? expiryDate.toLocaleDateString('en-GB') : 'Never'}\n\n` +
            `_Channel မှာ တစ်ခါတည်း ကြေညာချင်ရင် အောက်ကခလုတ် နှိပ်ပါ_ 👇`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('📢 Channel မှာ ကြေညာမယ်', `coupon_announce:${promo._id}`)],
            ]),
          }
        );
      } catch (err) {
        await ctx.reply(`❌ ${err.message}`);
      }
    }
  });

  // ── Announce a coupon to a channel (Owner) ─────────────────────────────────
  function buildCouponAnnounce(promo) {
    return (
      `🎉 *Promo Code အသစ် ရောက်ပါပြီ!*\n\n` +
      `🎟 Code: \`${promo.code}\`\n` +
      `🏷 Discount: *${escMd(discountText(promo))}*\n` +
      `📦 သုံးလို့ရမယ့် ပစ္စည်း: ${escMd(scopeText(promo))}\n` +
      (promo.maxUses ? `👥 ဦးရေကန့်သတ်: ပထမဆုံး *${promo.maxUses}* ယောက်ပဲ ရမယ်!\n` : '') +
      (promo.expiryDate ? `📅 ${new Date(promo.expiryDate).toLocaleDateString('en-GB')} အထိပဲ ရမယ်\n` : '') +
      `\n🛒 Order တင်တဲ့အခါ Promo Code နေရာမှာ ဒီ code ကို ရိုက်ထည့်ပြီး လျှော့ဈေးယူလိုက်ပါ! 🚀`
    );
  }

  async function getActiveCoupon(promoId) {
    const Promo = require('../models/Promo');
    const promo = await Promo.findById(promoId);
    return promo && promo.isActive ? promo : null;
  }

  // Gather every channel the bot already knows about (shared registry service)
  async function getAnnounceChannelCandidates() {
    const { getKnownChannels } = require('../services/ChannelRegistryService');
    return getKnownChannels();
  }

  async function showAnnounceChannelPicker(ctx, promoId) {
    const SystemStatus = require('../models/SystemStatus');
    const st = await SystemStatus.get();
    const channels = await getAnnounceChannelCandidates();
    const savedCount = (st.couponAnnounceChannels || []).length;

    const rows = channels
      .filter((c) => `cpa_send:${promoId}:${c.chatId}`.length <= 64) // Telegram callback_data limit
      .map((c) =>
        [Markup.button.callback(`📢 ${c.title || c.chatId}`, `cpa_send:${promoId}:${c.chatId}`)]
      );
    rows.push([Markup.button.callback('➕ Channel အသစ်ထည့်ရန်', `cpa_add:${promoId}`)]);
    if (savedCount) {
      rows.push([Markup.button.callback('🗑 Channel စာရင်းက ဖျက်ရန်', `cpa_delmenu:${promoId}`)]);
    }

    await ctx.reply(
      `📢 *Channel မှာ ကြေညာမယ်*\n\n` +
        (channels.length
          ? `Bot ထဲမှာ ရှိပြီးသား channel တွေ အကုန်ပြထားပါတယ် — နှိပ်ရုံနဲ့ ကြေညာစာ ချက်ချင်း ပို့ပါမယ် 👇`
          : `Channel မရှိသေးပါဘူး — *➕ Channel အသစ်ထည့်ရန်* ကို နှိပ်ပြီး တစ်ခါ add ထားရင် နောက်တစ်ခါကစပြီး ခလုတ်နဲ့ တစ်ချက်နှိပ်ရုံပါပဲ။`),
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
    );
  }

  bot.action(/^coupon_announce:([a-f0-9]{24})$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await showAnnounceChannelPicker(ctx, ctx.match[1]);
  });

  // Send to a known channel (one tap) — identified by chatId (stable across list changes)
  bot.action(/^cpa_send:([a-f0-9]{24}):(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const [, promoId, chatId] = ctx.match;
    const candidates = await getAnnounceChannelCandidates();
    const chan = candidates.find((c) => String(c.chatId) === chatId);
    if (!chan) return ctx.reply('❌ ဒီ channel က စာရင်းထဲမှာ မရှိတော့ပါဘူး — 📢 ခလုတ်ကို ပြန်နှိပ်ပြီး အသစ်ရွေးပါ။');

    const promo = await getActiveCoupon(promoId);
    if (!promo) return ctx.reply('❌ Coupon မတွေ့ပါ (သို့) ပိတ်ထားပြီးပါပြီ။');

    try {
      await ctx.telegram.sendMessage(chan.chatId, buildCouponAnnounce(promo), { parse_mode: 'Markdown' });
      return ctx.reply(`✅ *${escMd(chan.title || chan.chatId)}* channel မှာ ကြေညာပြီးပါပြီ! 📢`, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error('[Promo] coupon announce error:', e.message);
      return ctx.reply(
        `❌ ပို့လို့မရပါ — ${escMd(e.message)}\n\n_Bot ကို channel မှာ admin အနေနဲ့ ရှိနေသေးလား စစ်ကြည့်ပါ။_`,
        { parse_mode: 'Markdown' }
      );
    }
  });

  // Add a new channel (asks for @username/ID, saves it, then sends)
  bot.action(/^cpa_add:([a-f0-9]{24})$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    // Ensure no other text wizard swallows the channel input
    ctx.session.awaitingPromoCode = false;
    ctx.session.adminCreatePromo = null;
    ctx.session.adminGenCoupon = null;
    ctx.session.adminChannelMgr = null;
    ctx.session.adminCouponAnnounce = { promoId: ctx.match[1] };
    await ctx.reply(
      `➕ *Channel အသစ်ထည့်မယ်*\n\n` +
        `Channel ရဲ့ \`@username\` (သို့) channel ID (ဥပမာ \`-1001234567890\`) ကို ရိုက်ပါ:\n` +
        `_(Bot ကို အဲဒီ channel မှာ admin အရင်ထည့်ထားရပါမယ်။ မလုပ်တော့ရင် \`cancel\` ရိုက်ပါ)_`,
      { parse_mode: 'Markdown', ...Markup.forceReply() }
    );
  });

  // Delete menu
  bot.action(/^cpa_delmenu:([a-f0-9]{24})$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const promoId = ctx.match[1];
    const SystemStatus = require('../models/SystemStatus');
    const st = await SystemStatus.get();
    const channels = st.couponAnnounceChannels || [];
    if (!channels.length) return ctx.reply('စာရင်းထဲမှာ channel မရှိပါ။');
    await ctx.reply(
      `🗑 *ဘယ် channel ကို စာရင်းက ဖျက်မလဲ?*\n_(channel ထဲက ပို့ပြီးသား စာတွေတော့ မပျက်ပါဘူး)_`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(
          channels.map((c) => [Markup.button.callback(`🗑 ${c.title || c.chatId}`, `cpa_del:${promoId}:${c.chatId}`)])
        ),
      }
    );
  });

  bot.action(/^cpa_del:([a-f0-9]{24}):(.+)$/, adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    const [, promoId, chatId] = ctx.match;
    const SystemStatus = require('../models/SystemStatus');
    const st = await SystemStatus.get();
    const removed = (st.couponAnnounceChannels || []).find((c) => String(c.chatId) === chatId);
    if (!removed) return ctx.reply('❌ ဒီ channel က စာရင်းထဲမှာ မရှိတော့ပါဘူး။');
    // Atomic pull by chatId — safe against concurrent list changes
    await SystemStatus.updateOne(
      { _id: st._id },
      { $pull: { couponAnnounceChannels: { chatId } }, $set: { updatedBy: ctx.from.id } }
    );
    await ctx.reply(`✅ *${escMd(removed.title || removed.chatId)}* ကို စာရင်းက ဖျက်လိုက်ပါပြီ။`, { parse_mode: 'Markdown' });
    await showAnnounceChannelPicker(ctx, promoId);
  });

  bot.on('text', async (ctx, next) => {
    const state = ctx.session?.adminCouponAnnounce;
    if (!state || ctx.from.id !== config.bot.adminId) return next();
    const input = ctx.message.text.trim();
    if (input.startsWith('/')) { ctx.session.adminCouponAnnounce = null; return next(); }
    if (/^cancel$/i.test(input)) {
      ctx.session.adminCouponAnnounce = null;
      return ctx.reply('👌 ပယ်ဖျက်လိုက်ပါပြီ။');
    }

    try {
      const chat = await ctx.telegram.getChat(input);
      if (chat.type !== 'channel') {
        return ctx.reply(
          `❌ ဒါက channel မဟုတ်ပါဘူး (${chat.type})။ Channel ရဲ့ @username (သို့) ID ကိုပဲ ရိုက်ပါ (သို့) \`cancel\` ရိုက်ပါ:`,
          { parse_mode: 'Markdown' }
        );
      }
      const promo = await getActiveCoupon(state.promoId);
      if (!promo) {
        ctx.session.adminCouponAnnounce = null;
        return ctx.reply('❌ Coupon မတွေ့ပါ (သို့) ပိတ်ထားပြီးပါပြီ။');
      }

      await ctx.telegram.sendMessage(chat.id, buildCouponAnnounce(promo), { parse_mode: 'Markdown' });
      ctx.session.adminCouponAnnounce = null;

      // Save channel for one-tap reuse next time (atomic guarded push, dedup by chatId)
      const SystemStatus = require('../models/SystemStatus');
      const st = await SystemStatus.get();
      const chatIdStr = String(chat.id);
      await SystemStatus.updateOne(
        { _id: st._id, 'couponAnnounceChannels.chatId': { $ne: chatIdStr } },
        {
          $push: { couponAnnounceChannels: { chatId: chatIdStr, title: chat.title || input } },
          $set: { updatedBy: ctx.from.id },
        }
      );

      return ctx.reply(
        `✅ *${escMd(chat.title || input)}* channel မှာ ကြေညာပြီးပါပြီ! 📢\n\n` +
          `💾 Channel ကို စာရင်းထဲ သိမ်းထားပေးပြီးပါပြီ — နောက်တစ်ခါ coupon ထုတ်ရင် ခလုတ်နဲ့ တစ်ချက်နှိပ်ရုံ ပို့လို့ရပါပြီ။`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      console.error('[Promo] coupon announce error:', e.message);
      return ctx.reply(
        `❌ ပို့လို့မရပါ — ${escMd(e.message)}\n\n` +
          `စစ်ရန်: ① channel ID/@username မှန်လား ② bot ကို channel မှာ admin ထည့်ထားလား\n` +
          `ထပ်ရိုက်ကြည့်ပါ (သို့) \`cancel\` ရိုက်ပါ:`,
        { parse_mode: 'Markdown' }
      );
    }
  });

  // ── Multi-step promo creation interceptor ─────────────────────────────────
  bot.on('text', async (ctx, next) => {
    const state = ctx.session?.adminCreatePromo;
    if (!state || ctx.from.id !== config.bot.adminId) return next();

    const input = ctx.message.text.trim();

    if (state.step === 'code') {
      if (!/^[A-Z0-9_]{2,20}$/i.test(input)) {
        return ctx.reply('❌ Code must be 2–20 alphanumeric characters. Try again:');
      }
      state.code = input.toUpperCase();
      state.step = 'type';
      await ctx.reply(
        `Step 2/5: Discount type?\n\nType \`flat\` (fixed KS) or \`pct\` (percentage):`,
        { parse_mode: 'Markdown', ...Markup.forceReply() }
      );

    } else if (state.step === 'type') {
      const t = input.toLowerCase();
      if (!['flat', 'pct', 'percentage'].includes(t)) {
        return ctx.reply('Type `flat` or `pct`:');
      }
      state.discountType = t === 'flat' ? 'Flat' : 'Percentage';
      state.step = 'value';
      await ctx.reply(
        `Step 3/5: Enter the discount value:\n${state.discountType === 'Flat' ? '_(e.g. 500 for 500 KS off)_' : '_(e.g. 10 for 10% off)_'}`,
        { parse_mode: 'Markdown', ...Markup.forceReply() }
      );

    } else if (state.step === 'value') {
      const val = parseFloat(input);
      if (isNaN(val) || val <= 0) return ctx.reply('❌ Enter a positive number.');
      state.value = val;
      state.step = 'uses';
      await ctx.reply(`Step 4/5: Max uses? (enter number or \`unlimited\`):`, { parse_mode: 'Markdown', ...Markup.forceReply() });

    } else if (state.step === 'uses') {
      state.maxUses = input.toLowerCase() === 'unlimited' ? null : parseInt(input, 10);
      state.step = 'expiry';
      await ctx.reply(`Step 5/5: Expiry date? (DD/MM/YYYY or \`never\`):`, { parse_mode: 'Markdown', ...Markup.forceReply() });

    } else if (state.step === 'expiry') {
      let expiryDate = null;
      if (input.toLowerCase() !== 'never') {
        const [d, m, y] = input.split('/');
        expiryDate = new Date(y, m - 1, d, 23, 59, 59);
        if (isNaN(expiryDate.getTime())) return ctx.reply('❌ Invalid date. Use DD/MM/YYYY or `never`.');
      }

      ctx.session.adminCreatePromo = null;

      try {
        const promo = await createPromo(ctx.from.id, {
          code: state.code,
          discountType: state.discountType,
          value: state.value,
          maxUses: state.maxUses,
          expiryDate,
        });

        const discDisplay = promo.discountType === 'Flat'
          ? `${price(promo.value)} off`
          : `${promo.value}% off`;

        await ctx.reply(
          `✅ *Promo Created!*\n\n` +
          `🎟 Code: \`${promo.code}\`\n` +
          `🏷 Discount: *${discDisplay}*\n` +
          `🔢 Max Uses: ${promo.maxUses || '∞'}\n` +
          `📅 Expires: ${expiryDate ? expiryDate.toLocaleDateString('en-GB') : 'Never'}`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        await ctx.reply(`❌ ${err.message}`);
      }
    }
  });
};
