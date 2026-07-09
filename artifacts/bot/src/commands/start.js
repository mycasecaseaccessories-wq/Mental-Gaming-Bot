/**
 * /start command — main entry point, deep-link handler, and join attribution.
 *
 * Deep-link payloads:
 *   ref_CODE       → referral join    (joinSource='referral', joinRef=code)
 *   channel_MSGID  → from channel post (joinSource='channel', joinRef=msgId)
 *   product_ID     → product share link (joinSource='share', joinRef=productId)
 *   (none)         → direct start    (joinSource='direct')
 *
 * Attribution is written ONCE on first join — never overwritten on re-visits.
 *
 * Onboarding:
 *   First-time users (no deposits, no check-ins) are sent to OnboardingScene
 *   for a 3-step tour and a 100 MC welcome bonus.
 *
 * Seasonal branding:
 *   Welcome header is decorated by StyleService based on the active seasonal theme.
 */

const { Markup }             = require('telegraf');
const { registerReferral }   = require('../services/ReferralService');
const StyleService            = require('../services/StyleService');
const SystemStatus            = require('../models/SystemStatus');
const User                    = require('../models/User');
const Product                 = require('../models/Product');
const { config }              = require('../../config/settings');
const { mainMenuKeyboard, adminMenuKeyboard } = require('../utils/keyboard');
const { price }               = require('../utils/ui');

// ── Attribution helper ────────────────────────────────────────────────────────

async function setJoinSourceOnce(telegramId, source, ref) {
  await User.updateOne(
    { telegramId, joinSource: 'unknown' },
    { $set: { joinSource: source, joinRef: ref || null } }
  );
}

// ── Visual referral notice ────────────────────────────────────────────────────

function buildInviteNotice(referrerName, welcomeKS, welcomeCoins) {
  return (
    `\n` +
    `\`┌─────────────────────────┐\`\n` +
    `\`│  🎁  REFERRAL BONUS      │\`\n` +
    `\`└─────────────────────────┘\`\n` +
    `You were invited by *${referrerName}*!\n\n` +
    `Make your *first top-up* to claim:\n` +
    `  💰 *+${welcomeKS.toLocaleString()} KS* welcome bonus\n` +
    `  🪙 *+${welcomeCoins} Mental Coins*\n\n`
  );
}

// ── Build webAppConfig from SystemStatus + env ────────────────────────────────

function resolveWebAppUrl(status) {
  // DB override takes highest priority
  if (status?.miniAppButtonUrl) return status.miniAppButtonUrl;
  // Only use env-based URL if it's a production .replit.app domain
  const domains = process.env.REPLIT_DOMAINS || '';
  const prodDomain = domains.split(',').map(d => d.trim()).find(d => d.endsWith('.replit.app'));
  if (prodDomain) return `https://${prodDomain}/`;
  const explicit = process.env.MINI_APP_URL;
  if (explicit) return explicit;
  return null;
}

function buildWebAppConfig(status) {
  const url = resolveWebAppUrl(status);
  if (!url) return null;
  return {
    enabled: status?.miniAppButtonEnabled !== false,
    url,
    text: status?.miniAppButtonText || '🛍️ Mental Gaming Store',
  };
}

// ── Module ────────────────────────────────────────────────────────────────────

module.exports = function registerStart(bot) {

  bot.start(async (ctx) => {
    const name    = ctx.from.first_name || ctx.from.username || 'there';
    const tier    = ctx.user?.membershipTier || 'Silver';
    const payload = ctx.startPayload;

    let referralNotice = '';
    let extraNote      = '';

    // ── Referral deep link: ref_CODE ────────────────────────────────────────
    if (payload?.startsWith('ref_')) {
      const refCode = payload.slice(4);
      await setJoinSourceOnce(ctx.from.id, 'referral', refCode);

      try {
        const [user, status] = await Promise.all([
          User.findByTelegramId(ctx.from.id),
          SystemStatus.get(),
        ]);

        if (user && status.referralEnabled) {
          const result = await registerReferral(user._id, refCode, ctx.telegram);
          if (result) {
            const referrerName = result.referrer.username
              ? `@${result.referrer.username}`
              : result.referrer.first_name || 'a friend';
            const welcomeKS    = status.referralWelcomeBonusKS    || 200;
            const welcomeCoins = status.referralWelcomeBonusCoins || 50;
            referralNotice = buildInviteNotice(referrerName, welcomeKS, welcomeCoins);
          }
        }
      } catch (err) {
        console.error('[Start] Referral register error:', err.message);
      }
    }

    // ── Channel deep link: channel_MSGID ────────────────────────────────────
    else if (payload?.startsWith('channel_')) {
      const msgId = payload.slice(8);
      await setJoinSourceOnce(ctx.from.id, 'channel', msgId);
      extraNote = `\n📢 _Welcome from our channel!_\n`;
    }

    // ── Product share link: product_PRODUCTID ────────────────────────────────
    else if (payload?.startsWith('product_')) {
      const productId = payload.slice(8);
      await setJoinSourceOnce(ctx.from.id, 'share', productId);

      try {
        const product = await Product.findById(productId);
        if (product) {
          const { price: finalPrice } = product.getEffectivePrice();
          extraNote =
            `\n🎮 *You were directed here for:*\n` +
            `📦 *${product.name}* — ${finalPrice.toLocaleString()} KS\n` +
            `_Tap /shop to order!_\n`;
        }
      } catch {}
    }

    // ── Free giveaway deep link: freebie ─────────────────────────────────────
    else if (payload === 'freebie') {
      await setJoinSourceOnce(ctx.from.id, 'channel', 'freebie');
      extraNote = `\n🎁 _အခမဲ့ Premium Account ရယူဖို့ /freebie ကို နှိပ်ပါ!_\n`;
    }

    // ── Direct start ─────────────────────────────────────────────────────────
    else {
      await setJoinSourceOnce(ctx.from.id, 'direct', null);
    }

    // ── Detect brand-new user for onboarding ─────────────────────────────────
    const user = ctx.user;
    const isFirstTimer = user &&
      !user.onboardingDone &&
      (user.totalCheckIns   || 0) === 0 &&
      (user.totalDeposited  || 0) === 0 &&
      (user.balanceKS       || 0) === 0;

    if (isFirstTimer) {
      const season = await StyleService.getActiveSeason();
      await ctx.reply(
        StyleService.buildFirstTimeHeader(name, season) +
        (referralNotice ? `\n${referralNotice}` : ''),
        { parse_mode: 'Markdown' }
      );
      return ctx.scene.enter('onboarding');
    }

    // ── Load SystemStatus (needed for mini app button URL) ────────────────────
    let sysStatus;
    try { sysStatus = await SystemStatus.get(); } catch (_) { sysStatus = {}; }

    // ── Build single welcome panel with PERSISTENT REPLY KEYBOARD ────────────
    const isAdmin = Number(ctx.from.id) === Number(config.bot.adminId);

    const { t: tt } = require('../utils/i18n');
    const lang = ctx.user?.language || 'en';
    let panel;
    if (isAdmin) {
      panel =
        `🔧 *Admin Panel — Mental Gaming Store*\n` +
        `👋 Welcome back, *${name}*!\n\n` +
        `_Tap a button below to manage the store._`;
    } else {
      const balanceKS   = ctx.user?.balanceKS   || 0;
      const balanceCoin = ctx.user?.balanceCoin || 0;
      const greet      = lang === 'mm' ? `👋 ကြိုဆိုပါတယ်၊ *${name}*!` : `👋 Welcome, *${name}*!`;
      const balLabel   = lang === 'mm' ? 'လက်ကျန်ငွေ' : 'Balance';
      const coinLabel  = lang === 'mm' ? 'ဒင်္ဂါးများ'  : 'Coins';
      const tierLabel  = lang === 'mm' ? 'အဆင့်'      : 'Tier';
      panel =
        `🎮 *Mental Gaming Store*\n` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `${greet}\n` +
        `💰 ${balLabel}: \`${price(balanceKS)}\`\n` +
        `💎 ${coinLabel}: \`${balanceCoin.toLocaleString()} MC\`\n` +
        `🌟 ${tierLabel}: *${tier}*\n\n` +
        `_${tt(ctx, 'welcome.tap_below')}_`;
    }

    const notice = (extraNote || '') + (referralNotice || '');
    if (notice.trim()) {
      panel += `\n${notice}`;
    }

    return ctx.reply(panel, {
      parse_mode: 'Markdown',
      ...(isAdmin ? adminMenuKeyboard() : mainMenuKeyboard(ctx, buildWebAppConfig(sysStatus))),
    });
  });
};
