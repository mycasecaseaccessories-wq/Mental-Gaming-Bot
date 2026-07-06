/**
 * checkRestrictions Middleware Factory
 *
 * Usage:
 *   bot.command('spin', checkRestrictions('spin'), async (ctx) => { ... });
 *   bot.command('checkin', checkRestrictions('checkin'), async (ctx) => { ... });
 *
 * Checks:
 *   1. Is user permanently banned? → block
 *   2. Has the time-based restriction expired? → auto-recover silently
 *   3. Does the restriction include this right? → block with message
 *   4. Otherwise → pass through to next()
 *
 * Admin is always exempt.
 */

const { autoRecoverIfExpired, isRestricted } = require('../services/PenaltyService');
const { config } = require('../../config/settings');
const User = require('../models/User');

function formatDate(d) {
  if (!d) return 'unknown date';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * @param {string} right - the right to check: 'spin' | 'checkin' | 'rewards' | 'all'
 * @returns Telegraf middleware
 */
function checkRestrictions(right) {
  return async (ctx, next) => {
    const telegramId = ctx.from?.id;
    if (!telegramId) return next();

    // Admin always exempt
    if (telegramId === config.bot.adminId) return next();

    const user = await User.findByTelegramId(telegramId);
    if (!user) return next();

    // Auto-recover expired restrictions
    const wasRecovered = await autoRecoverIfExpired(user);
    if (wasRecovered) {
      // Silently continue — restriction has lifted
      return next();
    }

    // Permanent ban
    if (user.isBlocked) {
      return ctx.reply(
        `🚫 *Your account has been permanently suspended.*\n\n` +
        `📝 Reason: ${user.restrictionReason || 'Policy violation'}\n\n` +
        `_Contact /support to appeal this decision._`,
        { parse_mode: 'Markdown' }
      );
    }

    // Check specific right
    if (isRestricted(user, right)) {
      const untilText = user.restrictedUntil
        ? `*${formatDate(user.restrictedUntil)}*`
        : '_(indefinitely)_';

      const rightLabel = {
        spin:    'Spin Wheel',
        checkin: 'Daily Check-In',
        rewards: 'Reward Features',
        all:     'All Features',
      }[right] || right;

      return ctx.reply(
        `🚫 *Access Denied — ${rightLabel}*\n\n` +
        `⏳ Your ${rightLabel} rights are suspended until ${untilText}\n` +
        `📝 Reason: ${user.restrictionReason || 'Policy violation'}\n\n` +
        `_Contact /support to appeal._`,
        { parse_mode: 'Markdown' }
      );
    }

    return next();
  };
}

module.exports = { checkRestrictions };
