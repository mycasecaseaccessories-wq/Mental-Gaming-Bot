const { Markup } = require('telegraf');
const Nav = require('../services/NavigationService');
const { buildMessage, price, formatDate } = require('../utils/ui');
const { getHistory, countHistory, getCoinBonusRates } = require('../services/WalletService');
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
        Markup.button.callback('💳 Topup History', 'topup_history'),
      ],
      [Markup.button.callback(t(ctx, 'wallet.btn_coinhistory'), 'coin_history')],
    ]);

    return { text, keyboard };
  },
});

const PER_PAGE = 10;

const KS_TYPE_ICON = {
  Topup: '💳', Purchase: '🛍️', Refund: '↩️',
  AdminCredit: '⬆️', AdminDebit: '⬇️', Debit: '📤',
};
const STATUS_DOT = { Completed: '🟢', Pending: '🟡', Rejected: '🔴' };

function buildKsLine(tx) {
  const icon = KS_TYPE_ICON[tx.type] || '•';
  const sign = tx.amount > 0 ? '+' : '';
  const dot  = STATUS_DOT[tx.status] || '⚪';
  let line = `${icon} ${sign}${tx.amount.toLocaleString()} KS  ${dot}  _${formatDate(tx.timestamp)}_`;
  if (tx.type === 'Topup' && tx.paymentMethod) line += `\n   └ ${tx.paymentMethod}`;
  if (tx.note) line += `\n   └ ${tx.note}`;
  return line;
}

/** Shared paginated KS history renderer.
 *  filterType = null → all KS, 'Topup' → topup-only
 *  pagePrefix: callback prefix for pagination buttons ('wh_page' or 'th_page') */
async function renderKsHistory(ctx, user, page, filterType) {
  const pagePrefix = filterType ? 'th_page' : 'wh_page';
  const title = filterType === 'Topup' ? '💳 Topup History' : t(ctx, 'wallet.ks_history_title');
  const skip  = page * PER_PAGE;

  const [txs, total] = await Promise.all([
    getHistory(user._id, { limit: PER_PAGE, skip, wallet: 'KS', type: filterType || undefined }),
    countHistory(user._id, { wallet: 'KS', type: filterType || undefined }),
  ]);

  if (!txs.length) {
    const msg = filterType ? '💳 Topup မှတ်တမ်း မရှိသေးပါ။' : t(ctx, 'wallet.no_ks_history');
    return ctx.reply(msg);
  }

  const totalPages = Math.ceil(total / PER_PAGE);
  const lines = txs.map(buildKsLine);
  const pageLabel = totalPages > 1 ? `  _(Page ${page + 1}/${totalPages})_` : '';
  const header = `${title}${pageLabel}\n\n`;

  const navButtons = [];
  if (page > 0)             navButtons.push(Markup.button.callback('⬅️ Prev', `${pagePrefix}:${page - 1}`));
  if (page < totalPages - 1) navButtons.push(Markup.button.callback('Next ➡️', `${pagePrefix}:${page + 1}`));

  const keyboard = Markup.inlineKeyboard([
    ...(navButtons.length ? [navButtons] : []),
    [Markup.button.callback(t(ctx, 'wallet.back_to_wallet'), 'nav:go:wallet_view')],
  ]);

  return ctx.reply(header + lines.join('\n\n'), { parse_mode: 'Markdown', ...keyboard });
}

/** Shared paginated Coin history renderer. */
async function renderCoinHistory(ctx, user, page) {
  const skip = page * PER_PAGE;
  const [txs, total] = await Promise.all([
    getHistory(user._id, { limit: PER_PAGE, skip, wallet: 'Coin' }),
    countHistory(user._id, { wallet: 'Coin' }),
  ]);

  if (!txs.length) return ctx.reply(t(ctx, 'wallet.no_coin_history'));

  const coinIcon = { Bonus: '🎁', Debit: '📤', Reward: '🏆', Cashback: '💸', Referral: '🤝' };
  const totalPages = Math.ceil(total / PER_PAGE);
  const pageLabel  = totalPages > 1 ? `  _(Page ${page + 1}/${totalPages})_` : '';
  const lines = txs.map((tx) => {
    const icon = coinIcon[tx.type] || '🎁';
    const sign = tx.amount > 0 ? '+' : '';
    let line = `${icon} ${sign}${tx.amount.toLocaleString()} MC  _${formatDate(tx.timestamp)}_`;
    if (tx.note) line += `\n   └ ${tx.note}`;
    return line;
  });

  const navButtons = [];
  if (page > 0)             navButtons.push(Markup.button.callback('⬅️ Prev', `ch_page:${page - 1}`));
  if (page < totalPages - 1) navButtons.push(Markup.button.callback('Next ➡️', `ch_page:${page + 1}`));

  const keyboard = Markup.inlineKeyboard([
    ...(navButtons.length ? [navButtons] : []),
    [Markup.button.callback(t(ctx, 'wallet.back_to_wallet'), 'nav:go:wallet_view')],
  ]);

  return ctx.reply(
    `${t(ctx, 'wallet.coin_history_title')}${pageLabel}\n\n` + lines.join('\n\n'),
    { parse_mode: 'Markdown', ...keyboard },
  );
}

async function sendKsHistory(ctx) {
  const user = await User.findByTelegramId(ctx.from.id);
  if (!user) return ctx.reply(t(ctx, 'common.user_not_found'));
  return renderKsHistory(ctx, user, 0, null);
}

async function sendCoinHistory(ctx) {
  const user = await User.findByTelegramId(ctx.from.id);
  if (!user) return ctx.reply(t(ctx, 'common.user_not_found'));
  return renderCoinHistory(ctx, user, 0);
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

  // ── KS history (all types) ───────────────────────────────────────────────────
  bot.action('wallet_history', async (ctx) => {
    await ctx.answerCbQuery();
    const user = await User.findByTelegramId(ctx.from.id);
    if (!user) return ctx.reply(t(ctx, 'common.user_not_found'));
    return renderKsHistory(ctx, user, 0, null);
  });

  bot.action(/^wh_page:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = await User.findByTelegramId(ctx.from.id);
    if (!user) return ctx.reply(t(ctx, 'common.user_not_found'));
    return renderKsHistory(ctx, user, parseInt(ctx.match[1], 10), null);
  });

  // ── Topup-only history ───────────────────────────────────────────────────────
  bot.action('topup_history', async (ctx) => {
    await ctx.answerCbQuery();
    const user = await User.findByTelegramId(ctx.from.id);
    if (!user) return ctx.reply(t(ctx, 'common.user_not_found'));
    return renderKsHistory(ctx, user, 0, 'Topup');
  });

  bot.action(/^th_page:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = await User.findByTelegramId(ctx.from.id);
    if (!user) return ctx.reply(t(ctx, 'common.user_not_found'));
    return renderKsHistory(ctx, user, parseInt(ctx.match[1], 10), 'Topup');
  });

  // ── Coin history ──────────────────────────────────────────────────────────────
  bot.action('coin_history', async (ctx) => {
    await ctx.answerCbQuery();
    const user = await User.findByTelegramId(ctx.from.id);
    if (!user) return ctx.reply(t(ctx, 'common.user_not_found'));
    return renderCoinHistory(ctx, user, 0);
  });

  bot.action(/^ch_page:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = await User.findByTelegramId(ctx.from.id);
    if (!user) return ctx.reply(t(ctx, 'common.user_not_found'));
    return renderCoinHistory(ctx, user, parseInt(ctx.match[1], 10));
  });
};
