/**
 * Help Hub — "💬 Help" main menu button
 *
 * Groups FAQ and Support under one hub.
 * Callbacks route to faq.js and support.js respectively.
 */

const { Markup } = require('telegraf');

module.exports = function registerHelpHub(bot) {
  bot.hears(['💬 Help', '💬 အကူအညီ'], async (ctx) => {
    await ctx.reply(
      `💬 *Help Center*\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `ဘယ်လို ကူညီပေးရမလဲ?`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('❓ FAQ',      'help_faq')],
          [Markup.button.callback('💬 Support',  'help_support')],
        ]),
      }
    );
  });
};
