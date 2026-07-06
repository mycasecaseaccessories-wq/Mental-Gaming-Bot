const { buildSettingsKeyboard, getTheme } = require('../services/ThemeService');
const { buildMessage } = require('../utils/ui');
const { Markup } = require('telegraf');
const Nav = require('../services/NavigationService');
const User = require('../models/User');
const { t } = require('../utils/i18n');

Nav.register({
  id: 'settings_view',
  title: '⚙️ Settings',
  build: async (ctx, theme) => {
    const currentTheme = ctx.user?.theme    || 'auto';
    const currentLang  = ctx.user?.language || 'en';

    const langLabel  = currentLang === 'mm' ? '🇲🇲 မြန်မာ' : '🇬🇧 English';
    const themeName  = currentTheme === 'auto'
      ? (currentLang === 'mm' ? 'အလိုလျောက် (မြန်မာအချိန်)' : 'Auto (Myanmar Time)')
      : currentTheme;

    const text = buildMessage(theme, [
      {
        title: t(ctx, 'settings.title'),
        lines: [
          `${theme.emoji.settings} *${t(ctx, 'settings.theme')}:* ${themeName}`,
          `_${t(ctx, 'settings.auto_hint')}_`,
          ``,
          `🌐 *${t(ctx, 'settings.language')}:* ${langLabel}`,
        ],
      },
    ]);

    return { text, keyboard: buildSettingsKeyboard(currentTheme, currentLang) };
  },
});

module.exports = function registerSettings(bot) {
  bot.command('settings', async (ctx) => {
    await Nav.navigate(ctx, 'settings_view');
  });

  // Match both English and Myanmar settings labels
  bot.hears(['⚙️ Settings', '⚙️ ဆက်တင်'], async (ctx) => {
    await Nav.navigate(ctx, 'settings_view');
  });
};
