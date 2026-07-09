/**
 * TopupWizard Scene
 *
 * Step 0 → Anti-spam check + show active payment methods
 * Step 1 → User picks method → show payment details → ask for amount
 * Step 2 → User enters amount → validate → ask for screenshot
 * Step 3 → User uploads screenshot → create Pending Topup → notify admin → done
 */

const { Scenes, Markup } = require('telegraf');
const { config } = require('../../config/settings');
const { getTheme } = require('../services/ThemeService');
const { createPendingTopup, calcCoinBonus, COIN_BONUS_RATE } = require('../services/WalletService');
const { checklist, loadingMessage } = require('../utils/animations');
const { buildMessage, price } = require('../utils/ui');
const { auditLog } = require('../services/logger');
const { checkDuplicateScreenshot, notifyAdminFraud } = require('../utils/imageHash');
const PaymentMethod = require('../models/PaymentMethod');
const Transaction = require('../models/Transaction');
const User = require('../models/User');

const MIN_TOPUP = 1000;
const MAX_TOPUP = 5000000;

function adminTopupKeyboard(txId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Approve',        `topup_approve:${txId}`)],
    [Markup.button.callback('❌ Reject',          `topup_reject:${txId}`)],
    [Markup.button.callback('💬 Ask for Info',    `topup_askinfo:${txId}`)],
  ]);
}

const topupScene = new Scenes.WizardScene(
  'topup_scene',

  // ── Step 0: Anti-spam check + show payment methods ─────────────────────
  async (ctx) => {
    const user = await User.findByTelegramId(ctx.from.id);
    if (!user) return ctx.scene.leave();

    const alreadyPending = await Transaction.hasPendingTopup(user._id);
    if (alreadyPending) {
      await ctx.reply(
        `⏳ *You already have a pending top-up request.*\n\n` +
        `Please wait for admin to process it before submitting another.\n\n` +
        `_Use /orders to check your order status, or /support if it's taking too long._`,
        { parse_mode: 'Markdown' }
      );
      return ctx.scene.leave();
    }

    const methods = await PaymentMethod.getActive();
    if (!methods.length) {
      await ctx.reply(
        `❌ *No payment methods available right now.*\n` +
        `Please contact /support for assistance.`,
        { parse_mode: 'Markdown' }
      );
      return ctx.scene.leave();
    }

    ctx.session.topupMethods = methods.map((m) => ({
      id: m._id.toString(),
      name: m.name,
      shortCode: m.shortCode,
      accountName: m.accountName,
      accountNumber: m.accountNumber,
      emoji: m.emoji,
      instructions: m.instructions,
      qrImageUrl: m.qrImageUrl,
    }));

    const theme = getTheme(ctx.user);
    const tier = user.membershipTier;
    const bonusPct = Math.round((COIN_BONUS_RATE[tier] || 0.01) * 100 * 10) / 10;

    const text = buildMessage(theme, [
      {
        title: '💰 Wallet Top-Up',
        lines: [
          `${theme.emoji.money} Current Balance: ${theme.format.bold(price(user.balanceKS))}`,
          `${theme.emoji.coin} Mental Coins: ${theme.format.bold(user.balanceCoin.toLocaleString())}`,
          `${theme.emoji.star} Tier: ${theme.format.bold(tier)} — ${theme.format.bold(`+${bonusPct}%`)} Coin Bonus`,
          ``,
          `_Minimum top-up: ${price(MIN_TOPUP)}_`,
          ``,
          `*Select a payment method:*`,
        ],
      },
    ]);

    const methodButtons = methods.map((m) => [
      Markup.button.callback(`${m.emoji} ${m.name}`, `topup_pick:${m._id}`)
    ]);

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([...methodButtons, [Markup.button.callback('❌ Cancel', 'topup_cancel')]]),
    });

    return ctx.wizard.next();
  },

  // ── Step 1: Payment method picked (via action) → ask for amount ────────
  async (ctx) => {
    if (!ctx.session.topupSelectedMethod) {
      return ctx.reply('Please select a payment method using the buttons above.');
    }

    const method = ctx.session.topupSelectedMethod;
    const theme = getTheme(ctx.user);

    const text = buildMessage(theme, [
      {
        title: `${method.emoji} ${method.name}`,
        lines: [
          `👤 Account Name: ${theme.format.bold(method.accountName)}`,
          `📱 Account Number: ${theme.format.code(method.accountNumber)}`,
          ``,
          `📋 *Instructions:*`,
          `${method.instructions}`,
          ``,
          `💡 *How much do you want to top up?*`,
          `_Enter the amount in KS (minimum ${price(MIN_TOPUP)}):_`,
        ],
      },
    ]);

    if (method.qrImageUrl) {
      await ctx.replyWithPhoto(method.qrImageUrl, { caption: `QR Code for ${method.name}` }).catch(() => {});
    }

    await ctx.reply(text, { parse_mode: 'Markdown' });
    return ctx.wizard.next();
  },

  // ── Step 2: Receive amount → validate → ask for screenshot ─────────────
  async (ctx) => {
    if (!ctx.message?.text) return ctx.reply('Please enter the amount as a number.');

    const raw = ctx.message.text.trim().replace(/,/g, '');
    const amount = parseInt(raw, 10);

    if (isNaN(amount) || amount < MIN_TOPUP) {
      return ctx.reply(`❌ Minimum top-up is ${price(MIN_TOPUP)}. Please enter a valid amount.`);
    }

    if (amount > MAX_TOPUP) {
      return ctx.reply(`❌ Maximum top-up is ${price(MAX_TOPUP)}. Please contact support for larger amounts.`);
    }

    const user = await User.findByTelegramId(ctx.from.id);
    const bonusCoins = await calcCoinBonus(amount, user?.membershipTier || 'Silver');
    ctx.session.topupAmount = amount;
    ctx.session.topupBonusCoins = bonusCoins;

    await ctx.reply(
      `✅ Amount: *${price(amount)}*\n` +
      `🎁 You'll receive: *+${bonusCoins.toLocaleString()} Mental Coins* bonus\n\n` +
      `📸 Now please *upload your payment screenshot* as a photo to confirm:`,
      { parse_mode: 'Markdown' }
    );

    return ctx.wizard.next();
  },

  // ── Step 3: Receive screenshot → create pending topup → notify admin ────
  async (ctx) => {
    if (!ctx.message?.photo) {
      return ctx.reply('📸 Please upload your payment screenshot as a *photo*.', { parse_mode: 'Markdown' });
    }

    const photo = ctx.message.photo;
    const fileId = photo[photo.length - 1].file_id;
    const method = ctx.session.topupSelectedMethod;
    const amount = ctx.session.topupAmount;

    if (!method || !amount) {
      await ctx.reply('❌ Session expired. Please start again with /topup.');
      return ctx.scene.leave();
    }

    const ref = { chatId: ctx.chat.id, messageId: (await ctx.reply('⌛')).message_id };

    try {
      const user = await User.findByTelegramId(ctx.from.id);

      // ── Duplicate screenshot fraud check ─────────────────────────────────
      const dupCheck = await checkDuplicateScreenshot(fileId, user._id);
      if (dupCheck.isFraud) {
        await notifyAdminFraud(ctx.telegram, user, dupCheck.existingTx, dupCheck.hash);
        await ctx.telegram.editMessageText(
          ref.chatId, ref.messageId, undefined,
          `🚨 *Fraud Detected!*\n\n` +
          `This screenshot has already been used for a previous top-up request.\n\n` +
          `⛔ Your submission has been blocked and admin has been notified.\n` +
          `_If you believe this is a mistake, please contact /support._`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
        return ctx.scene.leave();
      }
      if (dupCheck.isDuplicate) {
        await ctx.telegram.editMessageText(
          ref.chatId, ref.messageId, undefined,
          `⚠️ *Duplicate Screenshot*\n\nYou have already submitted this screenshot.\nPlease upload a new payment screenshot.`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
        return;
      }

      await checklist(ctx, ref,
        [
          { label: 'Receiving screenshot',      delay: 600 },
          { label: 'Validating payment info',   delay: 700 },
          { label: 'Creating top-up request',   delay: 600 },
          { label: 'Notifying admin',           delay: 600 },
        ],
        `✅ *Top-up request submitted!*\n\n` +
        `💰 Amount: *${price(amount)}*\n` +
        `🎁 Pending Coin Bonus: *+${ctx.session.topupBonusCoins?.toLocaleString()} MC*\n` +
        `📋 Method: *${method.name}*\n\n` +
        `_Your request is under review. You'll be notified once approved._`
      );

      const { txId } = await createPendingTopup(user._id, {
        amountKS: amount,
        paymentMethod: method.shortCode,
        screenshotUrl: fileId,
        screenshotHash: dupCheck.hash,
      });

      await auditLog(ctx.from.id, 'TOPUP_REQUESTED', txId, 'Transaction', {
        amount,
        method: method.shortCode,
      });

      // Persist screenshot bytes so ANY bot instance (dev/prod) can view it later
      // (fire-and-forget — must never delay the admin notification)
      const { saveScreenshot } = require('../services/ScreenshotService');
      saveScreenshot(ctx.telegram, fileId, txId)
        .catch((e) => console.error('[TopupScene] screenshot persist failed:', e.message));

      await notifyAdminTopup(ctx, { user, amount, method, fileId, txId, bonusCoins: ctx.session.topupBonusCoins });

      ctx.session.topupSelectedMethod = null;
      ctx.session.topupAmount = null;
      ctx.session.topupBonusCoins = null;
      ctx.session.topupMethods = null;
    } catch (err) {
      await ctx.telegram.editMessageText(ref.chatId, ref.messageId, undefined, `❌ ${err.message}`);
    }

    return ctx.scene.leave();
  }
);

// ── Action: pick payment method ────────────────────────────────────────────
topupScene.action(/^topup_pick:(.+)$/, async (ctx) => {
  const methodId = ctx.match[1];
  const methods = ctx.session.topupMethods || [];
  const method = methods.find((m) => m.id === methodId);

  if (!method) return ctx.answerCbQuery('Method not found', { show_alert: true });

  ctx.session.topupSelectedMethod = method;
  await ctx.answerCbQuery(`${method.emoji} ${method.name} selected`);
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  ctx.wizard.selectStep(1);

  // Trigger step 1 manually
  const fakeCtx = ctx;
  const method2 = ctx.session.topupSelectedMethod;
  const theme = getTheme(ctx.user);
  const { buildMessage: bm, price: p } = require('../utils/ui');

  const text = bm(theme, [{
    title: `${method2.emoji} ${method2.name}`,
    lines: [
      `👤 Account Name: ${theme.format.bold(method2.accountName)}`,
      `📱 Number: ${theme.format.code(method2.accountNumber)}`,
      ``,
      `📋 ${method2.instructions}`,
      ``,
      `💡 Enter the top-up amount in KS *(min ${p(MIN_TOPUP)})*:`,
    ],
  }]);

  if (method2.qrImageUrl) {
    await ctx.replyWithPhoto(method2.qrImageUrl, { caption: `QR — ${method2.name}` }).catch(() => {});
  }

  await ctx.reply(text, { parse_mode: 'Markdown' });
  ctx.wizard.selectStep(2);
});

// ── Action: cancel ─────────────────────────────────────────────────────────
topupScene.action('topup_cancel', async (ctx) => {
  await ctx.answerCbQuery('Cancelled');
  await ctx.editMessageText('❌ Top-up cancelled.');
  ctx.session.topupSelectedMethod = null;
  ctx.session.topupAmount = null;
  return ctx.scene.leave();
});

// ── Helper: notify admin ───────────────────────────────────────────────────
async function notifyAdminTopup(ctx, { user, amount, method, fileId, txId, bonusCoins }) {
  const rawTag = user.username ? `@${user.username}` : `ID: ${user.telegramId}`;
  const userTag = rawTag.replace(/([_*`\[])/g, '\\$1');

  const caption =
    `💳 *New Top-Up Request*\n\n` +
    `🆔 TxID: \`${txId}\`\n` +
    `👤 User: ${userTag}\n` +
    `${method.emoji} Method: *${String(method.name || '').replace(/([_*`\[])/g, '\\$1')}*\n` +
    `💰 Amount: *${price(amount)}*\n` +
    `🎁 Coin Bonus on Approve: *+${bonusCoins?.toLocaleString()} MC*\n` +
    `🕐 Time: ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Rangoon' })} MMT`;

  try {
    await ctx.telegram.sendPhoto(config.bot.adminId, fileId, {
      caption,
      parse_mode: 'Markdown',
      ...adminTopupKeyboard(txId),
    });
  } catch (err) {
    console.error('[TopupScene] Failed to notify admin (Markdown):', err.message);
    // Fallback 1: same photo + plain-text caption (no Markdown parse risk)
    try {
      await ctx.telegram.sendPhoto(config.bot.adminId, fileId, {
        caption:
          `💳 New Top-Up Request\n\nTxID: ${txId}\nUser: ${rawTag}\n` +
          `Method: ${method.name}\nAmount: ${amount.toLocaleString()} KS\n` +
          `Time: ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Rangoon' })} MMT`,
        ...adminTopupKeyboard(txId),
      });
      return;
    } catch (err2) {
      console.error('[TopupScene] Failed to notify admin (plain photo):', err2.message);
    }
    // Fallback 2: text-only alert so the request is never silently lost
    try {
      await ctx.telegram.sendMessage(
        config.bot.adminId,
        `💳 New Top-Up Request (screenshot ပို့မရ — /dashboard → Pending Topups မှာ ကြည့်ပါ)\n\n` +
          `TxID: ${txId}\nUser: ${rawTag}\nMethod: ${method.name}\nAmount: ${amount.toLocaleString()} KS`,
        { ...adminTopupKeyboard(txId) }
      );
    } catch (err3) {
      console.error('[TopupScene] Failed to notify admin (text):', err3.message);
    }
  }
}

module.exports = topupScene;
