const { Markup } = require('telegraf');
const { t } = require('./i18n');

function mainMenuKeyboard(ctxOrLang, webAppConfig = null) {
  const L = (k) => t(ctxOrLang, k);
  const rows = [];
  if (webAppConfig?.enabled && webAppConfig?.url) {
    rows.push([{ text: webAppConfig.text || '🛍️ Mental Gaming Store', web_app: { url: webAppConfig.url } }]);
  }
  rows.push(
    [L('menu.shop'),     L('menu.profile')],
    [L('menu.wallet'),   L('menu.orders')],
    [L('menu.checkin'),  L('menu.spin')],
    [L('menu.rewards'),  L('menu.promo')],
    [L('menu.referral'), L('menu.gameids')],
    [L('menu.faq'),      L('menu.support')],
    [L('menu.settings')],
  );
  return Markup.keyboard(rows).resize();
}

function adminMenuKeyboard() {
  return Markup.keyboard([
    ['📊 Dashboard',       '📦 Manage Orders'],
    ['🛍️ Manage Products', '👥 Manage Users'],
    ['💱 Manage Rates',    '📢 Broadcast'],
    ['🎟 Promotions',      '🎫 Support Tickets'],
    ['📈 Analytics',       '🤖 AI Insights'],
    ['🔧 System',          '📋 Audit Logs'],
    ['🪙 Coins & Tiers',   '🎁 Rewards'],
    ['📖 Admin Guide',     '🔙 Back to Main'],
  ]).resize();
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
  confirmKeyboard,
  paginationKeyboard,
  rateActionKeyboard,
  userActionKeyboard,
};
