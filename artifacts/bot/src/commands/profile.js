/**
 * Profile Command — Membership dashboard with tier progress, discount, streak
 */

const Nav = require('../services/NavigationService');
const { buildMessage, price, formatDate } = require('../utils/ui');
const { getCoinBonusRates } = require('../services/WalletService');
const { getTierProgress, getTierConfig, formatProgressBar } = require('../services/MembershipService');
const TierService = require('../services/TierService');
const { Markup } = require('telegraf');
const { mainMenuKeyboard } = require('../utils/keyboard');
const { t } = require('../utils/i18n');
const User = require('../models/User');

function tierBadge(tier) {
  const map = { Silver: '🥈 Silver', Gold: '🥇 Gold', Platinum: '💎 Platinum' };
  return map[tier] || tier;
}

// Escape legacy-Markdown control chars so a username like @john_doe (underscores
// are legal in Telegram usernames) can't open an unterminated entity and make
// Telegram reject the whole message.
function esc(s) {
  return String(s == null ? '' : s).replace(/[_*`[\]]/g, '\\$&');
}

Nav.register({
  id: 'profile_view',
  title: '👤 My Profile',
  build: async (ctx, theme) => {
    // Fallback to direct DB lookup if middleware didn't attach user
    const user = ctx.user || (ctx.from?.id ? await User.findByTelegramId(ctx.from.id) : null);
    if (!user) {
      return { text: t(ctx, 'profile.load_failed'), keyboard: mainMenuKeyboard(ctx) };
    }

    const balanceKS   = user.balanceKS   || 0;
    const balanceCoin = user.balanceCoin  || 0;
    const deposited   = user.totalDeposited || 0;
    const tier        = user.membershipTier || 'Silver';
    const tierCfg     = await getTierConfig();
    const bonusRates  = await getCoinBonusRates();
    const bonusPct    = Math.round((bonusRates[tier] || 0.01) * 100 * 10) / 10;
    const cfg         = tierCfg[tier];
    const streak      = user.checkInStreak || 0;

    const restrictionLine = user.restrictedRights?.length > 0
      ? `⛔ ${t(ctx, 'profile.restrictions')}: ${user.restrictedRights.join(', ')}`
      : null;

    const restrictionUntilLine = user.restrictedUntil && new Date() < new Date(user.restrictedUntil)
      ? `⏳ ${t(ctx, 'profile.lifted')}: ${formatDate(user.restrictedUntil)}`
      : null;

    const discountPct = cfg?.discount || 0;
    const discountLine = discountPct > 0
      ? `🏷 ${t(ctx, 'profile.discount_label')}: *${discountPct}%* ${t(ctx, 'profile.discount_off')}`
      : `🏷 ${t(ctx, 'profile.discount_label')}: ${t(ctx, 'profile.discount_none')}`;

    const dayWord = streak !== 1 ? t(ctx, 'common.days') : t(ctx, 'common.day');

    // ── Loyalty (dual) tiers — compact summary; details live behind Tier Progress ──
    let loyaltyLines = [];
    try {
      const info = await TierService.getUserTierInfo(user._id);
      if (info) {
        loyaltyLines.push(
          `${info.activeTierEmoji} ${t(ctx, 'profile.active_tier')}: ${theme.format.bold(info.activeTier)} — ${price(info.yearlySpend)}`
        );
        loyaltyLines.push(
          `${info.lifetierEmoji} ${t(ctx, 'profile.lifetime_tier')}: ${theme.format.bold(info.lifetimeTier)} — ${price(info.lifetimeSpend)}`
        );
      }
    } catch (e) {
      loyaltyLines = [];
    }

    const identityLines = [
      `${theme.emoji.user} ${user.username ? `@${esc(user.username)}` : t(ctx, 'profile.no_username')}`,
      `🆔 ${t(ctx, 'profile.id')}: ${theme.format.code(String(user.telegramId))}`,
    ];

    const balanceLines = [
      `${theme.emoji.money} ${t(ctx, 'wallet.ks_balance')}: ${theme.format.bold(price(balanceKS))}`,
      `${theme.emoji.coin} ${t(ctx, 'wallet.coins')}: ${theme.format.bold(balanceCoin.toLocaleString() + ' MC')}`,
      `💼 ${t(ctx, 'wallet.total_deposited')}: ${price(deposited)}`,
    ];

    const membershipLines = [
      `${theme.emoji.star} ${t(ctx, 'wallet.tier')}: ${theme.format.bold(tierBadge(tier))}`,
      discountLine,
      `🎁 ${t(ctx, 'wallet.bonus_rate')}: +${bonusPct}%`,
      ...loyaltyLines,
    ].filter(Boolean);

    const activityLines = [
      `🔥 ${t(ctx, 'profile.streak')}: *${streak} ${dayWord}*`,
      `📅 ${t(ctx, 'profile.total_checkins')}: *${user.totalCheckIns || 0}*`,
      user.warningsCount > 0 ? `⚠️ ${t(ctx, 'profile.warnings')}: ${user.warningsCount}/3` : null,
      restrictionLine,
      restrictionUntilLine,
      `📅 ${t(ctx, 'profile.joined')}: ${formatDate(user.joinDate)}`,
    ].filter(Boolean);

    const text = buildMessage(theme, [
      { title: t(ctx, 'profile.title'),          lines: identityLines },
      { title: t(ctx, 'profile.sec_balance'),    lines: balanceLines },
      { title: t(ctx, 'profile.sec_membership'), lines: membershipLines },
      { title: t(ctx, 'profile.sec_activity'),   lines: activityLines },
    ]);

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(t(ctx, 'wallet.btn_topup'), 'start_topup')],
      [
        Markup.button.callback(t(ctx, 'wallet.btn_history'), 'wallet_history'),
        Markup.button.callback(t(ctx, 'profile.btn_progress'), 'profile_progress'),
      ],
      [Markup.button.callback(t(ctx, 'profile.btn_settings'), 'nav:go:settings_view')],
    ]);

    return { text, keyboard };
  },
});

// ── Progress view ─────────────────────────────────────────────────────────────
async function sendProgressView(ctx) {
  const { t } = require('../utils/i18n');
  const user = await User.findByTelegramId(ctx.from.id);
  if (!user) return ctx.reply(t(ctx, 'common.start_first'));

  const progress = await getTierProgress(user.telegramId);
  if (!progress) return ctx.reply(t(ctx, 'progress.load_failed'));

  const tierCfg = await getTierConfig();
  const tier    = user.membershipTier;
  const cfg     = tierCfg[tier];

  let text;
  if (!progress.nextTier) {
    text =
      `${t(ctx, 'progress.max_title')}\n\n` +
      `${t(ctx, 'progress.max_body')}\n\n` +
      `${cfg.badge} ${t(ctx, 'progress.active_benefits')}\n` +
      `  🏷 *${cfg.discount}%* ${t(ctx, 'progress.discount_on_all')}\n` +
      `  🪙 *${Math.round((cfg.bonusRate || 0.02) * 100)}%* ${t(ctx, 'progress.coin_bonus')}\n` +
      `  💎 ${t(ctx, 'progress.platinum_badge')}`;
  } else {
    const nextCfg = tierCfg[progress.nextTier];
    const bar = `[${formatProgressBar(progress.progressPct / 100)}] ${progress.progressPct}%`;
    text =
      `${t(ctx, 'progress.title')}\n\n` +
      `${t(ctx, 'progress.current_tier')}: ${cfg.badge} *${tier}*\n` +
      `${t(ctx, 'progress.next_tier')}:    ${nextCfg.badge} *${progress.nextTier}*\n\n` +
      `\`${bar}\`\n\n` +
      `💼 ${t(ctx, 'progress.deposited')}: *${user.totalDeposited.toLocaleString()} KS*\n` +
      `🎯 ${t(ctx, 'progress.target')}: *${nextCfg.min.toLocaleString()} KS*\n\n` +
      `💡 ${progress.message}\n\n` +
      `*${progress.nextTier} ${t(ctx, 'progress.benefits')}:*\n` +
      `  🏷 *${nextCfg.discount}%* ${t(ctx, 'progress.discount_on_all')}\n` +
      `  🪙 *${Math.round((nextCfg.bonusRate || 0.015) * 100 * 10) / 10}%* ${t(ctx, 'progress.coin_bonus')}`;
  }

  const { Markup } = require('telegraf');
  await ctx.reply(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('💰 Top Up', 'start_topup')],
      [Markup.button.callback('🔙 Back',   'nav:go:profile_view')],
    ]),
  });
}

module.exports = function registerProfile(bot) {
  bot.command('profile', async (ctx) => {
    await Nav.navigate(ctx, 'profile_view');
  });

  bot.hears(['👤 My Profile', '👤 ပရိုဖိုင်'], async (ctx) => {
    await Nav.navigate(ctx, 'profile_view');
  });

  bot.command('progress', async (ctx) => {
    await sendProgressView(ctx);
  });

  bot.action('profile_progress', async (ctx) => {
    await ctx.answerCbQuery();
    await sendProgressView(ctx);
  });
};
