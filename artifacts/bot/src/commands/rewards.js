/**
 * Coin Rewards & Redeem Codes — user commands
 *
 * Menu "🎁 Coin Rewards" → hub with:
 *   🪙 Coin Rewards  → browse RewardItems, spend Mental Coins to redeem
 *   🎟 Redeem Code   → enter an app-style code to claim a reward
 *
 * Coupon rewards are granted instantly (a personal code is issued).
 * Product rewards enter the `rewardRedeem` scene to collect delivery details.
 */

const { Markup } = require('telegraf');
const User = require('../models/User');
const RewardItem = require('../models/RewardItem');
const RewardService = require('../services/RewardService');
const { price } = require('../utils/ui');

function couponSummary(doc) {
  const v = doc.couponDiscountType === 'Flat' ? `${price(doc.couponValue)} off` : `${doc.couponValue}% off`;
  const min = doc.couponMinOrder > 0 ? ` (min ${price(doc.couponMinOrder)})` : '';
  return `🎟 ${v}${min}`;
}

async function hubKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🪙 Coin Rewards', 'rw_items')],
    [Markup.button.callback('🎟 Redeem a Code', 'rw_code')],
  ]);
}

async function showHub(ctx) {
  const coins = ctx.user?.balanceCoin || 0;
  await ctx.reply(
    `🎁 *Coin Rewards*\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `🪙 Your Coins: *${coins.toLocaleString()} MC*\n\n` +
    `Spend Mental Coins on rewards, or enter a redeem code to claim a gift.`,
    { parse_mode: 'Markdown', ...(await hubKeyboard()) }
  );
}

async function showItems(ctx) {
  const items = await RewardService.listActiveRewardItems();
  const coins = ctx.user?.balanceCoin || 0;
  if (!items.length) {
    return ctx.reply('🎁 No rewards are available right now. Check back soon!');
  }
  const rows = items.map((it) => {
    const affordable = coins >= it.coinPrice ? '' : '🔴 ';
    return [Markup.button.callback(`${affordable}${it.name} — ${it.coinPrice.toLocaleString()} MC`, `rw_view:${it._id}`)];
  });
  rows.push([Markup.button.callback('🔙 Back', 'rw_hub')]);
  await ctx.reply(
    `🪙 *Coin Rewards Shop*\n🪙 Your Coins: *${coins.toLocaleString()} MC*\n\n_Tap a reward to redeem._`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
  );
}

async function showItemDetail(ctx, id) {
  const it = await RewardItem.findById(id).populate('productId');
  if (!it || it.status !== 'active') return ctx.reply('❌ This reward is no longer available.');

  const coins = ctx.user?.balanceCoin || 0;
  const rewardLine = it.rewardType === 'coupon'
    ? couponSummary(it)
    : `📦 ${it.productId?.name || 'Product'}`;
  const stockLine = it.stockCount === -1 ? '' : `\n📉 Stock: ${it.stockCount}`;
  const canAfford = coins >= it.coinPrice;

  const rows = [];
  if (canAfford && it.isRedeemable()) {
    rows.push([Markup.button.callback(`✅ Redeem for ${it.coinPrice.toLocaleString()} MC`, `rw_redeem:${it._id}`)]);
  }
  rows.push([Markup.button.callback('🔙 Back', 'rw_items')]);

  await ctx.reply(
    `🎁 *${it.name}*\n` +
    (it.description ? `_${it.description}_\n` : '') +
    `\n${rewardLine}\n` +
    `🪙 Cost: *${it.coinPrice.toLocaleString()} MC*` +
    stockLine +
    `\n🪙 Your Coins: ${coins.toLocaleString()} MC` +
    (canAfford ? '' : `\n\n⚠️ You don't have enough coins yet.`),
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
  );
}

async function deliverCoupon(ctx, promo) {
  const disc = promo.discountType === 'Flat' ? `${price(promo.value)} off` : `${promo.value}% off`;
  await ctx.reply(
    `✅ *Coupon Unlocked!*\n\n` +
    `🎟 Code: \`${promo.code}\`\n` +
    `🏷 Discount: *${disc}*` +
    (promo.minOrderAmount > 0 ? `\n📋 Min order: ${price(promo.minOrderAmount)}` : '') +
    (promo.expiryDate ? `\n📅 Expires: ${new Date(promo.expiryDate).toLocaleDateString('en-GB')}` : '') +
    `\n\n_Apply this code at checkout. It's tied to your account._`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🛒 Go to Shop', 'nav:go:shop')]]) }
  );
}

module.exports = function registerRewards(bot) {

  bot.hears(['🎁 Coin Rewards', '🎁 ကွိုင်ဆုများ'], showHub);
  bot.command('rewards', showHub);

  bot.action('rw_hub', async (ctx) => { await ctx.answerCbQuery(); return showHub(ctx); });
  bot.action('rw_items', async (ctx) => { await ctx.answerCbQuery(); return showItems(ctx); });

  bot.action(/^rw_view:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    return showItemDetail(ctx, ctx.match[1]);
  });

  // ── Redeem a coin reward item ──────────────────────────────────────────────
  bot.action(/^rw_redeem:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    const item = await RewardItem.findById(id);
    if (!item) { await ctx.answerCbQuery('Reward not found', { show_alert: true }); return; }

    if (item.rewardType === 'coupon') {
      await ctx.answerCbQuery('Redeeming...');
      try {
        const user = await User.findByTelegramId(ctx.from.id);
        const { promo } = await RewardService.redeemCouponItem(user, item);
        await deliverCoupon(ctx, promo);
      } catch (err) {
        await ctx.reply(`❌ ${err.message}`);
      }
      return;
    }

    // product reward → collect delivery fields in the scene
    await ctx.answerCbQuery();
    return ctx.scene.enter('rewardRedeem', { mode: 'reward_item', id });
  });

  // ── Redeem code entry ──────────────────────────────────────────────────────
  bot.action('rw_code', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.awaitingRedeemCode = true;
    await ctx.reply('🎟 Type your redeem code:', { ...Markup.forceReply() });
  });

  bot.command('redeem', async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    if (!args.length) {
      ctx.session.awaitingRedeemCode = true;
      return ctx.reply('🎟 Type your redeem code:', { ...Markup.forceReply() });
    }
    return handleRedeemCode(ctx, args[0]);
  });

  // Capture typed redeem code
  bot.on('text', async (ctx, next) => {
    if (!ctx.session?.awaitingRedeemCode) return next();
    if (ctx.message?.text?.startsWith('/')) return next();
    ctx.session.awaitingRedeemCode = false;
    return handleRedeemCode(ctx, ctx.message.text.trim());
  });

  async function handleRedeemCode(ctx, codeStr) {
    let user;
    try {
      user = await User.findByTelegramId(ctx.from.id);
      const check = await RewardService.checkRedeemCode(user, codeStr);
      if (!check.ok) return ctx.reply(`❌ ${check.error}`, { parse_mode: 'Markdown' });

      const code = check.code;
      if (code.rewardType === 'coupon') {
        const { promo } = await RewardService.redeemCouponCode(user, code);
        return deliverCoupon(ctx, promo);
      }
      // product → collect delivery fields
      return ctx.scene.enter('rewardRedeem', { mode: 'redeem_code', id: String(code._id) });
    } catch (err) {
      return ctx.reply(`❌ ${err.message}`);
    }
  }
};
