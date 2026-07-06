/**
 * Coin Rewards & Redeem Codes — admin management (Owner)
 *
 * Reward Items (spend Mental Coins):
 *   /addreward   — wizard to create a reward item
 *   /listrewards — list all reward items
 *   /togglereward <id> — toggle active/hidden
 *   /delreward <id>    — delete a reward item
 *
 * Redeem Codes (free, code is the payment):
 *   /addcode   — wizard to create a redeem code
 *   /listcodes — list all redeem codes
 *   /togglecode <id> — toggle active/inactive
 *   /delcode <id>    — delete a redeem code
 */

const { Markup } = require('telegraf');
const { config } = require('../../config/settings');
const { adminOnly } = require('../middlewares/adminCheck');
const RewardItem = require('../models/RewardItem');
const RedeemCode = require('../models/RedeemCode');
const Product = require('../models/Product');
const { price } = require('../utils/ui');

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = 'GIFT';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function num(input, { allowUnlimited = false, unlimitedVal = -1, min = 0 } = {}) {
  const t = String(input).trim().toLowerCase();
  if (allowUnlimited && (t === 'unlimited' || t === '0' || t === 'none')) return unlimitedVal;
  const n = parseInt(t, 10);
  if (isNaN(n) || n < min) return null;
  return n;
}

async function sendProductPicker(ctx, prefix) {
  const products = await Product.find({ status: { $ne: 'hidden' } })
    .sort({ createdAt: -1 })
    .limit(24)
    .lean();
  if (!products.length) {
    return ctx.reply('❌ No products available. Create a product first.');
  }
  const rows = products.map((p) => [
    Markup.button.callback(`${p.name}`.slice(0, 60), `${prefix}:${p._id}`),
  ]);
  await ctx.reply('📦 Select the product to grant:', Markup.inlineKeyboard(rows));
}

// Escape legacy-Markdown metacharacters in admin-supplied names.
function esc(s) {
  return String(s == null ? '' : s).replace(/[_*`[\]]/g, '\\$&');
}

function itemGrant(it) {
  return it.rewardType === 'coupon'
    ? `🎟 ${it.couponDiscountType === 'Flat' ? price(it.couponValue) + ' off' : it.couponValue + '% off'}`
    : `📦 ${esc(it.productId?.name || '—')}`;
}

function codeGrant(c) {
  return c.rewardType === 'coupon'
    ? `🎟 ${c.couponDiscountType === 'Flat' ? price(c.couponValue) + ' off' : c.couponValue + '% off'}`
    : `📦 ${esc(c.productId?.name || '—')}`;
}

// ── Rewards home panel ─────────────────────────────────────────────────────
async function sendRewardsPanel(ctx) {
  const [itemCount, codeCount] = await Promise.all([
    RewardItem.countDocuments(),
    RedeemCode.countDocuments(),
  ]);
  await ctx.reply(
    `🎁 *Coin Rewards & Redeem Codes*\n\n` +
    `• *Reward Items* — ဝယ်သူ Mental Coin သုံးပြီး လဲယူ\n` +
    `• *Redeem Codes* — အခမဲ့ gift ကုဒ် (ဝယ်သူဆီ ဝေ)\n\n` +
    `🎁 Reward Items: *${itemCount}*\n` +
    `🎟 Redeem Codes: *${codeCount}*\n\n` +
    `စီမံမယ့် အကန့် ရွေးပါ:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🎁 Reward Items', 'rwadm_list_items')],
        [Markup.button.callback('🎟 Redeem Codes', 'rwadm_list_codes')],
        [Markup.button.callback('🔙 Back to Admin Panel', 'nav:go:admin_main')],
      ]),
    }
  );
}

// ── Reward items list (button-driven) ──────────────────────────────────────
async function sendItemsList(ctx) {
  const items = await RewardItem.find().sort({ sortOrder: 1, createdAt: -1 }).populate('productId').lean();
  if (!items.length) {
    return ctx.reply('🎁 *Coin Rewards*\n\nဆု တစ်ခုမှ မရှိသေးပါ။', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('➕ Add Reward', 'rwadm_add_item')],
        [Markup.button.callback('🔙 Back', 'rwadm_panel')],
      ]),
    });
  }
  const rows = [];
  const lines = items.map((it) => {
    const st = it.status === 'active' ? '🟢' : (it.status === 'hidden' ? '⚪️' : '🔴');
    const stock = it.stockCount === -1 ? '∞' : it.stockCount;
    rows.push([
      Markup.button.callback(`${st} ${it.name}`.slice(0, 32), 'noop'),
      Markup.button.callback(it.status === 'active' ? '⚪️ Hide' : '🟢 Show', `rwadm_item_toggle:${it._id}`),
      Markup.button.callback('🗑', `rwadm_item_delask:${it._id}`),
    ]);
    return `${st} *${esc(it.name)}* — ${it.coinPrice.toLocaleString()} MC → ${itemGrant(it)}\n   ↳ redeemed ${it.redeemCount} · stock ${stock} · \`${it._id}\``;
  });
  rows.push([Markup.button.callback('➕ Add Reward', 'rwadm_add_item')]);
  rows.push([Markup.button.callback('🔙 Back', 'rwadm_panel')]);
  await ctx.reply(`🎁 *Coin Rewards (${items.length})*\n\n${lines.join('\n\n')}`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(rows),
  });
}

// ── Redeem codes list (button-driven) ──────────────────────────────────────
async function sendCodesList(ctx) {
  const codes = await RedeemCode.find().sort({ createdAt: -1 }).populate('productId').lean();
  if (!codes.length) {
    return ctx.reply('🎟 *Redeem Codes*\n\nကုဒ် တစ်ခုမှ မရှိသေးပါ။', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('➕ Add Code', 'rwadm_add_code')],
        [Markup.button.callback('🔙 Back', 'rwadm_panel')],
      ]),
    });
  }
  const rows = [];
  const lines = codes.map((c) => {
    const st = c.isActive ? '🟢' : '🔴';
    const uses = c.maxUses === null ? `${c.currentUses}/∞` : `${c.currentUses}/${c.maxUses}`;
    rows.push([
      Markup.button.callback(`${st} ${c.code}`.slice(0, 32), 'noop'),
      Markup.button.callback(c.isActive ? '🔴 Off' : '🟢 On', `rwadm_code_toggle:${c._id}`),
      Markup.button.callback('🗑', `rwadm_code_delask:${c._id}`),
    ]);
    return `${st} \`${c.code}\` → ${codeGrant(c)} · uses ${uses}\n   ↳ \`${c._id}\``;
  });
  rows.push([Markup.button.callback('➕ Add Code', 'rwadm_add_code')]);
  rows.push([Markup.button.callback('🔙 Back', 'rwadm_panel')]);
  await ctx.reply(`🎟 *Redeem Codes (${codes.length})*\n\n${lines.join('\n\n')}`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(rows),
  });
}

module.exports = function registerAdminRewards(bot) {

  // ════════════════════════ REWARDS PANEL (button-driven) ════════════════════════

  bot.hears('🎁 Rewards', adminOnly(), async (ctx) => {
    await sendRewardsPanel(ctx);
  });

  bot.command('rewards_admin', adminOnly(), async (ctx) => {
    await sendRewardsPanel(ctx);
  });

  bot.action('rwadm_panel', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await sendRewardsPanel(ctx);
  });

  bot.action('rwadm_list_items', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await sendItemsList(ctx);
  });

  bot.action('rwadm_list_codes', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    await sendCodesList(ctx);
  });

  bot.action('noop', adminOnly(), async (ctx) => { await ctx.answerCbQuery(); });

  // ── Reward item: toggle / delete ───────────────────────────────
  bot.action(/^rwadm_item_toggle:(.+)$/, adminOnly(), async (ctx) => {
    const it = await RewardItem.findById(ctx.match[1]).catch(() => null);
    if (!it) { await ctx.answerCbQuery('Not found', { show_alert: true }); return; }
    it.status = it.status === 'active' ? 'hidden' : 'active';
    await it.save();
    await ctx.answerCbQuery(it.status === 'active' ? '🟢 Active' : '⚪️ Hidden');
    await sendItemsList(ctx);
  });

  bot.action(/^rwadm_item_delask:(.+)$/, adminOnly(), async (ctx) => {
    const it = await RewardItem.findById(ctx.match[1]).catch(() => null);
    if (!it) { await ctx.answerCbQuery('Not found', { show_alert: true }); return; }
    await ctx.answerCbQuery();
    await ctx.reply(`🗑 *${esc(it.name)}* ကို ဖျက်မှာ သေချာပါသလား?`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[
        Markup.button.callback('✅ ဖျက်မယ်', `rwadm_item_delyes:${it._id}`),
        Markup.button.callback('❌ မဖျက်ဘူး', 'rwadm_list_items'),
      ]]),
    });
  });

  bot.action(/^rwadm_item_delyes:(.+)$/, adminOnly(), async (ctx) => {
    const it = await RewardItem.findByIdAndDelete(ctx.match[1]).catch(() => null);
    await ctx.answerCbQuery(it ? '🗑 Deleted' : 'Not found');
    await sendItemsList(ctx);
  });

  // ── Redeem code: toggle / delete ───────────────────────────────
  bot.action(/^rwadm_code_toggle:(.+)$/, adminOnly(), async (ctx) => {
    const c = await RedeemCode.findById(ctx.match[1]).catch(() => null);
    if (!c) { await ctx.answerCbQuery('Not found', { show_alert: true }); return; }
    c.isActive = !c.isActive;
    await c.save();
    await ctx.answerCbQuery(c.isActive ? '🟢 On' : '🔴 Off');
    await sendCodesList(ctx);
  });

  bot.action(/^rwadm_code_delask:(.+)$/, adminOnly(), async (ctx) => {
    const c = await RedeemCode.findById(ctx.match[1]).catch(() => null);
    if (!c) { await ctx.answerCbQuery('Not found', { show_alert: true }); return; }
    await ctx.answerCbQuery();
    await ctx.reply(`🗑 \`${c.code}\` ကို ဖျက်မှာ သေချာပါသလား?`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[
        Markup.button.callback('✅ ဖျက်မယ်', `rwadm_code_delyes:${c._id}`),
        Markup.button.callback('❌ မဖျက်ဘူး', 'rwadm_list_codes'),
      ]]),
    });
  });

  bot.action(/^rwadm_code_delyes:(.+)$/, adminOnly(), async (ctx) => {
    const c = await RedeemCode.findByIdAndDelete(ctx.match[1]).catch(() => null);
    await ctx.answerCbQuery(c ? '🗑 Deleted' : 'Not found');
    await sendCodesList(ctx);
  });

  // ════════════════════════ REWARD ITEMS ════════════════════════

  bot.command('addreward', adminOnly(), async (ctx) => {
    ctx.session.adminReward = { kind: 'item', step: 'name' };
    await ctx.reply('🎁 *Create Coin Reward*\n\nStep 1: Enter the reward name:', {
      parse_mode: 'Markdown', ...Markup.forceReply(),
    });
  });

  bot.command('listrewards', adminOnly(), async (ctx) => {
    await sendItemsList(ctx);
  });

  bot.action('rwadm_add_item', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.adminReward = { kind: 'item', step: 'name' };
    await ctx.reply('🎁 Step 1: Enter the reward name:', { ...Markup.forceReply() });
  });

  bot.command('togglereward', adminOnly(), async (ctx) => {
    const id = ctx.message.text.split(/\s+/)[1];
    if (!id) return ctx.reply('Usage: /togglereward <id>');
    const it = await RewardItem.findById(id).catch(() => null);
    if (!it) return ctx.reply('❌ Reward not found.');
    it.status = it.status === 'active' ? 'hidden' : 'active';
    await it.save();
    await ctx.reply(`✅ *${it.name}* is now ${it.status === 'active' ? '🟢 active' : '⚪️ hidden'}.`, { parse_mode: 'Markdown' });
  });

  bot.command('delreward', adminOnly(), async (ctx) => {
    const id = ctx.message.text.split(/\s+/)[1];
    if (!id) return ctx.reply('Usage: /delreward <id>');
    const it = await RewardItem.findByIdAndDelete(id).catch(() => null);
    if (!it) return ctx.reply('❌ Reward not found.');
    await ctx.reply(`🗑 Deleted reward *${it.name}*.`, { parse_mode: 'Markdown' });
  });

  // ════════════════════════ REDEEM CODES ════════════════════════

  bot.command('addcode', adminOnly(), async (ctx) => {
    ctx.session.adminReward = { kind: 'code', step: 'code' };
    await ctx.reply('🎟 *Create Redeem Code*\n\nStep 1: Enter the code (or type `auto` to generate one):', {
      parse_mode: 'Markdown', ...Markup.forceReply(),
    });
  });

  bot.command('listcodes', adminOnly(), async (ctx) => {
    await sendCodesList(ctx);
  });

  bot.action('rwadm_add_code', adminOnly(), async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.adminReward = { kind: 'code', step: 'code' };
    await ctx.reply('🎟 Step 1: Enter the code (or `auto`):', { ...Markup.forceReply() });
  });

  bot.command('togglecode', adminOnly(), async (ctx) => {
    const id = ctx.message.text.split(/\s+/)[1];
    if (!id) return ctx.reply('Usage: /togglecode <id>');
    const c = await RedeemCode.findById(id).catch(() => null);
    if (!c) return ctx.reply('❌ Code not found.');
    c.isActive = !c.isActive;
    await c.save();
    await ctx.reply(`✅ \`${c.code}\` is now ${c.isActive ? '🟢 active' : '🔴 inactive'}.`, { parse_mode: 'Markdown' });
  });

  bot.command('delcode', adminOnly(), async (ctx) => {
    const id = ctx.message.text.split(/\s+/)[1];
    if (!id) return ctx.reply('Usage: /delcode <id>');
    const c = await RedeemCode.findByIdAndDelete(id).catch(() => null);
    if (!c) return ctx.reply('❌ Code not found.');
    await ctx.reply(`🗑 Deleted code \`${c.code}\`.`, { parse_mode: 'Markdown' });
  });

  // ════════════════════════ PRODUCT PICKER ════════════════════════

  bot.action(/^rwadm_prod:(.+)$/, adminOnly(), async (ctx) => {
    const state = ctx.session?.adminReward;
    if (!state || state.step !== 'product') { await ctx.answerCbQuery('Session expired'); return; }
    const product = await Product.findById(ctx.match[1]).lean();
    if (!product) { await ctx.answerCbQuery('Product not found', { show_alert: true }); return; }
    await ctx.answerCbQuery(`Selected: ${product.name}`);
    state.productId = String(product._id);
    state.productName = product.name;

    if (state.kind === 'item') {
      state.step = 'stock';
      await ctx.reply(`✅ Product: *${product.name}*\n\nMax redemptions? (number or \`unlimited\`):`, { parse_mode: 'Markdown', ...Markup.forceReply() });
    } else {
      state.step = 'maxuses';
      await ctx.reply(`✅ Product: *${product.name}*\n\nMax total uses? (number or \`unlimited\`):`, { parse_mode: 'Markdown', ...Markup.forceReply() });
    }
  });

  // ════════════════════════ WIZARD TEXT MACHINE ════════════════════════

  bot.on('text', async (ctx, next) => {
    const state = ctx.session?.adminReward;
    if (!state || ctx.from.id !== config.bot.adminId) return next();
    if (ctx.message.text.startsWith('/')) { ctx.session.adminReward = null; return next(); }

    const input = ctx.message.text.trim();
    const fr = { parse_mode: 'Markdown', ...Markup.forceReply() };

    try {
      // ── shared: reward TYPE prompt ─────────────────────────────
      const askType = async () => {
        state.step = 'type';
        await ctx.reply('What does it grant? Type `product` or `coupon`:', fr);
      };
      const askCoupon = async () => {
        state.step = 'ctype';
        await ctx.reply('Coupon discount type? Type `flat` (KS) or `pct` (%):', fr);
      };

      // ═══════════ REWARD ITEM ═══════════
      if (state.kind === 'item') {
        switch (state.step) {
          case 'name':
            state.name = input.slice(0, 80);
            state.step = 'desc';
            return ctx.reply('Step 2: Enter a short description (or `skip`):', fr);
          case 'desc':
            state.description = input.toLowerCase() === 'skip' ? '' : input.slice(0, 200);
            state.step = 'coinprice';
            return ctx.reply('Step 3: Coin price (MC)?', fr);
          case 'coinprice': {
            const p = num(input, { min: 0 });
            if (p === null) return ctx.reply('❌ Enter a valid number (0 or more):');
            state.coinPrice = p;
            return askType();
          }
          case 'type': {
            const t = input.toLowerCase();
            if (t === 'product') { state.rewardType = 'product'; state.step = 'product'; return sendProductPicker(ctx, 'rwadm_prod'); }
            if (t === 'coupon') { state.rewardType = 'coupon'; return askCoupon(); }
            return ctx.reply('Type `product` or `coupon`:');
          }
          case 'product':
            return ctx.reply('👆 Please tap a product from the list above.');
          case 'ctype': {
            const t = input.toLowerCase();
            if (!['flat', 'pct', 'percentage'].includes(t)) return ctx.reply('Type `flat` or `pct`:');
            state.couponDiscountType = t === 'flat' ? 'Flat' : 'Percentage';
            state.step = 'cvalue';
            return ctx.reply(state.couponDiscountType === 'Flat' ? 'Discount amount in KS?' : 'Discount percentage?', fr);
          }
          case 'cvalue': {
            const v = num(input, { min: 1 });
            if (v === null) return ctx.reply('❌ Enter a positive number:');
            state.couponValue = v;
            state.step = 'cminorder';
            return ctx.reply('Minimum order amount (KS)? (0 for none):', fr);
          }
          case 'cminorder': {
            const v = num(input, { min: 0 });
            if (v === null) return ctx.reply('❌ Enter a number (0 or more):');
            state.couponMinOrder = v;
            state.step = 'cexpiry';
            return ctx.reply('Coupon valid for how many days? (number or `never`):', fr);
          }
          case 'cexpiry': {
            state.couponExpiryDays = input.toLowerCase() === 'never' ? null : num(input, { min: 1 });
            if (input.toLowerCase() !== 'never' && state.couponExpiryDays === null) return ctx.reply('❌ Enter days or `never`:');
            state.step = 'stock';
            return ctx.reply('Max redemptions? (number or `unlimited`):', fr);
          }
          case 'stock': {
            state.stockCount = num(input, { allowUnlimited: true, unlimitedVal: -1, min: 1 });
            if (state.stockCount === null) return ctx.reply('❌ Enter a number or `unlimited`:');
            state.step = 'peruser';
            return ctx.reply('Per-user limit? (number or `unlimited`):', fr);
          }
          case 'peruser': {
            state.perUserLimit = num(input, { allowUnlimited: true, unlimitedVal: 0, min: 1 });
            if (state.perUserLimit === null) return ctx.reply('❌ Enter a number or `unlimited`:');
            return finishItem(ctx, state);
          }
        }
      }

      // ═══════════ REDEEM CODE ═══════════
      if (state.kind === 'code') {
        switch (state.step) {
          case 'code': {
            let code = input.toLowerCase() === 'auto' ? genCode() : input.toUpperCase();
            if (!/^[A-Z0-9_]{3,24}$/.test(code)) return ctx.reply('❌ Code must be 3–24 letters/numbers. Try again:');
            const exists = await RedeemCode.findOne({ code });
            if (exists) return ctx.reply('❌ That code already exists. Enter another:');
            state.code = code;
            state.step = 'desc';
            return ctx.reply(`Code: \`${code}\`\n\nStep 2: Description (or \`skip\`):`, fr);
          }
          case 'desc':
            state.description = input.toLowerCase() === 'skip' ? '' : input.slice(0, 200);
            return askType();
          case 'type': {
            const t = input.toLowerCase();
            if (t === 'product') { state.rewardType = 'product'; state.step = 'product'; return sendProductPicker(ctx, 'rwadm_prod'); }
            if (t === 'coupon') { state.rewardType = 'coupon'; return askCoupon(); }
            return ctx.reply('Type `product` or `coupon`:');
          }
          case 'product':
            return ctx.reply('👆 Please tap a product from the list above.');
          case 'ctype': {
            const t = input.toLowerCase();
            if (!['flat', 'pct', 'percentage'].includes(t)) return ctx.reply('Type `flat` or `pct`:');
            state.couponDiscountType = t === 'flat' ? 'Flat' : 'Percentage';
            state.step = 'cvalue';
            return ctx.reply(state.couponDiscountType === 'Flat' ? 'Discount amount in KS?' : 'Discount percentage?', fr);
          }
          case 'cvalue': {
            const v = num(input, { min: 1 });
            if (v === null) return ctx.reply('❌ Enter a positive number:');
            state.couponValue = v;
            state.step = 'cminorder';
            return ctx.reply('Minimum order amount (KS)? (0 for none):', fr);
          }
          case 'cminorder': {
            const v = num(input, { min: 0 });
            if (v === null) return ctx.reply('❌ Enter a number (0 or more):');
            state.couponMinOrder = v;
            state.step = 'cexpiry';
            return ctx.reply('Coupon valid for how many days? (number or `never`):', fr);
          }
          case 'cexpiry': {
            state.couponExpiryDays = input.toLowerCase() === 'never' ? null : num(input, { min: 1 });
            if (input.toLowerCase() !== 'never' && state.couponExpiryDays === null) return ctx.reply('❌ Enter days or `never`:');
            state.step = 'maxuses';
            return ctx.reply('Max total uses? (number or `unlimited`):', fr);
          }
          case 'maxuses': {
            state.maxUses = num(input, { allowUnlimited: true, unlimitedVal: null, min: 1 });
            if (input.toLowerCase() !== 'unlimited' && state.maxUses === null) return ctx.reply('❌ Enter a number or `unlimited`:');
            state.step = 'peruser';
            return ctx.reply('Per-user limit? (usually 1):', fr);
          }
          case 'peruser': {
            const v = num(input, { min: 1 });
            if (v === null) return ctx.reply('❌ Enter a number (1 or more):');
            state.perUserLimit = v;
            return finishCode(ctx, state);
          }
        }
      }
    } catch (err) {
      ctx.session.adminReward = null;
      return ctx.reply(`❌ ${err.message}`);
    }
  });

  // ── Finalizers ─────────────────────────────────────────────────
  async function finishItem(ctx, state) {
    ctx.session.adminReward = null;
    const doc = await RewardItem.create({
      name: state.name,
      description: state.description || '',
      coinPrice: state.coinPrice,
      rewardType: state.rewardType,
      productId: state.rewardType === 'product' ? state.productId : null,
      couponDiscountType: state.rewardType === 'coupon' ? state.couponDiscountType : null,
      couponValue: state.rewardType === 'coupon' ? state.couponValue : null,
      couponMinOrder: state.rewardType === 'coupon' ? state.couponMinOrder : 0,
      couponExpiryDays: state.rewardType === 'coupon' ? state.couponExpiryDays : null,
      stockCount: state.stockCount,
      perUserLimit: state.perUserLimit,
      status: 'active',
      createdBy: ctx.from.id,
    });
    const grant = doc.rewardType === 'coupon'
      ? `🎟 ${doc.couponDiscountType === 'Flat' ? price(doc.couponValue) + ' off' : doc.couponValue + '% off'}`
      : `📦 ${state.productName}`;
    await ctx.reply(
      `✅ *Coin Reward Created!*\n\n` +
      `🎁 *${doc.name}*\n` +
      `🪙 Cost: ${doc.coinPrice.toLocaleString()} MC\n` +
      `🎯 Grants: ${grant}\n` +
      `📉 Stock: ${doc.stockCount === -1 ? '∞' : doc.stockCount}\n` +
      `👤 Per-user: ${doc.perUserLimit === 0 ? '∞' : doc.perUserLimit}`,
      { parse_mode: 'Markdown' }
    );
  }

  async function finishCode(ctx, state) {
    ctx.session.adminReward = null;
    const doc = await RedeemCode.create({
      code: state.code,
      description: state.description || '',
      rewardType: state.rewardType,
      productId: state.rewardType === 'product' ? state.productId : null,
      couponDiscountType: state.rewardType === 'coupon' ? state.couponDiscountType : null,
      couponValue: state.rewardType === 'coupon' ? state.couponValue : null,
      couponMinOrder: state.rewardType === 'coupon' ? state.couponMinOrder : 0,
      couponExpiryDays: state.rewardType === 'coupon' ? state.couponExpiryDays : null,
      maxUses: state.maxUses,
      perUserLimit: state.perUserLimit,
      isActive: true,
      createdBy: ctx.from.id,
    });
    const grant = doc.rewardType === 'coupon'
      ? `🎟 ${doc.couponDiscountType === 'Flat' ? price(doc.couponValue) + ' off' : doc.couponValue + '% off'}`
      : `📦 ${state.productName}`;
    await ctx.reply(
      `✅ *Redeem Code Created!*\n\n` +
      `🎟 Code: \`${doc.code}\`\n` +
      `🎯 Grants: ${grant}\n` +
      `🔢 Max uses: ${doc.maxUses === null ? '∞' : doc.maxUses}\n` +
      `👤 Per-user: ${doc.perUserLimit}\n\n` +
      `_Share this code with your customers._`,
      { parse_mode: 'Markdown' }
    );
  }
};
