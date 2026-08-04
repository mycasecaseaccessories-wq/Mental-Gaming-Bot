/**
 * Store Hub — "🛍 Store" main menu button
 *
 * Groups Shop, Premium Accounts, and Outline VPN under one hub.
 * Each inline button routes to its respective feature via a bot.action
 * registered in the owning command file (shop.js, accounts.js, outlineUser.js).
 */

const { Markup } = require('telegraf');
const { t } = require('../utils/i18n');

module.exports = function registerStoreHub(bot) {
  bot.hears(['🛍 Store', '🛍 ဈေးဆိုင်'], async (ctx) => {
    await ctx.reply(
      `🛍 *Store*\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `ဘာ ရှာနေတာလဲ?`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🛒 Shop',              'store_shop')],
          [Markup.button.callback('🔐 Premium Accounts',  'store_accounts')],
          [Markup.button.callback('🌐 Outline VPN',       'store_vpn')],
        ]),
      }
    );
  });
};
