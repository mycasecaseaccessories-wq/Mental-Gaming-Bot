/**
 * ThemeService
 *
 * Manages Light / Dark / Auto themes per user.
 * Auto mode uses Myanmar Standard Time (UTC+6:30):
 *   18:00 – 06:00 MMT → Dark
 *   06:00 – 18:00 MMT → Light
 */

const User = require('../models/User');

const MMT_OFFSET_MS = (6 * 60 + 30) * 60 * 1000;

const THEMES = {
  light: {
    name: 'light',
    label: '☀️ Light Mode',
    emoji: {
      folder:   '📁',
      item:     '💎',
      back:     '🔙',
      success:  '✅',
      error:    '❌',
      loading:  '⌛',
      money:    '💰',
      order:    '📦',
      user:     '👤',
      settings: '⚙️',
      store:    '🛒',
      star:     '⭐',
      divider:  '─',
      bullet:   '•',
      chart:    '📊',
      coin:     '🪙',
      warning:  '⚠️',
      lock:     '🔒',
    },
    format: {
      header:    (t) => `✨ ${t}`,
      bold:      (t) => `*${t}*`,
      italic:    (t) => `_${t}_`,
      code:      (t) => `\`${t}\``,
      separator: () => '──────────────────',
      tag:       (t) => `[${t}]`,
    },
  },

  dark: {
    name: 'dark',
    label: '🌙 Dark Mode',
    emoji: {
      folder:   '🗂️',
      item:     '🔮',
      back:     '◀️',
      success:  '✅',
      error:    '🔴',
      loading:  '⏳',
      money:    '💴',
      order:    '🗳️',
      user:     '🌑',
      settings: '🔧',
      store:    '🏪',
      star:     '🌟',
      divider:  '▰',
      bullet:   '›',
      chart:    '📉',
      coin:     '💠',
      warning:  '🚨',
      lock:     '🔐',
    },
    format: {
      header:    (t) => `🌙 *${t}*`,
      bold:      (t) => `*${t}*`,
      italic:    (t) => `__${t}__`,
      code:      (t) => `\`${t}\``,
      separator: () => '▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰',
      tag:       (t) => `《${t}》`,
    },
  },
};

function getMyanmarHour() {
  const nowUTC = Date.now();
  const mmtDate = new Date(nowUTC + MMT_OFFSET_MS);
  return mmtDate.getUTCHours();
}

function resolveAutoTheme() {
  const hour = getMyanmarHour();
  return hour >= 18 || hour < 6 ? 'dark' : 'light';
}

function getTheme(user) {
  const pref = user?.theme || 'auto';
  const resolved = pref === 'auto' ? resolveAutoTheme() : pref;
  return THEMES[resolved] || THEMES.light;
}

function getThemeByName(name) {
  if (name === 'auto') {
    return THEMES[resolveAutoTheme()];
  }
  return THEMES[name] || THEMES.light;
}

async function setUserTheme(telegramId, themeName) {
  if (!['light', 'dark', 'auto'].includes(themeName)) {
    throw new Error('Invalid theme. Choose: light, dark, or auto');
  }
  await User.findOneAndUpdate({ telegramId }, { theme: themeName });
  return THEMES[themeName === 'auto' ? resolveAutoTheme() : themeName];
}

function buildThemeKeyboard(currentTheme) {
  const { Markup } = require('telegraf');
  const options = [
    { key: 'light', label: '☀️ Light' },
    { key: 'dark',  label: '🌙 Dark'  },
    { key: 'auto',  label: '🔄 Auto (MMT)' },
  ];
  return Markup.inlineKeyboard(
    options.map((o) =>
      Markup.button.callback(
        o.key === currentTheme ? `${o.label} ✓` : o.label,
        `theme_set:${o.key}`
      )
    )
  );
}

/**
 * Combined settings keyboard: theme row + language row + back button.
 */
function buildSettingsKeyboard(currentTheme, currentLang = 'en') {
  const { Markup } = require('telegraf');
  const themeOptions = [
    { key: 'light', label: '☀️ Light' },
    { key: 'dark',  label: '🌙 Dark'  },
    { key: 'auto',  label: '🔄 Auto (MMT)' },
  ];
  const langOptions = [
    { key: 'en', label: '🇬🇧 English' },
    { key: 'mm', label: '🇲🇲 Myanmar' },
  ];
  return Markup.inlineKeyboard([
    themeOptions.map((o) =>
      Markup.button.callback(o.key === currentTheme ? `${o.label} ✓` : o.label, `theme_set:${o.key}`)
    ),
    langOptions.map((o) =>
      Markup.button.callback(o.key === currentLang ? `${o.label} ✓` : o.label, `lang_set:${o.key}`)
    ),
    [Markup.button.callback('🔙 Main Menu', 'nav:back')],
  ]);
}

module.exports = { getTheme, getThemeByName, setUserTheme, buildThemeKeyboard, buildSettingsKeyboard, resolveAutoTheme, THEMES };
