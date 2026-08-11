const { Markup } = require('telegraf');
const { t } = require('./i18n');

function mainMenuKeyboard(ctxOrLang, webAppConfig = null, outlineBotUsername = null) {
  const L = (k) => t(ctxOrLang, k);
  const rows = [];
  if (webAppConfig?.enabled && webAppConfig?.url) {
    rows.push([{ text: webAppConfig.text || '🛍️ Mental Gaming Store', web_app: { url: webAppConfig.url } }]);
  }
  rows.push(
    [L('menu.profile'),  L('menu.store')],
    [L('menu.rewards'),  L('menu.wallet')],
    [L('menu.orders'),   L('menu.referral')],
    [L('menu.promo'),    L('menu.help')],
  );
  // Show Outline VPN as a standalone shortcut only when the VPN bot is configured.
  // It is always accessible via 🛍 Store → Outline VPN regardless.
  if (outlineBotUsername) {
    rows.push([L('menu.settings'), L('menu.outline_vpn')]);
  } else {
    rows.push([L('menu.settings')]);
  }
  return Markup.keyboard(rows).resize();
}

function adminMenuKeyboard() {
  return Markup.keyboard([
    ['📊 Dashboard', '📦 Orders'],
    ['🛍 Store', '👥 Users'],
    ['💰 Finance', '📣 Marketing'],
    ['🎁 Rewards', '⚙️ System'],
    ['📖 Admin Guide'],
    ['🔙 Back to Main'],
  ]).resize();
}

function adminSectionKeyboard(section) {
  const sections = {
    orders: [
      ['📦 Manage Orders', '🎫 Support Tickets'],
    ],
    store: [
      ['🛍️ Manage Products', '🔐 Accounts'],
      ['🎮 Game News', '🔑 Outline VPN'],
    ],
    users: [
      ['👥 Manage Users', '🪙 Coins & Tiers'],
    ],
    finance: [
      ['💱 Manage Rates', '💳 Payment Gateways'],
      ['📈 Analytics'],
    ],
    marketing: [
      ['📢 Broadcast', '📣 Announce'],
      ['🎟 Promotions', '🎟 Coupons'],
      ['🎯 Ref Campaign', '📣 Join Bonus Admin'],
      ['🎁 Giveaway', '📡 Channels'],
    ],
    rewards: [
      ['🎁 Rewards Admin', '🎁 Promo Perks'],
    ],
    system: [
      ['🔧 System', '👮 Admin Roles'],
      ['📋 Audit Logs', '📜 Global History'],
      ['🤖 AI Insights'],
    ],
  };
  return Markup.keyboard([...(sections[section] || []), ['🔙 Admin Menu']]).resize();
}

function confirmKeyboard(confirmText = '✅ Confirm', cancelText = '❌ Cancel') {
  return Markup.inlineKeyboard([
    Markup.button.callback(confirmText, 'confirm'),
    Markup.button.callback(cancelText, 'cancel'),
  ]);
}

function paginationKeyboard(currentPage, totalPages, prefix) {
  const buttons = [];
  if (currentPage > 1) buttons.push(Markup.button.callback('◀️ Prev', `${prefix}_prev_${currentPage}`));
  buttons.push(Markup.button.callback(`${currentPage}/${totalPages}`, 'noop'));
  if (currentPage < totalPages) buttons.push(Markup.button.callback('Next ▶️', `${prefix}_next_${currentPage}`));
  return Markup.inlineKeyboard([buttons]);
}

function rateActionKeyboard(currency, affectedCount) {
  const rows = [];
  if (affectedCount > 0) {
    rows.push([Markup.button.callback(`✅ Approve All (${affectedCount} items)`, `rm_approve_all:${currency}`)]);
    rows.push([Markup.button.callback('🔍 Manual Edit', `rm_manual_edit:${currency}:0`)]);
  }
  rows.push([Markup.button.callback('❌ Cancel', 'rm_cancel')]);
  return Markup.inlineKeyboard(rows);
}

function userActionKeyboard(telegramId, isBlocked) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('⚠️ Warn',  `um_warn:${telegramId}`),
      Markup.button.callback('✅ Unwarn', `um_unwarn:${telegramId}`),
    ],
    [
      Markup.button.callback(isBlocked ? '✅ Unban' : '🚫 Ban', isBlocked ? `um_unban:${telegramId}` : `um_ban:${telegramId}`),
    ],
    [
      Markup.button.callback('🔒 Restrict Order', `um_restrict:${telegramId}:order`),
      Markup.button.callback('🔓 Remove All',      `um_unrestrict:${telegramId}:all`),
    ],
    [
      Markup.button.callback('💳 Adjust Balance', `um_adjust:${telegramId}`),
    ],
  ]);
}

module.exports = {
  mainMenuKeyboard,
  adminMenuKeyboard,
  adminSectionKeyboard,
  confirmKeyboard,
  paginationKeyboard,
  rateActionKeyboard,
  userActionKeyboard,
};
