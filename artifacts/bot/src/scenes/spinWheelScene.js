/**
 * SpinWheelScene
 *
 * Animated text-based spin wheel with weighted prize selection.
 *
 * Step 0 → Show balance, spin cost, prize pool → [🎰 Free Spin] or [🪙 Paid Spin] or [❌]
 * Action confirm → Animate wheel frames → Reveal prize → Credit reward
 */

const { Scenes, Markup } = require('telegraf');
const { spin, canFreeSpinToday, nextFreeSpinIn, getEffectivePrizePool, getSpinCost, WHEEL_FRAMES } = require('../services/GameService');
const { formatCountdown } = require('../services/FlashSaleService');
const { price } = require('../utils/ui');
const { auditLog } = require('../services/logger');
const User = require('../models/User');

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function animateWheel(ctx, msgRef, frameCount = 9) {
  for (let i = 0; i < frameCount; i++) {
    const frame = WHEEL_FRAMES[i % WHEEL_FRAMES.length];
    const delay = 150 + i * 60;
    await sleep(delay);
    await ctx.telegram.editMessageText(
      msgRef.chatId,
      msgRef.messageId,
      undefined,
      `🎰 *Spinning...*\n\n${frame}`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  }
}

const spinWheelScene = new Scenes.WizardScene(
  'spin_wheel_scene',

  // ── Step 0: Show wheel info ────────────────────────────────────────────────
  async (ctx) => {
    const user = await User.findByTelegramId(ctx.from.id);
    if (!user) return ctx.scene.leave();

    const freeSpin = canFreeSpinToday(user);
    const msToNext = freeSpin ? 0 : nextFreeSpinIn(user);
    const spinCost = await getSpinCost();
    const hasPaidCoins = user.balanceCoin >= spinCost;

    const pool = await getEffectivePrizePool();
    const prizeLines = pool.map((p) => `${p.label}`);

    const statusLine = freeSpin
      ? `✅ Free spin available!`
      : `⏳ Next free spin in: *${formatCountdown(msToNext)}*`;

    const text =
      `🎰 *Spin Wheel*\n\n` +
      `💰 Balance: *${price(user.balanceKS)} KS*\n` +
      `🪙 Coins: *${user.balanceCoin.toLocaleString()} MC*\n` +
      `${statusLine}\n\n` +
      `*Prize Pool:*\n` +
      prizeLines.join('\n') +
      `\n\n_Paid spin costs ${spinCost} Mental Coins._`;

    const buttons = [];

    if (freeSpin) {
      buttons.push([Markup.button.callback('🎰 Free Spin!', 'spin_free')]);
    } else {
      buttons.push([Markup.button.callback(`🪙 Paid Spin (${spinCost} MC)`, 'spin_paid')]);
    }

    if (!freeSpin && hasPaidCoins) {
      // already shown above
    } else if (!freeSpin && !hasPaidCoins) {
      buttons.push([Markup.button.callback(`❌ Not Enough Coins (Need ${spinCost})`, 'noop')]);
    }

    buttons.push([Markup.button.callback('❌ Cancel', 'spin_cancel')]);

    await ctx.reply(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    return ctx.wizard.next();
  },

  async (ctx) => ctx.scene.leave()
);

// ── Shared spin executor ──────────────────────────────────────────────────────
async function executeSpin(ctx, usePaidSpin) {
  const spinCost = await getSpinCost();
  await ctx.answerCbQuery(usePaidSpin ? `Spending ${spinCost} coins...` : 'Spinning!');
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

  const msgRef = {
    chatId: ctx.chat.id,
    messageId: (await ctx.reply('🎰 *Getting ready...*', { parse_mode: 'Markdown' })).message_id,
  };

  try {
    await animateWheel(ctx, msgRef, 9);

    const { prize, user, usedFreeSpin } = await spin(ctx.from.id, { usePaidSpin });

    await auditLog(ctx.from.id, 'SPIN_WHEEL', null, 'Game', {
      prizeId: prize.id,
      prize: prize.label,
      usedFreeSpin,
    });

    const spinTypeLabel = usedFreeSpin ? '🆓 Free Spin' : `🪙 Paid Spin (${spinCost} MC)`;
    const rewardLines = [];

    if (prize.type === 'ks' || prize.type === 'coin') {
      rewardLines.push(`🪙 +${prize.value.toLocaleString()} Mental Coins added!`);
      rewardLines.push(`🪙 New Coin Balance: *${user.balanceCoin.toLocaleString()} MC*`);
    } else if (prize.type === 'spin') {
      rewardLines.push(`🎰 You got a *Free Spin!* Come back and spin again!`);
    } else {
      rewardLines.push(`_Better luck next time! Come back tomorrow for a free spin._`);
    }

    const resultText =
      `🎰 *Result!*\n\n` +
      `${spinTypeLabel}\n` +
      `🏆 Prize: *${prize.label}*\n\n` +
      rewardLines.join('\n');

    await ctx.telegram.editMessageText(msgRef.chatId, msgRef.messageId, undefined, resultText, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🎰 Spin Again', 'spin_again')],
        [Markup.button.callback('🔙 Done', 'spin_done')],
      ]),
    });
  } catch (err) {
    let errText = `❌ ${err.message}`;
    if (err.message.startsWith('daily_limit:')) {
      const ms = parseInt(err.message.split(':')[1]);
      errText = `⏳ You've used your free spin today!\n\nNext free spin in: *${formatCountdown(ms)}*\n\nOr spend ${spinCost} MC for a paid spin.`;
    } else if (err.message.startsWith('not_enough_coins:')) {
      const have = parseInt(err.message.split(':')[1]);
      errText = `🪙 Not enough coins!\n\nYou have *${have} MC*, need *${spinCost} MC*.\n\nEarn coins by topping up your wallet!`;
    }

    await ctx.telegram.editMessageText(msgRef.chatId, msgRef.messageId, undefined, errText, {
      parse_mode: 'Markdown',
    }).catch(() => {});
  }

  return ctx.scene.leave();
}

spinWheelScene.action('spin_free', (ctx) => executeSpin(ctx, false));
spinWheelScene.action('spin_paid', (ctx) => executeSpin(ctx, true));

spinWheelScene.action('spin_again', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  return ctx.scene.enter('spin_wheel_scene');
});

spinWheelScene.action('spin_done', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  return ctx.scene.leave();
});

spinWheelScene.action('spin_cancel', async (ctx) => {
  await ctx.answerCbQuery('Cancelled');
  await ctx.editMessageText('❌ Spin cancelled.');
  return ctx.scene.leave();
});

spinWheelScene.action('noop', async (ctx) => ctx.answerCbQuery());

module.exports = spinWheelScene;
