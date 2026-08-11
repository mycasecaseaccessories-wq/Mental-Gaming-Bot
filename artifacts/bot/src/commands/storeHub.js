/**
 * Store Hub — "🛍 Store" main menu button
 *
 * Groups Shop, Premium Accounts, and Outline VPN under one hub.
 * VPN is shown only when its external bot username is configured, matching
 * the main-menu shortcut behaviour.
 */

const { Markup } = require('telegraf');
const { t } = require('../utils/i18n');
const SystemStatus = require('../models/SystemStatus');
const Nav = require('../services/NavigationService');

module.exports = function registerStoreHub(bot) {
  bot.hears(['🛍 Store', '🛍 ဈေးဆိုင်'], async (ctx) => {
    Nav.clearHistory(ctx);
    let status = null;
    try {
      status = await SystemStatus.get();
    } catch (err) {
      console.error('[StoreHub] SystemStatus load failed:', err.message);
    }

    const rows = [
      [Markup.button.callback(t(ctx, 'menu.shop'), 'store_shop')],
      [Markup.button.callback(t(ctx, 'menu.accounts'), 'store_accounts')],
    ];

    if (status?.outlineBotUsername) {
      rows.push([Markup.button.callback(t(ctx, 'menu.outline_vpn'), 'store_vpn')]);
    }

    await ctx.reply(
      `${t(ctx, 'store_hub.title')}
` +
      `━━━━━━━━━━━━━━━━━━━
` +
      `${t(ctx, 'store_hub.choose')}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(rows),
      }
    );
  });
};
