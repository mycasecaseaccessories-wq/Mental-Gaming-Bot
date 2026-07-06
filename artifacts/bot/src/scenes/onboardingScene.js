/**
 * OnboardingScene — Interactive 3-step first-time user tour.
 *
 * Triggered from start.js when a user is newly created and has no activity.
 * Shows an animated welcome banner, 3 guided slides, then awards 100 Mental Coins.
 *
 * Flow:
 *   Enter → Welcome banner (Start Tour / Skip)
 *   → Step 1: How to Buy    (Back / Next)
 *   → Step 2: How to Top-Up (Back / Next)
 *   → Step 3: Mental Coins  (Back / 🎁 Claim Bonus)
 *   → Completion: +100 MC awarded, onboardingDone = true, main menu shown
 */

const { Scenes, Markup } = require('telegraf');
const User        = require('../models/User');
const Transaction = require('../models/Transaction');

const BONUS_COINS = 100;

// ── Slide content ─────────────────────────────────────────────────────────────

const SLIDES = {
  welcome: (name) =>
    `\`╔══════════════════════════╗\`\n` +
    `\`║  🎮  MENTAL GAMING STORE  ║\`\n` +
    `\`║    Your Gaming Universe   ║\`\n` +
    `\`╚══════════════════════════╝\`\n\n` +
    `🌟 Hey *${name}*, welcome aboard!\n\n` +
    `We are Myanmar's most reliable game credit store.\n` +
    `Instant delivery • Secure payments • 24/7 support\n\n` +
    `✨ Let's take a quick *30-second tour* to get you started!\n\n` +
    `_At the end, you'll receive a *Welcome Gift* 🎁_`,

  step1: () =>
    `\`━━━━━━━━━━━━━━━━━━━━━━━━━━━━\`\n` +
    `🛒 *Step 1 of 3 — How to Buy*\n` +
    `\`━━━━━━━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
    `Ordering game credits takes *less than 2 minutes*:\n\n` +
    `1️⃣ Tap 🛒 *Shop* in the main menu\n` +
    `2️⃣ Browse and select your game\n` +
    `3️⃣ Choose a package, tap *Order Now*\n` +
    `4️⃣ Enter your *Game ID* (we'll save it for next time)\n` +
    `5️⃣ Pay from your wallet — done! ✅\n\n` +
    `🎮 *Available Games:*\n` +
    `  📱 Mobile Legends   🔥 Free Fire\n` +
    `  🎯 PUBG Mobile       ✨ Genshin Impact\n` +
    `  🔫 Valorant          🎁 Gift Cards`,

  step2: () =>
    `\`━━━━━━━━━━━━━━━━━━━━━━━━━━━━\`\n` +
    `💳 *Step 2 of 3 — How to Top-Up*\n` +
    `\`━━━━━━━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
    `Add funds to your wallet in minutes:\n\n` +
    `1️⃣ Tap 💰 *Wallet* → then /topup\n` +
    `2️⃣ Choose a payment method below\n` +
    `3️⃣ Transfer the exact amount\n` +
    `4️⃣ Upload your *payment screenshot*\n` +
    `5️⃣ We'll confirm and credit you!\n\n` +
    `💳 *Accepted Payment Methods:*\n` +
    `  🟠 KBZ Pay   🔵 Wave Money\n` +
    `  🟣 AYA Pay   🔴 CB Pay\n\n` +
    `💡 *Tip:* Top up more to unlock higher membership tiers with exclusive discounts!`,

  step3: () =>
    `\`━━━━━━━━━━━━━━━━━━━━━━━━━━━━\`\n` +
    `🪙 *Step 3 of 3 — Mental Coins*\n` +
    `\`━━━━━━━━━━━━━━━━━━━━━━━━━━━━\`\n\n` +
    `Mental Coins (MC) are your *reward currency* — earn and spend them!\n\n` +
    `🏆 *Earn MC by:*\n` +
    `  ✅ Daily check-in (/checkin) — up to 50 MC/day\n` +
    `  🎰 Spin the wheel (/spin) — win bonus MC\n` +
    `  💬 Writing a review after an order\n` +
    `  🤝 Referring friends (/referral)\n\n` +
    `🛒 *Spend MC on:*\n` +
    `  💸 Instant discount at checkout\n` +
    `  🎁 Special reward redemptions\n\n` +
    `💎 *Membership Tiers:*\n` +
    `  🥈 Silver → 🥇 Gold (500K KS) → 💎 Platinum (2M KS)\n` +
    `  _Higher tier = bigger discounts on every order!_\n\n` +
    `🎁 *You're about to claim your Welcome Bonus:* +${BONUS_COINS} MC!`,

  completion: (name, coins) =>
    `\`╔══════════════════════════╗\`\n` +
    `\`║   🎉  WELCOME BONUS!  🎉  ║\`\n` +
    `\`╚══════════════════════════╝\`\n\n` +
    `🎊 Congrats, *${name}*! You completed the tour!\n\n` +
    `🪙 *+${coins} Mental Coins* have been added to your wallet!\n\n` +
    `\`━━━━━━━━━━━━━━━━━━━━━━━━━━━━\`\n` +
    `You're all set to start shopping. Here's what to do next:\n\n` +
    `  🛒 /shop — Browse & buy game credits\n` +
    `  💰 /topup — Add funds to your wallet\n` +
    `  🎰 /spin — Spin for bonus rewards (free daily)\n` +
    `  🗓 /checkin — Daily check-in for MC\n\n` +
    `_Happy gaming! The Mental Gaming Store team_ 🎮`,
};

// ── Keyboards ─────────────────────────────────────────────────────────────────

const KB = {
  welcome: Markup.inlineKeyboard([
    [Markup.button.callback('✨ Start Tour (30 sec)', 'ob_step1')],
    [Markup.button.callback('⏭ Skip Tour',           'ob_skip')],
  ]),
  step1: Markup.inlineKeyboard([
    [Markup.button.callback('Next ▶️', 'ob_step2')],
    [Markup.button.callback('⏭ Skip', 'ob_skip')],
  ]),
  step2: Markup.inlineKeyboard([
    [Markup.button.callback('◀️ Back', 'ob_step1'), Markup.button.callback('Next ▶️', 'ob_step3')],
    [Markup.button.callback('⏭ Skip', 'ob_skip')],
  ]),
  step3: Markup.inlineKeyboard([
    [Markup.button.callback('◀️ Back', 'ob_step2'), Markup.button.callback('🎁 Claim Bonus!', 'ob_finish')],
  ]),
};

// ── Award helper ──────────────────────────────────────────────────────────────

async function awardBonus(telegramId) {
  const user = await User.findOne({ telegramId });
  if (!user || user.onboardingBonusClaimed) return user;

  const balanceBefore = user.balanceCoin;
  const balanceAfter  = balanceBefore + BONUS_COINS;

  const updated = await User.findOneAndUpdate(
    { telegramId },
    { $inc: { balanceCoin: BONUS_COINS }, $set: { onboardingDone: true, onboardingBonusClaimed: true } },
    { new: true }
  );

  // Record transaction
  try {
    await Transaction.create({
      userId:        user._id,
      type:          'Bonus',
      wallet:        'Coin',
      amount:        BONUS_COINS,
      balanceBefore,
      balanceAfter,
      txId:          `ONBOARD_${user._id}`,
      note:          'Welcome bonus — new user onboarding tour completed',
      status:        'Confirmed',
    });
  } catch (_) {} // duplicate prevention — txId is unique

  return updated;
}

async function markSkipped(telegramId) {
  await User.updateOne({ telegramId }, { $set: { onboardingDone: true } });
}

// ── Scene ─────────────────────────────────────────────────────────────────────

const onboardingScene = new Scenes.BaseScene('onboarding');

onboardingScene.enter(async (ctx) => {
  const name = ctx.from?.first_name || 'there';
  try {
    await ctx.reply(SLIDES.welcome(name), {
      parse_mode: 'Markdown',
      ...KB.welcome,
    });
  } catch (err) {
    console.error('[Onboarding] Enter error:', err.message);
    await ctx.scene.leave();
  }
});

onboardingScene.action('ob_step1', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    await ctx.editMessageText(SLIDES.step1(), {
      parse_mode: 'Markdown',
      ...KB.step1,
    });
  } catch (err) {
    await ctx.reply(SLIDES.step1(), { parse_mode: 'Markdown', ...KB.step1 });
  }
});

onboardingScene.action('ob_step2', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    await ctx.editMessageText(SLIDES.step2(), {
      parse_mode: 'Markdown',
      ...KB.step2,
    });
  } catch (err) {
    await ctx.reply(SLIDES.step2(), { parse_mode: 'Markdown', ...KB.step2 });
  }
});

onboardingScene.action('ob_step3', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    await ctx.editMessageText(SLIDES.step3(), {
      parse_mode: 'Markdown',
      ...KB.step3,
    });
  } catch (err) {
    await ctx.reply(SLIDES.step3(), { parse_mode: 'Markdown', ...KB.step3 });
  }
});

onboardingScene.action('ob_finish', async (ctx) => {
  await ctx.answerCbQuery('🎁 Claiming your bonus…');
  const name = ctx.from?.first_name || 'there';
  try {
    const updatedUser = await awardBonus(ctx.from.id);
    const coins = updatedUser?.balanceCoin ?? BONUS_COINS;

    await ctx.editMessageText(SLIDES.completion(name, BONUS_COINS), {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🛒 Open Shop', 'onboard_goto_shop')],
        [Markup.button.callback('💰 View Wallet', 'onboard_goto_wallet')],
      ]),
    });

    // Show reply keyboard so user can navigate
    await ctx.reply(
      `🎮 *Mental Gaming Store* — Ready to go, ${name}!`,
      {
        parse_mode: 'Markdown',
        ...require('../utils/keyboard').mainMenuKeyboard(ctx),
      }
    );
  } catch (err) {
    console.error('[Onboarding] Finish error:', err.message);
  }
  await ctx.scene.leave();
});

onboardingScene.action('ob_skip', async (ctx) => {
  await ctx.answerCbQuery('Skipping tour…');
  const name = ctx.from?.first_name || 'there';
  await markSkipped(ctx.from.id);
  try {
    await ctx.editMessageText(
      `👋 No problem, *${name}*! You can always explore at your own pace.\n\n` +
      `Tap /shop to start browsing or /help for a guide.`,
      { parse_mode: 'Markdown' }
    );
  } catch (_) {}
  await ctx.reply(
    `🎮 *Mental Gaming Store* — Welcome!`,
    {
      parse_mode: 'Markdown',
      ...require('../utils/keyboard').mainMenuKeyboard(ctx),
    }
  );
  await ctx.scene.leave();
});

// Navigation shortcuts from completion screen
onboardingScene.action('onboard_goto_shop',   async (ctx) => { await ctx.answerCbQuery(); await ctx.scene.leave(); });
onboardingScene.action('onboard_goto_wallet', async (ctx) => { await ctx.answerCbQuery(); await ctx.scene.leave(); });

module.exports = onboardingScene;
