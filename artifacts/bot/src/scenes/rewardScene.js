/**
 * RewardRedeem Scene
 *
 * Collects checkout fields (e.g. Game ID) for PRODUCT-type reward redemptions,
 * then finalizes:
 *   mode 'reward_item' → spend Mental Coins on a RewardItem product
 *   mode 'redeem_code' → claim a product granted by a RedeemCode (free)
 *
 * Coupon-type rewards never enter this scene — they are granted immediately.
 */

const { Scenes, Markup } = require('telegraf');
const { config } = require('../../config/settings');
const User = require('../models/User');
const Order = require('../models/Order');
const RewardItem = require('../models/RewardItem');
const RedeemCode = require('../models/RedeemCode');
const RewardService = require('../services/RewardService');
const OrderTrackingService = require('../services/OrderTrackingService');
const { resolveCheckoutFields } = require('../utils/checkoutFields');

const rewardScene = new Scenes.BaseScene('rewardRedeem');

// ── Ask for a single field ────────────────────────────────────────────────────
async function askField(ctx, field) {
  const req = field.required === false ? ' _(optional)_' : '';
  const hint = field.placeholder ? `\n_${field.placeholder}_` : '';
  await ctx.reply(
    `📝 *${field.label}*${req}${hint}`,
    { parse_mode: 'Markdown', ...Markup.forceReply() }
  );
}

function cancelKb() {
  return Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'reward_cancel')]]);
}

// ── Enter ──────────────────────────────────────────────────────────────────────
rewardScene.enter(async (ctx) => {
  const { mode, id } = ctx.scene.state || {};
  if (!mode || !id) {
    await ctx.reply('❌ Something went wrong. Please try again.');
    return ctx.scene.leave();
  }

  let doc, product, coinCost = 0, name;
  try {
    if (mode === 'reward_item') {
      doc = await RewardItem.findById(id).populate('productId');
      if (!doc) throw new Error('Reward not found.');
      product = doc.productId;
      coinCost = doc.coinPrice;
      name = doc.name;
    } else {
      doc = await RedeemCode.findById(id).populate('productId');
      if (!doc) throw new Error('Code not found.');
      product = doc.productId;
      coinCost = 0;
      name = doc.description || doc.code;
    }
    if (!product) throw new Error('The linked product is no longer available.');
  } catch (err) {
    await ctx.reply(`❌ ${err.message}`);
    return ctx.scene.leave();
  }

  const fields = await resolveCheckoutFields(product);

  ctx.session.rewardSession = {
    mode,
    id: String(id),
    coinCost,
    name,
    productName: product.name,
    productType: product.productType,
    fields,
    fieldIndex: 0,
    checkoutData: {},
  };

  if (!fields.length) {
    return finalize(ctx);
  }

  await ctx.reply(
    `🎁 *${name}*\n` +
    (coinCost > 0 ? `🪙 Cost: *${coinCost.toLocaleString()} MC*\n` : `🎟 Free reward\n`) +
    `\nPlease provide the delivery details below.`,
    { parse_mode: 'Markdown', ...cancelKb() }
  );
  return askField(ctx, fields[0]);
});

// ── Collect field input ─────────────────────────────────────────────────────────
rewardScene.on('text', async (ctx) => {
  const sess = ctx.session.rewardSession;
  if (!sess) return ctx.scene.leave();
  if (ctx.message.text.startsWith('/')) return; // ignore commands mid-flow

  const field = sess.fields[sess.fieldIndex];
  if (!field) return finalize(ctx);

  const val = ctx.message.text.trim();
  if (field.required !== false && !val) {
    return ctx.reply('❌ This field is required. Please enter a value:');
  }
  if (field.fieldType === 'number' && val && isNaN(Number(val))) {
    return ctx.reply('❌ Please enter a valid number:');
  }

  sess.checkoutData[field.key] = val;
  sess.fieldIndex += 1;

  if (sess.fieldIndex < sess.fields.length) {
    return askField(ctx, sess.fields[sess.fieldIndex]);
  }
  return finalize(ctx);
});

// ── Cancel ──────────────────────────────────────────────────────────────────────
rewardScene.action('reward_cancel', async (ctx) => {
  await ctx.answerCbQuery('Cancelled');
  try { await ctx.editMessageText('❌ Redemption cancelled.'); } catch {}
  ctx.session.rewardSession = null;
  return ctx.scene.leave();
});

// ── Finalize ────────────────────────────────────────────────────────────────────
async function finalize(ctx) {
  const sess = ctx.session.rewardSession;
  ctx.session.rewardSession = null;
  if (!sess) return ctx.scene.leave();

  const statusMsg = await ctx.reply('⏳ Processing your redemption...');

  try {
    const user = await User.findByTelegramId(ctx.from.id);
    if (!user) throw new Error('User not found.');

    const checkoutDataArr = (sess.fields || []).map((f) => ({
      key: f.key,
      label: f.label,
      value: String(sess.checkoutData[f.key] ?? ''),
    })).filter((d) => d.value !== '');

    let order;
    if (sess.mode === 'reward_item') {
      ({ order } = await RewardService.redeemProductItem(user, sess.id, checkoutDataArr));
    } else {
      ({ order } = await RewardService.redeemProductCode(user, sess.id, checkoutDataArr));
    }

    await ctx.telegram.editMessageText(
      statusMsg.chat.id, statusMsg.message_id, undefined,
      `✅ *Redeemed!*\n\n` +
      `🎁 *${sess.productName}*\n` +
      (sess.coinCost > 0 ? `🪙 Spent: *${sess.coinCost.toLocaleString()} MC*\n` : '') +
      `\nYour order is being processed. You'll get a delivery update shortly.`,
      { parse_mode: 'Markdown' }
    );

    // Live tracking card + admin notification
    try {
      const populated = await Order.findById(order._id).populate('productId');
      const trackMsg = await OrderTrackingService.sendOrderPlaced(
        ctx.telegram, ctx.from.id, populated, { productName: sess.productName }, statusMsg.message_id
      );
      if (trackMsg?.message_id) {
        await Order.findByIdAndUpdate(order._id, { trackingMsgId: trackMsg.message_id });
      }
    } catch (e) {
      console.error('[RewardScene] tracking failed:', e.message);
    }

    await notifyAdmin(ctx, order, sess, checkoutDataArr);
  } catch (err) {
    try {
      await ctx.telegram.editMessageText(statusMsg.chat.id, statusMsg.message_id, undefined, `❌ ${err.message}`);
    } catch {
      await ctx.reply(`❌ ${err.message}`);
    }
  }

  return ctx.scene.leave();
}

// ── Admin notification ──────────────────────────────────────────────────────────
async function notifyAdmin(ctx, order, sess, checkoutDataArr) {
  const user = ctx.from;
  const userTag = user.username ? `@${user.username}` : `ID: ${user.id}`;
  const shortId = order._id.toString().slice(-8).toUpperCase();
  const typeIcon = sess.productType === 'DigitalCode' ? '🎁 Digital Code' : '🎮 Direct Top-up';
  const sourceLabel = sess.mode === 'reward_item'
    ? `🪙 Coin Reward (${sess.coinCost.toLocaleString()} MC)`
    : `🎟 Redeem Code`;

  const deliveryLines = (checkoutDataArr || [])
    .map((d) => `\n📋 ${d.label}: \`${d.value}\``)
    .join('');

  const text =
    `🔔 *New Redemption — Action Required*\n\n` +
    `🆔 Order: \`${shortId}\`\n` +
    `👤 Customer: ${userTag} *(${user.first_name})*\n` +
    `📦 Product: *${sess.productName}*\n` +
    `🗂 Type: ${typeIcon}\n` +
    `🎁 Source: ${sourceLabel}` +
    deliveryLines +
    `\n💰 Charged: *0 KS* (reward)` +
    `\n🕐 ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Rangoon' })} MMT`;

  try {
    await ctx.telegram.sendMessage(config.bot.adminId, text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Complete Order', `admin_complete:${order._id}`)],
        [Markup.button.callback('❌ Cancel & Refund', `admin_cancel_refund:${order._id}`)],
      ]),
    });
  } catch (err) {
    console.error('[RewardScene] admin notify failed:', err.message);
  }
}

module.exports = rewardScene;
