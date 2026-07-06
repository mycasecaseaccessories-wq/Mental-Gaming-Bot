const { Markup } = require('telegraf');
const Nav = require('../services/NavigationService');
const { buildMessage, price, formatDate } = require('../utils/ui');
const { getHistory, getCoinBonusRates } = require('../services/WalletService');
const { getTierConfig } = require('../services/MembershipService');
const { mainMenuKeyboard } = require('../utils/keyboard');
const { t } = require('../utils/i18n');
const User = require('../models/User');

Nav.register({
  id: 'wallet_view',
  title: '💰 Wallet',
  build: async (ctx, theme) => {
    const user = ctx.user || (ctx.from?.id ? await User.findByTelegramId(ctx.from.id) : null);
    if (!user) {
      return { text: t(ctx, 'wallet.load_failed'), keyboard: mainMenuKeyboard(ctx) };
    }

    const balanceKS   = user.balanceKS   || 0;
    const balanceCoin = user.balanceCoin  || 0;
    const tier        = user.membershipTier || 'Silver';
    const deposited   = user.totalDeposited || 0;
    const bonusRates  = await getCoinBonusRates();
    const bonusPct    = Math.round((bonusRates[tier] || 0.01) * 100 * 10) / 10;
    const tierCfg     = await getTierConfig();

    const nextTierMap  = { Silver: 'Gold', Gold: 'Platinum', Platinum: null };
    const nextTier     = nextTierMap[tier];
    const nextMin      = nextTier ? tierCfg[nextTier]?.min : null;
    const progressLine = nextTier && nextMin
      ? `📊 ${t(ctx, 'wallet.to_next_tier', { tier: nextTier })}: ${price(Math.max(0, nextMin - deposited))} ${t(ctx, 'wallet.more')}`
      : t(ctx, 'wallet.max_tier');

    const text = buildMessage(theme, [
      {
        title: t(ctx, 'wallet.title'),
        lines: [
          `${theme.emoji.money} ${t(ctx, 'wallet.ks_balance')}: ${theme.format.bold(price(balanceKS))}`,
          `${theme.emoji.coin} ${t(ctx, 'wallet.coins')}: ${theme.format.bold(balanceCoin.toLocaleString() + ' MC')}`,
          ``,
          `${theme.emoji.star} ${t(ctx, 'wallet.tier')}: ${theme.format.bold(tier)}`,
          `🎁 ${t(ctx, 'wallet.bonus_rate')}: ${theme.format.bold(`+${bonusPct}%`)} ${t(ctx, 'wallet.on_topups')}`,
          `💼 ${t(ctx, 'wallet.total_deposited')}: ${price(deposited)}`,
          progressLine,
        ],
      },
    ]);

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(t(ctx, 'wallet.btn_topup'), 'start_topup')],
      [
        Markup.button.callback(t(ctx, 'wallet.btn_history'), 'wallet_history'),
        Markup.button.callback(t(ctx, 'wallet.btn_coinhistory'), 'coin_history'),
      ],
    ]);

    return { text, keyboard };
  },
});

async function sendKsHistory(ctx) {
  const user = await User.findByTelegramId(ctx.from.id);
  if (!user) return ctx.reply(t(ctx, 'common.user_not_found'));

  const txs = await getHistory(user._id, { limit: 10, wallet: 'KS' });
  if (!txs.length) return ctx.reply(t(ctx, 'wallet.no_ks_history'));

  const typeIcon = {
    Topup: '💳', Purchase: '🛍️', Refund: '↩️',
    AdminCredit: '⬆️', AdminDebit: '⬇️', Debit: '📤',
  };
  const lines = txs.map((tx) => {
    const icon = typeIcon[tx.type] || '•';
    const sign = tx.amount > 0 ? '+' : '';
    const dot  = { Completed: '🟢', Pending: '🟡', Rejected: '🔴' }[tx.status] || '⚪';
    return `${icon} ${sign}${tx.amount.toLocaleString()} KS  ${dot}  _${formatDate(tx.timestamp)}_`;
  });

  await ctx.reply(`${t(ctx, 'wallet.ks_history_title')}\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
}

async function sendCoinHistory(ctx) {
  const user = await User.findByTelegramId(ctx.from.id);
  if (!user) return ctx.reply(t(ctx, 'common.user_not_found'));

  const txs = await getHistory(user._id, { limit: 10, wallet: 'Coin' });
  if (!txs.length) return ctx.reply(t(ctx, 'wallet.no_coin_history'));

  const lines = txs.map((tx) => {
    const sign = tx.amount > 0 ? '+' : '';
    return `🎁 ${sign}${tx.amount.toLocaleString()} MC  _${formatDate(tx.timestamp)}_`;
  });

  await ctx.reply(`${t(ctx, 'wallet.coin_history_title')}\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
}

module.exports = function registerWallet(bot) {
  bot.command('wallet', async (ctx) => { await Nav.navigate(ctx, 'wallet_view'); });

  bot.hears(['💰 Wallet', '💰 ပိုက်ဆံအိတ်'], async (ctx) => {
    await Nav.navigate(ctx, 'wallet_view');
  });

  bot.command('history',     (ctx) => sendKsHistory(ctx));
  bot.command('coinhistory', (ctx) => sendCoinHistory(ctx));

  bot.action('start_topup', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.scene.enter('topup_scene');
  });

  bot.action('wallet_history', async (ctx) => {
    await ctx.answerCbQuery();
    const user = await User.findByTelegramId(ctx.from.id);
    if (!user) return ctx.reply(t(ctx, 'common.user_not_found'));

    const txs = await getHistory(user._id, { limit: 10, wallet: 'KS' });
    if (!txs.length) return ctx.reply(t(ctx, 'wallet.no_ks_history'));

    const typeIcon = { Topup: '💳', Purchase: '🛍️', Refund: '↩️', AdminCredit: '⬆️', AdminDebit: '⬇️', Debit: '📤' };
    const lines = txs.map((tx) => {
      const icon = typeIcon[tx.type] || '•';
      const sign = tx.amount > 0 ? '+' : '';
      const dot  = { Completed: '🟢', Pending: '🟡', Rejected: '🔴' }[tx.status] || '⚪';
      return `${icon} ${sign}${tx.amount.toLocaleString()} KS  ${dot}  _${formatDate(tx.timestamp)}_`;
    });

    await ctx.reply(`${t(ctx, 'wallet.ks_history_title')}\n\n${lines.join('\n')}`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback(t(ctx, 'wallet.back_to_wallet'), 'nav:go:wallet_view')]]),
    });
  });

  bot.action('coin_history', async (ctx) => {
    await ctx.answerCbQuery();
    const user = await User.findByTelegramId(ctx.from.id);
    if (!user) return ctx.reply(t(ctx, 'common.user_not_found'));

    const txs = await getHistory(user._id, { limit: 10, wallet: 'Coin' });
    if (!txs.length) return ctx.reply(t(ctx, 'wallet.no_coin_history'));

    const lines = txs.map((tx) => {
      const sign = tx.amount > 0 ? '+' : '';
      return `🎁 ${sign}${tx.amount.toLocaleString()} MC  _${formatDate(tx.timestamp)}_`;
    });

    await ctx.reply(`${t(ctx, 'wallet.coin_history_title')}\n\n${lines.join('\n')}`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback(t(ctx, 'wallet.back_to_wallet'), 'nav:go:wallet_view')]]),
    });
  });
};
