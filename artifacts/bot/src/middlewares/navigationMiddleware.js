/**
 * Navigation Middleware
 *
 * Intercepts global nav:* callback actions so any registered folder
 * can use back buttons without wiring them into every command.
 *
 * Handled actions:
 *   nav:back        → go back one level in history
 *   nav:go:<id>     → navigate to folder <id>
 *   nav:home        → clear history and go to main
 *   theme_set:<key> → set user theme preference
 *   lang_set:<key>  → set user language preference
 */

const Nav = require('../services/NavigationService');
const { setUserTheme, buildSettingsKeyboard, getTheme } = require('../services/ThemeService');
const User = require('../models/User');

function navigationMiddleware(bot) {
  bot.action('nav:back', async (ctx) => {
    await ctx.answerCbQuery();
    await Nav.back(ctx);
  });

  bot.action('nav:home', async (ctx) => {
    await ctx.answerCbQuery();
    Nav.clearHistory(ctx);
    await Nav.navigate(ctx, 'main', true);
  });

  bot.action(/^nav:go:(.+)$/, async (ctx) => {
    const folderId = ctx.match[1];
    await ctx.answerCbQuery();
    await Nav.navigate(ctx, folderId, true);
  });

  // ── Theme setter ───────────────────────────────────────────────────────────
  bot.action(/^theme_set:(.+)$/, async (ctx) => {
    const themeName = ctx.match[1];
    await ctx.answerCbQuery(`Theme: ${themeName}`);

    try {
      await setUserTheme(ctx.from.id, themeName);
      if (ctx.user) ctx.user.theme = themeName;

      const theme = getTheme(ctx.user);
      const currentLang = ctx.user?.language || 'en';
      await ctx.editMessageText(
        `${theme.format.header('Settings Updated')}\n${theme.emoji.settings} Theme: ${theme.format.bold(themeName === 'auto' ? 'Auto (Myanmar Time)' : themeName)}\n🌐 Language: ${currentLang === 'mm' ? '🇲🇲 Myanmar' : '🇬🇧 English'}\n\n_Changes apply immediately._`,
        {
          parse_mode: 'Markdown',
          ...buildSettingsKeyboard(themeName, currentLang),
        }
      );
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  // ── Language setter ────────────────────────────────────────────────────────
  bot.action(/^lang_set:(.+)$/, async (ctx) => {
    const lang = ctx.match[1] === 'mm' ? 'mm' : 'en';
    const langLabel = lang === 'mm' ? '🇲🇲 မြန်မာ' : '🇬🇧 English';
    await ctx.answerCbQuery(`Language: ${langLabel}`);

    try {
      await User.findOneAndUpdate({ telegramId: ctx.from.id }, { language: lang });
      if (ctx.user) ctx.user.language = lang;

      const theme = getTheme(ctx.user);
      const currentTheme = ctx.user?.theme || 'auto';
      const { t } = require('../utils/i18n');
      const { mainMenuKeyboard } = require('../utils/keyboard');

      const themeLabel = currentTheme === 'auto'
        ? (lang === 'mm' ? 'အလိုလျောက် (မြန်မာအချိန်)' : 'Auto (Myanmar Time)')
        : currentTheme;

      // 1) Edit the settings card in-place
      await ctx.editMessageText(
        `${theme.format.header(t(ctx, 'settings.updated'))}\n` +
        `${theme.emoji.settings} ${t(ctx, 'settings.theme')}: ${theme.format.bold(themeLabel)}\n` +
        `🌐 ${t(ctx, 'settings.language')}: ${langLabel}\n\n` +
        `_${t(ctx, 'settings.applies')}_`,
        { parse_mode: 'Markdown', ...buildSettingsKeyboard(currentTheme, lang) }
      ).catch(() => {});

      // 2) Send a NEW message with the freshly-localized reply keyboard so
      //    the persistent buttons at the bottom actually update for the user.
      await ctx.reply(
        `🌐 ${t(ctx, 'settings.menu_updated')}`,
        mainMenuKeyboard(ctx)
      );
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });
}

module.exports = { navigationMiddleware };
