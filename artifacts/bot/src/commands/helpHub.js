/**
 * Help Hub — "💬 Help" main menu button
 *
 * Groups FAQ and Support under one hub.
 * Callbacks route to faq.js and support.js respectively.
 */

const { Markup } = require('telegraf');
const { t } = require('../utils/i18n');

module.exports = function registerHelpHub(bot) {
  bot.hears(['💬 Help', '💬 အကူအညီ'], async (ctx) => {
    await ctx.reply(
      `${t(ctx, 'help_hub.title')}
` +
      `━━━━━━━━━━━━━━━━━━━
` +
      `${t(ctx, 'help_hub.choose')}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(t(ctx, 'menu.faq'), 'help_faq')],
          [Markup.button.callback(t(ctx, 'menu.support'), 'help_support')],
        ]),
      }
    );
  });
};
