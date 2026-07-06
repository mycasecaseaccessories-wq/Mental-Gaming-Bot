module.exports = function registerHelp(bot) {
  bot.help(async (ctx) => {
    await ctx.reply(
      `*Mental Gaming Store — Help*\n\n` +
        `*Available Commands:*\n` +
        `/start — Main menu\n` +
        `/shop — Browse products\n` +
        `/orders — View your orders\n` +
        `/wallet — Check wallet balance\n` +
        `/profile — Your account info\n` +
        `/support — Contact support\n\n` +
        `*Need help?* Use /support to reach our team.`,
      { parse_mode: 'Markdown' }
    );
  });
};
