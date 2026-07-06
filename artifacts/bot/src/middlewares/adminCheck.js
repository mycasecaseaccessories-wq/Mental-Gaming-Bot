/**
 * adminCheck — backward-compatible admin middleware wrappers.
 *
 * adminOnly()      → OWNER only (env ADMIN_ID). Used by all legacy commands.
 * requireRole(r)   → delegates to AdminService.requireRole(); allows STAFF/MANAGER/OWNER.
 * isAnyAdmin(id)   → async boolean; true if the user has any active admin role.
 */

const { config } = require('../../config/settings');
const AdminService = require('../services/AdminService');

function adminOnly() {
  return async (ctx, next) => {
    const userId = ctx.from?.id;
    if (Number(userId) !== Number(config.bot.adminId)) {
      const text = '⛔ Access denied. This command is for the bot owner only.';
      if (ctx.callbackQuery) await ctx.answerCbQuery(text, { show_alert: true });
      else await ctx.reply(text);
      return;
    }
    ctx.adminRole = 'OWNER';
    return next();
  };
}

function superAdminOnly(allowedIds = []) {
  return async (ctx, next) => {
    const userId = ctx.from?.id;
    const ids = [Number(config.bot.adminId), ...allowedIds.map(Number)];
    if (!ids.includes(Number(userId))) {
      return ctx.reply('⛔ Access denied.');
    }
    ctx.adminRole = 'OWNER';
    return next();
  };
}

/** Role-aware middleware. minRole = 'STAFF' | 'MANAGER' | 'OWNER' */
const requireRole = (minRole) => AdminService.requireRole(minRole);

/** Async helper for text interceptors — true if telegramId has any admin role. */
async function isAnyAdmin(telegramId) {
  return AdminService.isAdmin(telegramId);
}

module.exports = { adminOnly, superAdminOnly, requireRole, isAnyAdmin };
